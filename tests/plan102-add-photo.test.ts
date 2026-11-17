import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { spotStore } from '../src/spots/store.js';
import { assetStore } from '../src/spots/asset-store.js';
import { spotPhotoSubmissionStore } from '../src/spots/photo-submission-store.js';

describe('Plan 102 — Add photo to destination with admin approval', () => {
  let testDb: TestDbInstance;

  const adminId = 'admin-p102';
  const uploaderId = 'traveler-p102-a';
  const otherUserId = 'traveler-p102-b';
  const spotId = 'spot-p102-alaminos';
  const spotSlug = 'alaminos-test-cove';

  const signToken = (id: string, role: string) => jwt.sign({ id, seed_id: id, role, typ: 'session' }, env.JWT_SECRET);

  const adminToken = signToken(adminId, 'admin');
  const uploaderToken = signToken(uploaderId, 'user');
  const otherToken = signToken(otherUserId, 'user');

  async function seedAsset(
    id: string,
    userId: string,
    status: 'pending' | 'attached' = 'pending',
    targetSpotId: string | null = null,
  ) {
    const url = `/api/v1/uploads/spot-photos/${id}.jpg`;
    await testDb.pool.query(
      `INSERT INTO spot_assets (id, user_id, storage_provider, object_key, url, mime_type, width, height, size_bytes, status, spot_id)
       VALUES ($1, $2, 'local', $3, $4, 'image/jpeg', 800, 600, 10240, $5, $6)`,
      [id, userId, `spot-photos/${id}.jpg`, url, status, targetSpotId],
    );
    assetStore.assets.set(id, {
      id,
      user_id: userId,
      storage_provider: 'local',
      object_key: `spot-photos/${id}.jpg`,
      url,
      mime_type: 'image/jpeg',
      media_type: 'image',
      width: 800,
      height: 600,
      size_bytes: 10240,
      status,
      spot_id: targetSpotId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return url;
  }

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    await db.hydrateFromPg(testDb.pool);
    await spotStore.hydrateFromPg(testDb.pool);
    await assetStore.hydrateFromPg(testDb.pool);

    await testDb.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, role)
       VALUES
         ($1, 'seed-admin-p102', 'Photo Admin', 'photo-admin@juanderquest.app', 'admin'),
         ($2, 'seed-uploader-p102', 'Photo Scout A', 'scout-a@juanderquest.app', 'user'),
         ($3, 'seed-other-p102', 'Photo Scout B', 'scout-b@juanderquest.app', 'user')
       ON CONFLICT (id) DO NOTHING`,
      [adminId, uploaderId, otherUserId],
    );
    await db.hydrateFromPg(testDb.pool);

    await testDb.pool.query(
      `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng, source_type, source_name, trust_level, status)
       VALUES ($1, $2, 'Alaminos Test Cove', 'Scenic cove in Alaminos.', 'nature_outdoors', 'beach', 'Alaminos', 'Alaminos, Pangasinan', 16.15, 119.98, 'community', 'Scout A', 'community', 'published')
       ON CONFLICT (id) DO NOTHING`,
      [spotId, spotSlug],
    );
    await spotStore.hydrateFromPg(testDb.pool);
  });

  afterAll(async () => {
    spotPhotoSubmissionStore.clearMemory();
    setPool(null);
    if (testDb) {
      await testDb.close();
    }
  });

  it('pending -> approve -> appears in spot photos and notifies uploader', async () => {
    const assetId = `asset-${randomUUID()}`;
    const url = await seedAsset(assetId, uploaderId);

    const submitRes = await request(app)
      .post(`/api/v1/spots/${spotId}/photos`)
      .set('Authorization', `Bearer ${uploaderToken}`)
      .send({ asset_id: assetId, caption: 'Sunny morning jetty' });

    expect(submitRes.status).toBe(201);
    expect(submitRes.body.data.status).toBe('pending');
    expect(submitRes.body.data.caption).toBe('Sunny morning jetty');
    const subId = submitRes.body.data.id;

    const listRes = await request(app)
      .get('/api/v1/admin/spot-photos?status=pending')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.some((row: any) => row.id === subId && row.spot_name === 'Alaminos Test Cove')).toBe(true);

    const approveRes = await request(app)
      .post(`/api/v1/admin/spot-photos/${subId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.data.status).toBe('approved');

    const spotRes = await request(app).get(`/api/v1/spots/${spotSlug}`);
    expect(spotRes.status).toBe(200);
    expect(spotRes.body.data.attached_assets.some((a: any) => a.id === assetId && a.url === url)).toBe(true);

    const notifRes = await testDb.pool.query(
      `SELECT kind, message FROM user_notifications WHERE user_id = $1 AND kind = 'spot_photo_approved'`,
      [uploaderId],
    );
    expect(notifRes.rows.length).toBe(1);
    expect(notifRes.rows[0].message).toContain('Alaminos Test Cove');
    expect(notifRes.rows[0].message).toContain('is live');
  });

  it('rejects a pending photo with reason and leaves it unattached', async () => {
    const assetId = `asset-${randomUUID()}`;
    await seedAsset(assetId, uploaderId);

    const submitRes = await request(app)
      .post(`/api/v1/spots/${spotId}/photos`)
      .set('Authorization', `Bearer ${uploaderToken}`)
      .send({ asset_id: assetId });
    expect(submitRes.status).toBe(201);
    const subId = submitRes.body.data.id;

    const rejectRes = await request(app)
      .post(`/api/v1/admin/spot-photos/${subId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Blurry image' });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.data.status).toBe('rejected');
    expect(rejectRes.body.data.reject_reason).toBe('Blurry image');

    const spotRes = await request(app).get(`/api/v1/spots/${spotSlug}`);
    expect(spotRes.body.data.attached_assets.some((a: any) => a.id === assetId)).toBe(false);
  });

  it('enforces asset ownership (403), unknown spot (404), and max 3 pending per user/spot (429)', async () => {
    const otherAsset = `asset-${randomUUID()}`;
    await seedAsset(otherAsset, otherUserId);

    const badSpotRes = await request(app)
      .post('/api/v1/spots/missing-spot/photos')
      .set('Authorization', `Bearer ${uploaderToken}`)
      .send({ asset_id: otherAsset });
    expect(badSpotRes.status).toBe(404);

    const wrongOwnerRes = await request(app)
      .post(`/api/v1/spots/${spotId}/photos`)
      .set('Authorization', `Bearer ${uploaderToken}`)
      .send({ asset_id: otherAsset });
    expect(wrongOwnerRes.status).toBe(403);

    // 3 pending for otherUserId on spotId -> 4th fails with 429
    const p1 = await seedAsset(`asset-${randomUUID()}`, otherUserId);
    expect(p1).toBeTruthy();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = `asset-${randomUUID()}`;
      await seedAsset(id, otherUserId);
      ids.push(id);
    }
    for (let i = 0; i < 3; i++) {
      const r = await request(app)
        .post(`/api/v1/spots/${spotId}/photos`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ asset_id: ids[i] });
      expect(r.status).toBe(201);
    }
    const dupRes = await request(app)
      .post(`/api/v1/spots/${spotId}/photos`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ asset_id: ids[0] });
    expect(dupRes.status).toBe(409);

    const fourthRes = await request(app)
      .post(`/api/v1/spots/${spotId}/photos`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ asset_id: ids[3] });
    expect(fourthRes.status).toBe(429);
  });

  it('enforces the 5-photo gallery cap on approve', async () => {
    const capSpotId = 'spot-p102-capped';
    await testDb.pool.query(
      `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng, source_type, source_name, trust_level, status)
       VALUES ($1, $2, 'Capped Spot', 'Already has 5 photos.', 'nature_outdoors', 'beach', 'Alaminos', 'Alaminos', 16.16, 119.99, 'community', 'Scout A', 'community', 'published')
       ON CONFLICT (id) DO NOTHING`,
      [capSpotId, capSpotId],
    );
    await spotStore.hydrateFromPg(testDb.pool);

    for (let i = 0; i < 5; i++) {
      await seedAsset(`cap-existing-${i}`, uploaderId, 'attached', capSpotId);
    }
    const extraId = `cap-extra-${randomUUID()}`;
    await seedAsset(extraId, uploaderId, 'pending', null);

    const submitRes = await request(app)
      .post(`/api/v1/spots/${capSpotId}/photos`)
      .set('Authorization', `Bearer ${uploaderToken}`)
      .send({ asset_id: extraId });
    expect(submitRes.status).toBe(201);

    const approveRes = await request(app)
      .post(`/api/v1/admin/spot-photos/${submitRes.body.data.id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(approveRes.status).toBe(409);
    expect(approveRes.body.error.code).toBe('MAX_IMAGES_EXCEEDED');
  });
});
