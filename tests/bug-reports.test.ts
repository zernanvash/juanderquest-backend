import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';

describe('Plan 114: public bug reports & admin triage', () => {
  let testDb: TestDbInstance;
  const adminId = 'bug-report-admin-1';
  const adminToken = jwt.sign(
    { id: adminId, seed_id: adminId, role: 'admin', typ: 'session' },
    env.JWT_SECRET,
  );

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    await db.hydrateFromPg(testDb.pool);
    await testDb.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, role)
       VALUES ($1::text, $1::text, 'Admin Reviewer', 'bug-admin@example.test', 'admin')`,
      [adminId],
    );
  }, 90_000);

  afterAll(async () => {
    setPool(null);
    await testDb?.close();
  });

  it('validates fields, ignores honeypot bots, persists valid reports, and supports admin triage', async () => {
    // 1. Rejects short summary
    const badRes = await request(app).post('/api/v1/bug-reports').send({
      category: 'crash',
      summary: 'bad',
      description: 'App crashed when opening map view.',
    });
    expect(badRes.status).toBe(400);
    expect(badRes.body.success).toBe(false);

    // 2. Honeypot bot submission returns 201 without saving
    const botRes = await request(app).post('/api/v1/bug-reports').send({
      category: 'other',
      summary: 'Spam bot report',
      description: 'Buy cheap things at spam.example.com',
      website: 'https://spam.example.com',
    });
    expect(botRes.status).toBe(201);
    expect(botRes.body.data.referenceCode).toBe('BUG-000000');

    // 3. Valid traveler bug report persists
    const createRes = await request(app).post('/api/v1/bug-reports').send({
      category: 'map',
      summary: 'Map tiles freeze on zoom',
      description: 'Pinching to zoom on Bolinao coast freezes the map view.',
      appVersion: 'v0.3.10 BETA',
      deviceInfo: 'Android 14',
      contactEmail: 'traveler@example.test',
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);
    expect(createRes.body.data.referenceCode).toMatch(/^BUG-[0-9A-F]{6}$/);

    // 4. Admin can list and update status (honeypot was not stored)
    const listRes = await request(app)
      .get('/api/v1/admin/bug-reports')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.items).toHaveLength(1);
    const saved = listRes.body.data.items[0];
    expect(saved.reference_code).toBe(createRes.body.data.referenceCode);
    expect(saved.app_version).toBe('v0.3.10 BETA');

    const patchRes = await request(app)
      .patch(`/api/v1/admin/bug-reports/${saved.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'triaged' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.status).toBe('triaged');
  });
});
