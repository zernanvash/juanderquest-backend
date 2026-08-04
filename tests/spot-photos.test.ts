import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { app } from '../src/app.js';
import { assetStore } from '../src/spots/asset-store.js';
import { LocalStorageProvider, AzureBlobStorageProvider } from '../src/storage/spot-photos.js';
import { env } from '../src/config/env.js';
import { rateLimit } from '../src/middleware/rateLimit.js';

describe('Spot Photo Uploads & Storage Adapter Specification', () => {
  let user1Token: string;
  let user2Token: string;

  // Minimal valid image buffers for testing magic byte detection
  const validJpegBuffer = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x60, 0x00, 0x60, 0x00,
    0x00, 0xff, 0xd9,
  ]);

  const validPngBuffer = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49,
    0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);

  const validWebpBuffer = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 0x18, 0x00, 0x00,
    0x00, 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00, 0x02, 0x00, 0x34, 0x25, 0xa4, 0x00, 0x03, 0x70,
    0x00, 0xfe, 0xfb, 0xfd, 0x50, 0x00,
  ]);

  const fakeImageBuffer = Buffer.from('<html><body>Fake Image Content</body></html>');
  const oversizedBuffer = Buffer.alloc(8 * 1024 * 1024 + 100);

  beforeAll(async () => {
    const res1 = await request(app).post('/api/v1/auth/demo-login').send({ seed_id: 'user-1' });
    user1Token = res1.body.data.token;

    const res2 = await request(app).post('/api/v1/auth/demo-login').send({ seed_id: 'admin-1' });
    user2Token = res2.body.data.token;
  });

  it('requires authentication for POST /api/v1/spot-photos', async () => {
    const res = await request(app)
      .post('/api/v1/spot-photos')
      .attach('photo', validJpegBuffer, 'test.jpg');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('successfully uploads valid JPEG photo', async () => {
    const res = await request(app)
      .post('/api/v1/spot-photos')
      .set('Authorization', `Bearer ${user1Token}`)
      .attach('photo', validJpegBuffer, 'sample.jpg');

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.asset_id).toBeDefined();
    expect(res.body.data.url).toMatch(/^\/api\/v1\/uploads\/spot-photos\//);
    expect(res.body.data.mime_type).toBe('image/jpeg');
    expect(res.body.data.size_bytes).toBe(validJpegBuffer.length);

    const asset = assetStore.getAssetById(res.body.data.asset_id);
    expect(asset).toBeDefined();
    expect(asset?.status).toBe('pending');
  });

  it('successfully uploads valid PNG photo', async () => {
    const res = await request(app)
      .post('/api/v1/spot-photos')
      .set('Authorization', `Bearer ${user1Token}`)
      .attach('photo', validPngBuffer, 'sample.png');

    expect(res.status).toBe(201);
    expect(res.body.data.mime_type).toBe('image/png');
  });

  it('successfully uploads valid WebP photo', async () => {
    const res = await request(app)
      .post('/api/v1/spot-photos')
      .set('Authorization', `Bearer ${user1Token}`)
      .attach('photo', validWebpBuffer, 'sample.webp');

    expect(res.status).toBe(201);
    expect(res.body.data.mime_type).toBe('image/webp');
  });

  it('rejects fake MIME / invalid image content', async () => {
    const res = await request(app)
      .post('/api/v1/spot-photos')
      .set('Authorization', `Bearer ${user1Token}`)
      .attach('photo', fakeImageBuffer, 'fake.jpg');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_IMAGE_CONTENT');
  });

  it('rejects oversized files exceeding 8 MB', async () => {
    const res = await request(app)
      .post('/api/v1/spot-photos')
      .set('Authorization', `Bearer ${user1Token}`)
      .attach('photo', oversizedBuffer, 'huge.jpg');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('prevents path traversal during local storage operations', async () => {
    const provider = new LocalStorageProvider();
    await expect(provider.deletePhoto('../../etc/passwd')).rejects.toThrow('PATH_TRAVERSAL_ATTEMPT');
  });

  it('enforces asset ownership during spot creation', async () => {
    // User 1 uploads asset
    const uploadRes = await request(app)
      .post('/api/v1/spot-photos')
      .set('Authorization', `Bearer ${user1Token}`)
      .attach('photo', validJpegBuffer, 'user1_spot.jpg');
    const assetId = uploadRes.body.data.asset_id;

    // User 2 attempts to attach User 1's asset
    const spotRes = await request(app)
      .post('/api/v1/spots')
      .set('Authorization', `Bearer ${user2Token}`)
      .send({
        name: 'Tamuntay Beach Viewpoint',
        description: 'A quiet coastal spot created for testing asset ownership controls.',
        category: 'nature_outdoors',
        subcategory: 'viewpoint',
        municipality: 'Infanta',
        address: 'Tamuntay Coast',
        gps_lat: 15.82,
        gps_lng: 119.91,
        asset_id: assetId,
      });

    expect(spotRes.status).toBe(403);
    expect(spotRes.body.error.code).toBe('UNAUTHORIZED_ATTACHMENT');
  });

  it('limits spot creation to a maximum of 5 images', async () => {
    // Upload 6 assets for user 1
    const assetIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const up = await request(app)
        .post('/api/v1/spot-photos')
        .set('Authorization', `Bearer ${user1Token}`)
        .attach('photo', validJpegBuffer, `img_${i}.jpg`);
      assetIds.push(up.body.data.asset_id);
    }

    const res = await request(app)
      .post('/api/v1/spots')
      .set('Authorization', `Bearer ${user1Token}`)
      .send({
        name: 'Agno Umbrella Rocks',
        description: 'Unique mushroom-shaped rock formations on the western Pangasinan coast.',
        category: 'nature_outdoors',
        subcategory: 'viewpoint',
        municipality: 'Agno',
        address: 'Sabangan',
        gps_lat: 16.15,
        gps_lng: 119.79,
        asset_ids: assetIds,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('transitions uploaded asset status from pending to attached upon spot creation', async () => {
    const uploadRes = await request(app)
      .post('/api/v1/spot-photos')
      .set('Authorization', `Bearer ${user1Token}`)
      .attach('photo', validJpegBuffer, 'attached_test.jpg');
    const assetId = uploadRes.body.data.asset_id;

    const createRes = await request(app)
      .post('/api/v1/spots')
      .set('Authorization', `Bearer ${user1Token}`)
      .send({
        name: 'Sual Sunset Deck',
        description: 'Overlooking Lingayen Gulf and local fishing ports along the highway.',
        category: 'nature_outdoors',
        subcategory: 'viewpoint',
        municipality: 'Sual',
        address: 'Poblacion Sual',
        gps_lat: 16.06,
        gps_lng: 120.09,
        asset_id: assetId,
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.data.image_url).toBe(uploadRes.body.data.url);

    const asset = assetStore.getAssetById(assetId);
    expect(asset?.status).toBe('attached');
    expect(asset?.spot_id).toBe(createRes.body.data.id);
  });

  it('cleans up abandoned pending uploads older than expiration hours', async () => {
    const uploadRes = await request(app)
      .post('/api/v1/spot-photos')
      .set('Authorization', `Bearer ${user1Token}`)
      .attach('photo', validJpegBuffer, 'abandoned.jpg');
    const assetId = uploadRes.body.data.asset_id;

    // Artificially age the pending asset to 25 hours ago
    const asset = assetStore.getAssetById(assetId);
    if (asset) {
      asset.created_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    }

    const cleanedCount = await assetStore.cleanupAbandonedSpotPhotos(24);
    expect(cleanedCount).toBeGreaterThanOrEqual(1);

    const updatedAsset = assetStore.getAssetById(assetId);
    expect(updatedAsset?.status).toBe('deleted');
  });

  it('applies rate limiting when threshold is exceeded', () => {
    const limiter = rateLimit({ windowMs: 60000, max: 2 });
    const req = { ip: '127.0.0.1' } as any;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as any;
    const next = jest.fn();

    limiter(req, res, next);
    limiter(req, res, next);
    limiter(req, res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'RATE_LIMITED' }),
      })
    );
  });

  it('fails with clear error when Azure storage mode is selected without connection string', () => {
    expect(() => new AzureBlobStorageProvider()).toThrow('AZURE_STORAGE_CONNECTION_STRING is missing');
  });
});
