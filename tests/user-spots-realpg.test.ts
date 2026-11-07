import { randomUUID } from 'crypto';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { spotStore } from '../src/spots/store.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('GET /api/v1/users/:handle/spots (Real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const authorId = randomUUID();
  const handle = `pg_author_${Date.now()}`;
  const spotId1 = `spot-pg-${randomUUID()}`;
  const spotId2 = `spot-pg-${randomUUID()}`;
  const testSpotId = `spot-pg-test-${randomUUID()}`;
  const draftSpotId = `spot-pg-draft-${randomUUID()}`;

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.attachDurabilityPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);

    // Insert user into PostgreSQL
    await fixture.pool.query(
      `INSERT INTO users(id, seed_id, display_name, handle, email, role, is_public, is_test, demo_points)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [authorId, authorId, 'PG Author', handle, `${authorId}@example.test`, 'user', true, false, 100]
    );

    // Insert spots into PostgreSQL:
    // 1. Published spot 1 (older)
    await fixture.pool.query(
      `INSERT INTO spots(id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng,
         status, is_test, recommendation_suppressed, source_type, source_name, created_by, created_at, updated_at)
       VALUES($1, $2, 'PG Scenic Beach', 'Beautiful white sand beach.', 'nature_outdoors', 'beach',
         'Bolinao', 'Patar, Bolinao', 16.3, 119.79, 'published', false, false, 'community', 'PG Author', $3,
         NOW() - INTERVAL '2 hours', NOW())`,
      [spotId1, spotId1, authorId]
    );

    // 2. Published spot 2 (newer)
    await fixture.pool.query(
      `INSERT INTO spots(id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng,
         status, is_test, recommendation_suppressed, source_type, source_name, created_by, created_at, updated_at)
       VALUES($1, $2, 'PG Historic Lighthouse', 'Spanish-era historic lighthouse.', 'culture_heritage', 'heritage_site',
         'Bolinao', 'Cape Bolinao', 16.35, 119.79, 'published', false, false, 'community', $3, $4,
         NOW() - INTERVAL '1 hour', NOW())`,
      [spotId2, spotId2, 'PG Author', authorId]
    );

    // 3. Unpublished draft spot
    await fixture.pool.query(
      `INSERT INTO spots(id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng,
         status, is_test, recommendation_suppressed, source_type, source_name, created_by, created_at, updated_at)
       VALUES($1, $2, 'PG Draft Spot', 'Draft details.', 'eat_drink', 'cafe',
         'Lingayen', 'Capitol', 16.02, 120.23, 'needs_review', false, false, 'community', 'PG Author', $3,
         NOW(), NOW())`,
      [draftSpotId, draftSpotId, authorId]
    );

    // 4. Test spot (is_test = true)
    await fixture.pool.query(
      `INSERT INTO spots(id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng,
         status, is_test, recommendation_suppressed, source_type, source_name, created_by, created_at, updated_at)
       VALUES($1, $2, 'PG Test Spot', 'Simulated test.', 'nature_outdoors', 'beach',
         'Dasol', 'Tambobong', 15.9, 119.78, 'published', true, false, 'community', 'PG Author', $3,
         NOW(), NOW())`,
      [testSpotId, testSpotId, authorId]
    );
  });

  afterAll(async () => {
    setPool(null);
    db.attachDurabilityPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  });

  it('returns 404 USER_NOT_FOUND for non-existent handle in PostgreSQL', async () => {
    const res = await request(app).get('/api/v1/users/non_existent_author_000/spots');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });

  it('returns published spots created by the user from PostgreSQL, hiding drafts and test spots', async () => {
    const res = await request(app).get(`/api/v1/users/${handle}/spots`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const spots = res.body.data.spots;
    expect(spots.length).toBe(2);

    // Newest first: spot2 (lighthouse) then spot1 (beach)
    expect(spots[0].name).toBe('PG Historic Lighthouse');
    expect(spots[1].name).toBe('PG Scenic Beach');

    // Source name sanitized from author ID to display name
    expect(spots[0].source_name).toBe('PG Author');
    expect(spots[1].source_name).toBe('PG Author');
  });

  it('paginates PostgreSQL results with limit and offset', async () => {
    const resP1 = await request(app).get(`/api/v1/users/${handle}/spots?limit=1&offset=0`);
    expect(resP1.status).toBe(200);
    expect(resP1.body.data.spots.length).toBe(1);
    expect(resP1.body.data.spots[0].name).toBe('PG Historic Lighthouse');
    expect(resP1.body.data.next).toBe('1');

    const resP2 = await request(app).get(`/api/v1/users/${handle}/spots?limit=1&offset=1`);
    expect(resP2.status).toBe(200);
    expect(resP2.body.data.spots.length).toBe(1);
    expect(resP2.body.data.spots[0].name).toBe('PG Scenic Beach');
    expect(resP2.body.data.next).toBeNull();
  });
});
