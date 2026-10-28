import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';

describe('Admin settings, audit and observation', () => {
  let testDb: TestDbInstance;

  const adminUserId = 'admin-settings-1';
  const travelerUserId = 'traveler-settings-1';

  const adminToken = jwt.sign({ id: adminUserId, seed_id: 'admin-settings-seed', role: 'admin' }, env.JWT_SECRET);
  const travelerToken = jwt.sign({ id: travelerUserId, seed_id: 'traveler-settings-seed', role: 'user' }, env.JWT_SECRET);

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    await db.hydrateFromPg(testDb.pool);

    await testDb.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, role)
       VALUES
         ($1, 'admin-settings-seed', 'Settings Admin', 'settings-admin@juanderquest.app', 'admin'),
         ($2, 'traveler-settings-seed', 'Settings Traveler', 'settings-traveler@juanderquest.app', 'user')
       ON CONFLICT (id) DO NOTHING`,
      [adminUserId, travelerUserId]
    );
  });

  afterAll(async () => {
    setPool(null);
    await testDb.close();
  });

  it('returns canonical defaults with the explicit schema and no secret-bearing keys', async () => {
    const response = await request(app)
      .get('/api/v1/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data.revision).toBe(0);
    expect(response.body.data.values.quiz_default_radius_meters).toBe(200);
    expect(response.body.data.values.trail_personal_generation_enabled).toBe(true);
    expect(response.body.data.values.support_contact_email).toBe('');
    const keys = response.body.data.definitions.map((definition: { key: string }) => definition.key);
    expect(keys).toContain('quiz_default_language');
    expect(keys).toContain('trail_personal_generation_enabled');
    expect(keys).not.toContain('jwt_secret');
    expect(JSON.stringify(response.body)).not.toContain('AZURE_STORAGE_CONNECTION_STRING');
  });

  it('rejects unknown keys and out-of-bounds or unsafe values', async () => {
    const unknown = await request(app)
      .put('/api/v1/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ expected_revision: 0, changes: { jwt_secret: 'nope' } });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('UNKNOWN_SETTING');

    const bounds = await request(app)
      .put('/api/v1/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ expected_revision: 0, changes: { quiz_default_radius_meters: 20 } });
    expect(bounds.status).toBe(400);
    expect(bounds.body.error.code).toBe('VALIDATION_ERROR');

    const unsafeUrl = await request(app)
      .put('/api/v1/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ expected_revision: 0, changes: { support_help_url: 'javascript:alert(1)' } });
    expect(unsafeUrl.status).toBe(400);

    const html = await request(app)
      .put('/api/v1/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ expected_revision: 0, changes: { announcement_message: '<b>hello</b>' } });
    expect(html.status).toBe(400);
  });

  it('persists an audited change with request id and returns canonical values', async () => {
    const response = await request(app)
      .put('/api/v1/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-request-id', 'req-settings-test-1')
      .send({
        expected_revision: 0,
        reason: 'Initial support contact for the pilot.',
        changes: {
          support_contact_email: 'tourism@pangasinan.gov.ph',
          announcement_message: 'Cultural quiz pilot is live.',
          quiz_default_radius_meters: 300,
          trail_personal_generation_enabled: false,
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.data.revision).toBe(1);
    expect(response.body.data.values.support_contact_email).toBe('tourism@pangasinan.gov.ph');
    expect(response.body.data.values.quiz_default_radius_meters).toBe(300);
    expect(response.body.data.values.trail_personal_generation_enabled).toBe(true);

    const reloaded = await request(app)
      .get('/api/v1/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(reloaded.body.data.revision).toBe(1);
    expect(reloaded.body.data.values.announcement_message).toBe('Cultural quiz pilot is live.');
  });

  it('rejects a stale revision and returns the current canonical values for comparison', async () => {
    const stale = await request(app)
      .put('/api/v1/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ expected_revision: 0, changes: { announcement_message: 'Second editor overwrite.' } });

    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('REVISION_CONFLICT');
    expect(stale.body.error.current.revision).toBe(1);
    expect(stale.body.error.current.values.support_contact_email).toBe('tourism@pangasinan.gov.ph');

    const reloaded = await request(app)
      .get('/api/v1/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(reloaded.body.data.values.announcement_message).toBe('Cultural quiz pilot is live.');
  });

  it('exposes a settings-only audit feed with actor, revision and request correlation', async () => {
    const response = await request(app)
      .get('/api/v1/admin/settings/audit')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data.scope).toBe('settings_only');
    const entry = response.body.data.entries[0];
    expect(entry.actor_id).toBe(adminUserId);
    expect(entry.revision).toBe(1);
    expect(entry.request_id).toBe('req-settings-test-1');
    expect(entry.reason).toBe('Initial support contact for the pilot.');
    expect(entry.changed_keys).toEqual(['support_contact_email', 'announcement_message', 'quiz_default_radius_meters', 'trail_personal_generation_enabled']);
    expect(entry.before_values.quiz_default_radius_meters).toBe(200);
    expect(entry.after_values.quiz_default_radius_meters).toBe(300);
    expect(entry.before_values.trail_personal_generation_enabled).toBe(true);
    expect(entry.after_values.trail_personal_generation_enabled).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain(env.JWT_SECRET);
  });

  it('serves sanitized read-only system status with no secret values', async () => {
    const response = await request(app)
      .get('/api/v1/admin/system/status')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data.read_only).toBe(true);
    expect(typeof response.body.data.observed_at).toBe('string');
    expect(response.body.data.service.ready).toBe(true);
    expect(response.body.data.runtime.migration_ledger.up_to_date).toBe(true);
    expect(typeof response.body.data.feature_flags.juanchoice_writes_enabled).toBe('boolean');
    expect(response.body.data.release.version_name).toBeTruthy();

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(env.JWT_SECRET);
    expect(serialized).not.toContain(env.AZURE_STORAGE_CONNECTION_STRING || '__none__');
    expect(serialized).not.toContain('DATABASE_URL');
  });

  it('denies non-administrator access to settings, audit and status', async () => {
    for (const path of ['/api/v1/admin/settings', '/api/v1/admin/settings/audit', '/api/v1/admin/system/status']) {
      const response = await request(app).get(path).set('Authorization', `Bearer ${travelerToken}`);
      expect(response.status).toBe(403);
    }
  });
});
