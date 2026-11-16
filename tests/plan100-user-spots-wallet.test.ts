import { randomUUID } from 'crypto';
import request from 'supertest';
import { app } from '../src/app.js';
import { signSessionToken } from '../src/auth/tokens.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

// Plan 100 WP-1 (owner 2026-11-16): a wallet account's own Profile asked for
// /users/wallet:0x…/spots and got 404; posted spots also stay visible on private profiles.
realPg('GET /users/:handle/spots for wallet and private accounts (Real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const userId = randomUUID();
  const seedId = `wallet:0x${randomUUID().replace(/-/g, '').slice(0, 40)}`;
  const handle = `wallet_author_${Date.now()}`;
  const testUserId = randomUUID();
  const testHandle = `test_author_${Date.now()}`;
  const published = `spot-p100-${randomUUID()}`;
  const review = `spot-p100-review-${randomUUID()}`;
  const testUserSpot = `spot-p100-testuser-${randomUUID()}`;

  const insertSpot = (id: string, status: string, author: string) =>
    fixture.pool.query(
      `INSERT INTO spots(id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng,
         status, is_test, recommendation_suppressed, source_type, source_name, created_by, created_at, updated_at)
       VALUES($1, $1, 'P100 Spot', 'A posted spot.', 'nature_outdoors', 'beach', 'Bolinao', 'Patar', 16.3, 119.79,
         $2, false, false, 'community', 'Author', $3, NOW(), NOW())`,
      [id, status, author],
    );

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.attachDurabilityPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    await fixture.pool.query(
      `INSERT INTO users(id, seed_id, display_name, handle, email, role, is_public, is_test, demo_points)
       VALUES($1, $2, 'Wallet Author', $3, $4, 'user', false, false, 0),
             ($5, $5, 'Test Author', $6, $7, 'user', true, true, 0)`,
      [userId, seedId, handle, `${userId}@example.test`, testUserId, testHandle, `${testUserId}@example.test`],
    );
    await insertSpot(published, 'published', userId);
    await insertSpot(review, 'needs_review', userId);
    await insertSpot(testUserSpot, 'published', testUserId);
  });

  afterAll(async () => {
    setPool(null);
    db.attachDurabilityPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  });

  const ids = (res: request.Response) => (res.body.data.spots as Array<{ id: string }>).map((s) => s.id);

  it('the signed-in owner gets their spots by user id, handle or wallet seed id', async () => {
    const token = signSessionToken({ id: userId, seed_id: seedId, role: 'user' });
    for (const key of [userId, handle, encodeURIComponent(seedId)]) {
      const res = await request(app).get(`/api/v1/users/${key}/spots`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(ids(res)).toEqual([published]);
    }
  });

  it('other travelers see published spots of a private profile, never ones under review', async () => {
    for (const key of [handle, userId]) {
      const res = await request(app).get(`/api/v1/users/${key}/spots`);
      expect(res.status).toBe(200);
      expect(ids(res)).toEqual([published]);
    }
  });

  it('test accounts stay hidden from travelers', async () => {
    const res = await request(app).get(`/api/v1/users/${testHandle}/spots`);
    expect(res.status).toBe(404);
  });
});
