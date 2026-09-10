import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { MIGRATIONS, applyMigrations } from '../src/db/pool.js';

describe('Phase 0: Database Harness & Migration Ledger (pg-mem)', () => {
  let db: TestDbInstance;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('successfully applies migrations 001-008 and verifies schema_migrations ledger', async () => {
    const ledger = await db.pool.query('SELECT filename FROM schema_migrations ORDER BY filename ASC');
    expect(ledger.rows.map((r: any) => r.filename)).toEqual(MIGRATIONS);
  });

  it('verifies migration idempotency: running applyMigrations a second time does not fail or duplicate entries', async () => {
    await expect(applyMigrations(db.pool)).resolves.not.toThrow();

    const ledger = await db.pool.query('SELECT filename FROM schema_migrations ORDER BY filename ASC');
    expect(ledger.rows.map((r: any) => r.filename)).toEqual(MIGRATIONS);
    expect(ledger.rows.length).toBe(MIGRATIONS.length);
  });

  it('verifies table constraints, uniqueness, foreign keys, and check constraints', async () => {
    // 1. Insert user
    await db.pool.query(`
      INSERT INTO users (id, seed_id, display_name, email, role, is_public)
      VALUES ('u1', 'seed-1', 'Test Traveler', 'test@test.com', 'user', true)
    `);

    const userRes = await db.pool.query('SELECT * FROM users WHERE id = $1', ['u1']);
    expect(userRes.rows.length).toBe(1);
    expect(userRes.rows[0].display_name).toBe('Test Traveler');

    // 2. Uniqueness constraint: duplicate seed_id fails
    await expect(
      db.pool.query(`
        INSERT INTO users (id, seed_id, display_name, email, role, is_public)
        VALUES ('u1-dup', 'seed-1', 'Another User', 'test2@test.com', 'user', true)
      `)
    ).rejects.toThrow();

    // 3. User follow constraints
    await db.pool.query(`
      INSERT INTO users (id, seed_id, display_name, email, role, is_public)
      VALUES ('u2', 'seed-2', 'Target Traveler', 'target@test.com', 'user', true)
    `);

    await db.pool.query(`
      INSERT INTO user_follows (follower_id, following_id)
      VALUES ('u1', 'u2')
    `);

    const followRes = await db.pool.query('SELECT * FROM user_follows WHERE follower_id = $1', ['u1']);
    expect(followRes.rows.length).toBe(1);

    // 4. Check constraint: self-follow is prohibited
    await expect(
      db.pool.query(`INSERT INTO user_follows (follower_id, following_id) VALUES ('u1', 'u1')`)
    ).rejects.toThrow();
  });
});
