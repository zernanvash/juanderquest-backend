import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { spotStore } from '../src/spots/store.js';
import { assetStore } from '../src/spots/asset-store.js';

// Plan 124b: PATCH /spots/:id/cover — author picks the cover from approved photos on the spot.
describe('Plan 124b — author cover photo', () => {
  let testDb: TestDbInstance;
  const authorId = 'author-p124b';
  const otherId = 'other-p124b';
  const adminId = 'admin-p124b';
  const spotId = 'spot-p124b';
  const otherSpotId = 'spot-p124b-other';
  const slug = 'p124b-cove';
  const sign = (id: string, role: string) => jwt.sign({ id, seed_id: id, role, typ: 'session' }, env.JWT_SECRET);
  const authorToken = sign(authorId, 'user');
  const otherToken = sign(otherId, 'user');
  const adminToken = sign(adminId, 'admin');

  async function seedAsset(
    id: string,
    opts: {
      status: 'pending' | 'attached' | 'deleted' | 'approved';
      spot: string | null;
      mime?: string;
      primary?: boolean;
    },
  ) {
    const mime = opts.mime ?? 'image/jpeg';
    const url = `/api/v1/uploads/spot-photos/${id}.jpg`;
    await testDb.pool.query(
      `INSERT INTO spot_assets (id, user_id, storage_provider, object_key, url, mime_type, width, height, size_bytes, status, spot_id, is_primary)
       VALUES ($1, $2, 'local', $3, $4, $5, 800, 600, 10240, $6, $7, $8)`,
      [id, authorId, `spot-photos/${id}.jpg`, url, mime, opts.status, opts.spot, Boolean(opts.primary)],
    );
    return url;
  }

  const cover = (assetId: string, token = authorToken, target = spotId) =>
    request(app)
      .patch(`/api/v1/spots/${target}/cover`)
      .set('Authorization', `Bearer ${token}`)
      .send({ asset_id: assetId });

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    await testDb.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, role) VALUES
         ($1, 'seed-a-p124b', 'Author', 'author-p124b@juanderquest.app', 'user'),
         ($2, 'seed-o-p124b', 'Other', 'other-p124b@juanderquest.app', 'user'),
         ($3, 'seed-ad-p124b', 'Admin', 'admin-p124b@juanderquest.app', 'admin')
       ON CONFLICT (id) DO NOTHING`,
      [authorId, otherId, adminId],
    );
    await testDb.pool.query(
      `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng, source_type, source_name, trust_level, status, created_by, image_url)
       VALUES ($1, $2, 'P124b Cove', 'Cove.', 'nature_outdoors', 'beach', 'Alaminos', 'Alaminos, Pangasinan', 16.15, 119.98, 'community', 'Author', 'community', 'published', $3, '/old.jpg'),
              ($4, 'p124b-other', 'P124b Other', 'Other.', 'nature_outdoors', 'beach', 'Alaminos', 'Alaminos, Pangasinan', 16.2, 119.9, 'community', 'Author', 'community', 'published', $3, '')
       ON CONFLICT (id) DO NOTHING`,
      [spotId, slug, authorId, otherSpotId],
    );
    await seedAsset('a-attached-1', { status: 'attached', spot: spotId, primary: true });
    await seedAsset('a-attached-2', { status: 'attached', spot: spotId });
    await seedAsset('a-catalog', { status: 'approved', spot: spotId });
    await seedAsset('a-pending', { status: 'pending', spot: spotId });
    await seedAsset('a-deleted', { status: 'deleted', spot: spotId });
    await seedAsset('a-video', { status: 'attached', spot: spotId, mime: 'video/mp4' });
    await seedAsset('a-elsewhere', { status: 'attached', spot: otherSpotId });
    await db.hydrateFromPg(testDb.pool);
    await spotStore.hydrateFromPg(testDb.pool);
    await assetStore.hydrateFromPg(testDb.pool);
  });

  afterAll(async () => {
    setPool(null);
    if (testDb) await testDb.close();
  });

  it('author sets an approved upload as cover; PG, primary flag and /spots/:slug follow', async () => {
    const res = await cover('a-attached-2');
    expect(res.status).toBe(200);
    expect(res.body.data.cover_asset_id).toBe('a-attached-2');
    const url = '/api/v1/uploads/spot-photos/a-attached-2.jpg';
    expect(res.body.data.image_url).toBe(url);

    const pg = await testDb.pool.query('SELECT image_url FROM spots WHERE id = $1', [spotId]);
    expect(pg.rows[0].image_url).toBe(url);
    const primary = await testDb.pool.query('SELECT id FROM spot_assets WHERE spot_id = $1 AND is_primary', [spotId]);
    expect(primary.rows.map((r) => r.id)).toEqual(['a-attached-2']);

    const detail = await request(app).get(`/api/v1/spots/${slug}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.image_url).toBe(url);
  });

  it('switching cover again swaps the primary without a unique-index violation', async () => {
    expect((await cover('a-catalog')).status).toBe(200);
    expect((await cover('a-attached-1')).status).toBe(200);
    const primary = await testDb.pool.query('SELECT id FROM spot_assets WHERE spot_id = $1 AND is_primary', [spotId]);
    expect(primary.rows.map((r) => r.id)).toEqual(['a-attached-1']);
  });

  it('rejects non-authors with 403 and lets a platform admin change it', async () => {
    expect((await cover('a-attached-2', otherToken)).status).toBe(403);
    expect((await cover('a-attached-2', adminToken)).status).toBe(200);
  });

  it.each(['a-pending', 'a-deleted', 'a-video', 'a-elsewhere', 'no-such-asset'])(
    'rejects %s with 400 INVALID_COVER_ASSET',
    async (assetId) => {
      const res = await cover(assetId);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_COVER_ASSET');
    },
  );

  it('404s for an unknown spot', async () => {
    expect((await cover('a-attached-1', authorToken, 'no-such-spot')).status).toBe(404);
  });
});
