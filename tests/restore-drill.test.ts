import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { db } from '../src/db/index.js';
import { UsersRepository } from '../src/repositories/users.js';

describe('Phase 6: Isolated Backup & Restore Drill', () => {
  let primaryDb: TestDbInstance;
  let isolatedRestoreDb: TestDbInstance;

  beforeAll(async () => {
    primaryDb = await createTestDb();
    isolatedRestoreDb = await createTestDb();
  }, 30000);

  afterAll(async () => {
    if (primaryDb) await primaryDb.close();
    if (isolatedRestoreDb) await isolatedRestoreDb.close();
  }, 30000);

  it('performs an isolated backup export and successfully restores into clean target database', async () => {
    // 1. Arrange source data in primary database
    const user1Id = '11111111-2222-3333-4444-555555555555';
    const user2Id = '66666666-7777-8888-9999-000000000000';

    await primaryDb.pool.query(`
      INSERT INTO users (id, seed_id, display_name, email, handle, bio, is_public, role, demo_points, is_test)
      VALUES 
        ('${user1Id}', 'seed_drill_1', 'Drill Primary', 'primary@test.com', 'drill_primary', 'Drill tester 1', true, 'user', 100, false),
        ('${user2Id}', 'seed_drill_2', 'Drill Secondary', 'secondary@test.com', 'drill_sec', 'Drill tester 2', false, 'user', 200, false)
      ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;
    `);

    await primaryDb.pool.query(`
      INSERT INTO user_follows (follower_id, following_id, created_at)
      VALUES ('${user1Id}', '${user2Id}', NOW())
      ON CONFLICT (follower_id, following_id) DO NOTHING;
    `);

    // 2. Export / Dump Phase: simulate logical pg_dump by extracting committed state
    const migrationsDump = await primaryDb.pool.query('SELECT filename, applied_at FROM schema_migrations ORDER BY filename ASC');
    const usersDump = await primaryDb.pool.query('SELECT * FROM users WHERE id IN ($1, $2)', [user1Id, user2Id]);
    const followsDump = await primaryDb.pool.query('SELECT * FROM user_follows WHERE follower_id = $1 AND following_id = $2', [user1Id, user2Id]);

    expect(migrationsDump.rows.length).toBeGreaterThanOrEqual(19);
    expect(usersDump.rows.length).toBe(2);
    expect(followsDump.rows.length).toBe(1);

    // 3. Restore Phase: restore into isolated target database (NEVER into live primary)
    const restoreStartTime = Date.now();

    for (const u of usersDump.rows) {
      await isolatedRestoreDb.pool.query(`
        INSERT INTO users (id, seed_id, display_name, email, handle, bio, is_public, role, demo_points, is_test)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO NOTHING;
      `, [u.id, u.seed_id, u.display_name, u.email, u.handle, u.bio, u.is_public, u.role, u.demo_points, u.is_test]);
    }

    for (const f of followsDump.rows) {
      await isolatedRestoreDb.pool.query(`
        INSERT INTO user_follows (follower_id, following_id, created_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (follower_id, following_id) DO NOTHING;
      `, [f.follower_id, f.following_id, f.created_at]);
    }

    const restoreDurationMs = Date.now() - restoreStartTime;

    // 4. Verification Phase: verify integrity on restored database
    const restoredUsersRepo = new UsersRepository(isolatedRestoreDb.pool);
    const restoredUser1 = await restoredUsersRepo.findPublicById(user1Id);
    expect(restoredUser1).toBeDefined();
    expect(restoredUser1?.display_name).toBe('Drill Primary');
    expect(restoredUser1?.handle).toBe('drill_primary');

    // Private user must be queryable directly by ID but not public find
    const directUser2 = await restoredUsersRepo.findById(user2Id);
    expect(directUser2).toBeDefined();
    expect(directUser2?.is_public).toBe(false);

    const restoredMyFollowing = await restoredUsersRepo.listMyFollowing(user1Id, 10);
    expect(restoredMyFollowing).not.toBeNull();
    expect(restoredMyFollowing?.items.length).toBe(1);
    expect(restoredMyFollowing?.items[0].id).toBe(user2Id);
    expect(restoredMyFollowing?.items[0].is_unavailable).toBe(true);

    // Restore duration must be bounded
    expect(restoreDurationMs).toBeLessThan(5000);
  });
});
