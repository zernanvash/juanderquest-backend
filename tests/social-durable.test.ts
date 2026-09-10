import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db } from '../src/db/index.js';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';

describe('Phase 4: Durable Social Queries, Keyset Pagination, and Profile PATCH Semantics', () => {
  let testDb: TestDbInstance;

  const userA = {
    id: 'a1111111-1111-1111-1111-111111111111',
    seed_id: 'seed_user_a',
    display_name: 'Traveler Alpha',
    handle: 'alpha_traveler',
    bio: 'Loves the Hundred Islands',
    status_text: 'Active in Alaminos',
    is_public: true,
  };

  const userB = {
    id: 'b2222222-2222-2222-2222-222222222222',
    seed_id: 'seed_user_b',
    display_name: 'Traveler Bravo',
    handle: 'bravo_scout',
    bio: 'Exploring Bolinao',
    status_text: 'Surfing Patar',
    is_public: true,
  };

  const userC = {
    id: 'c3333333-3333-3333-3333-333333333333',
    seed_id: 'seed_user_c',
    display_name: 'Traveler Charlie',
    handle: 'charlie_trekker',
    bio: 'Biking Dagupan',
    status_text: 'At Bonuan Beach',
    is_public: true,
  };

  const tokenA = jwt.sign(
    { id: userA.id, seed_id: userA.seed_id, role: 'user' },
    env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const tokenB = jwt.sign(
    { id: userB.id, seed_id: userB.seed_id, role: 'user' },
    env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);

    // Insert test users into pg-mem
    await testDb.pool.query(`
      INSERT INTO users (id, seed_id, display_name, email, handle, bio, status_text, is_public, role, demo_points)
      VALUES 
        ('${userA.id}', '${userA.seed_id}', '${userA.display_name}', 'alpha@test.com', '${userA.handle}', '${userA.bio}', '${userA.status_text}', true, 'user', 50),
        ('${userB.id}', '${userB.seed_id}', '${userB.display_name}', 'bravo@test.com', '${userB.handle}', '${userB.bio}', '${userB.status_text}', true, 'user', 50),
        ('${userC.id}', '${userC.seed_id}', '${userC.display_name}', 'charlie@test.com', '${userC.handle}', '${userC.bio}', '${userC.status_text}', true, 'user', 50)
      ON CONFLICT (id) DO UPDATE SET
        handle = EXCLUDED.handle,
        bio = EXCLUDED.bio,
        status_text = EXCLUDED.status_text,
        is_public = EXCLUDED.is_public;
    `);

    await db.hydrateFromPg(testDb.pool);
  }, 30000);

  afterAll(async () => {
    setPool(null);
    if (testDb) await testDb.close();
  }, 30000);

  describe('Nullable PATCH Semantics', () => {
    it('clears nullable fields when explicitly set to null, preserving omitted fields', async () => {
      // 1. Explicitly null bio and status_text
      const patchRes1 = await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          bio: null,
          status_text: null,
        });

      expect(patchRes1.status).toBe(200);
      expect(patchRes1.body.success).toBe(true);
      expect(patchRes1.body.data.bio).toBeNull();
      expect(patchRes1.body.data.status_text).toBeNull();
      // Omitted handle should be preserved!
      expect(patchRes1.body.data.handle).toBe(userA.handle);

      // Verify in Postgres directly
      const dbRow = await testDb.pool.query('SELECT bio, status_text, handle FROM users WHERE id = $1', [userA.id]);
      expect(dbRow.rows[0].bio).toBeNull();
      expect(dbRow.rows[0].status_text).toBeNull();
      expect(dbRow.rows[0].handle).toBe(userA.handle);

      // 2. Update display_name only, verify nulls stay null and handle stays untouched
      const patchRes2 = await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          display_name: 'Alpha Renamed',
        });

      expect(patchRes2.status).toBe(200);
      expect(patchRes2.body.data.display_name).toBe('Alpha Renamed');
      expect(patchRes2.body.data.bio).toBeNull();
      expect(patchRes2.body.data.status_text).toBeNull();
      expect(patchRes2.body.data.handle).toBe(userA.handle);
    });

    it('rejects duplicate handle claims with 409 HANDLE_TAKEN', async () => {
      // User B tries to claim User A's handle
      const res = await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({
          handle: userA.handle,
        });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('HANDLE_TAKEN');
    });
  });

  describe('Query-Time Privacy Enforcement and Exclusions', () => {
    it('immediately 404s public profile lookups when user switches to private', async () => {
      // Check user B is currently public
      const pubBefore = await request(app).get(`/api/v1/users/${userB.id}/profile`);
      expect(pubBefore.status).toBe(200);

      // User B switches to private
      const patchRes = await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({
          is_public: false,
        });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.data.is_public).toBe(false);

      // Immediate public profile lookup by ID must 404
      const pubAfterId = await request(app).get(`/api/v1/users/${userB.id}/profile`);
      expect(pubAfterId.status).toBe(404);
      expect(pubAfterId.body.error.code).toBe('NOT_FOUND');

      // Immediate public profile lookup by handle must 404
      const pubAfterHandle = await request(app).get(`/api/v1/users/@${userB.handle}/profile`);
      expect(pubAfterHandle.status).toBe(404);
      expect(pubAfterHandle.body.error.code).toBe('NOT_FOUND');

      // Directory search must exclude user B
      const searchRes = await request(app).get('/api/v1/search?q=bravo');
      expect(searchRes.status).toBe(200);
      const groups = searchRes.body.data.groups || [];
      const peopleGroup = groups.find((g: any) => g.type === 'people');
      const foundB = peopleGroup?.items.some((p: any) => p.id === userB.id) || false;
      expect(foundB).toBe(false);
    });

    it('allows private user to read their own profile, followers, and following with no-store cache headers', async () => {
      // User B reading their own profile
      const ownProfile = await request(app)
        .get('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${tokenB}`);

      expect(ownProfile.status).toBe(200);
      expect(ownProfile.body.data.id).toBe(userB.id);
      expect(ownProfile.headers['cache-control']).toContain('no-store');

      // User B reading their own followers
      const ownFollowers = await request(app)
        .get('/api/v1/users/me/followers')
        .set('Authorization', `Bearer ${tokenB}`);

      expect(ownFollowers.status).toBe(200);
      expect(ownFollowers.headers['cache-control']).toContain('no-store');

      // Public cannot read private user B's followers
      const publicFollowers = await request(app).get(`/api/v1/users/${userB.id}/followers`);
      expect(publicFollowers.status).toBe(404);
    });

    it('retains following edge but marks newly private accounts as unavailable in following lists', async () => {
      // 1. Make Bravo public first so Alpha can follow Bravo
      await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ is_public: true });

      // Alpha follows Bravo
      const followRes = await request(app)
        .put(`/api/v1/users/${userB.id}/follow`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(followRes.status).toBe(200);
      expect(followRes.body.data.is_following).toBe(true);

      // 2. Bravo turns private
      await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ is_public: false });

      // 3. Alpha fetches their following list
      const myFollowingRes = await request(app)
        .get('/api/v1/users/me/following')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(myFollowingRes.status).toBe(200);
      const followingList = myFollowingRes.body.data.items;
      const bravoEntry = followingList.find((u: any) => u.id === userB.id);
      expect(bravoEntry).toBeDefined();
      expect(bravoEntry.is_unavailable).toBe(true);
      // Private data must be redacted
      expect(bravoEntry.bio).toBeNull();
    });
  });

  describe('Durable Keyset Pagination', () => {
    it('returns deterministic next_cursor and avoids duplicates across pages', async () => {
      // Set up: User A is public. Users B, C, and D follow User A.
      const userDId = 'd4444444-4444-4444-4444-444444444444';
      await testDb.pool.query(`
        INSERT INTO users (id, seed_id, display_name, email, is_public, role, demo_points)
        VALUES ('${userDId}', 'seed_user_d', 'Traveler Delta', 'delta@test.com', true, 'user', 50)
        ON CONFLICT (id) DO UPDATE SET is_public = true;
      `);

      await testDb.pool.query('UPDATE users SET is_public = true WHERE id IN ($1, $2, $3)', [
        userA.id,
        userB.id,
        userC.id,
      ]);

      // Insert 3 follow edges for user A with distinct timestamps
      await testDb.pool.query(`
        INSERT INTO user_follows (follower_id, following_id, created_at)
        VALUES 
          ('${userB.id}', '${userA.id}', NOW() - INTERVAL '3 minutes'),
          ('${userC.id}', '${userA.id}', NOW() - INTERVAL '2 minutes'),
          ('${userDId}', '${userA.id}', NOW() - INTERVAL '1 minute')
        ON CONFLICT (follower_id, following_id) DO NOTHING;
      `);

      // Page 1 with limit 2 for followers of User A
      const page1 = await request(app).get(`/api/v1/users/${userA.id}/followers?limit=2`);
      expect(page1.status).toBe(200);
      expect(page1.body.data.items.length).toBe(2);
      expect(page1.body.data.next_cursor).toBeDefined();
      expect(page1.body.data.has_more).toBe(true);

      const cursor = page1.body.data.next_cursor;
      const idsPage1 = page1.body.data.items.map((u: any) => u.id);

      // Page 2 using cursor
      const page2 = await request(app).get(`/api/v1/users/${userA.id}/followers?limit=2&cursor=${encodeURIComponent(cursor)}`);
      expect(page2.status).toBe(200);
      expect(page2.body.data.items.length).toBe(1);
      const idsPage2 = page2.body.data.items.map((u: any) => u.id);

      // Guarantee no overlap between pages
      for (const id of idsPage2) {
        expect(idsPage1).not.toContain(id);
      }
    });
  });
});
