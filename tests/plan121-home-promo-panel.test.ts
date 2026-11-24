import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
jest.setTimeout(120_000);

realPg('Plan 121: Highlighted Home feedback & promo panel settings (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const adminId = `p121-admin-${randomUUID()}`;
  const travelerId = `p121-trav-${randomUUID()}`;

  const authHeader = (id: string, role = 'user') => ({
    Authorization: `Bearer ${jwt.sign({ id, seed_id: id, role, typ: 'session' }, env.JWT_SECRET, { expiresIn: '1h' })}`,
  });

  beforeAll(async () => {
    fixture = await createTestDb({ poolMax: 5 });
    setPool(fixture.pool);
    db.attachDurabilityPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);

    await fixture.pool.query(
      `INSERT INTO users(id, seed_id, display_name, email, role, admin_scope, demo_points, is_test) VALUES
       ($1::text, $1::text, 'Platform Admin 121', $1::text || '@example.test', 'admin', 'platform', 0, FALSE),
       ($2::text, $2::text, 'Traveler 121', $2::text || '@example.test', 'user', NULL, 0, FALSE)`,
      [adminId, travelerId],
    );
  });

  afterAll(async () => {
    db.usersRepo.setPool(null);
    setPool(null);
    await fixture?.close();
  });

  it('defaults to promo_panel = null and exposes all 7 app_promo_* keys in admin overview', async () => {
    const ver = await request(app).get('/api/v1/app/version');
    expect(ver.status).toBe(200);
    expect(ver.body.data.promo_panel).toBeNull();

    const ov = await request(app).get('/api/v1/admin/mobile-app/overview').set(authHeader(adminId, 'admin'));
    expect(ov.status).toBe(200);
    expect(ov.body.data.settings).toMatchObject({
      app_promo_enabled: false,
      app_promo_campaign_id: '',
      app_promo_title: '',
      app_promo_body: '',
      app_promo_cta_label: 'Open Form',
      app_promo_url: '',
      app_promo_until: '',
    });
  });

  it('validates https-only URLs, plain text, campaign_id format, and ISO expiry in PUT /admin/settings', async () => {
    const ov = await request(app).get('/api/v1/admin/mobile-app/overview').set(authHeader(adminId, 'admin'));
    const rev = ov.body.data.settings.revision;

    for (const badChanges of [
      { app_promo_url: 'http://insecure.example.com/form' },
      { app_promo_url: 'javascript:alert(1)' },
      { app_promo_title: '<script>alert(1)</script>' },
      { app_promo_campaign_id: 'bad campaign id' },
      { app_promo_until: 'not-a-date' },
    ]) {
      const res = await request(app).put('/api/v1/admin/settings').set(authHeader(adminId, 'admin')).send({
        expected_revision: rev,
        reason: 'Invalid promo setting check',
        changes: badChanges,
      });
      expect(res.status).toBe(400);
    }

    // Non-admin traveler is forbidden
    const travRes = await request(app)
      .put('/api/v1/admin/settings')
      .set(authHeader(travelerId, 'user'))
      .send({
        expected_revision: rev,
        reason: 'Unauthorized promo update',
        changes: { app_promo_enabled: true },
      });
    expect(travRes.status).toBe(403);
  });

  it('returns active promo_panel on /app/version, derives fallback campaign_id if blank, and hides when expired', async () => {
    const ov1 = await request(app).get('/api/v1/admin/mobile-app/overview').set(authHeader(adminId, 'admin'));
    const futureUntil = new Date(Date.now() + 86_400_000).toISOString();

    const save1 = await request(app)
      .put('/api/v1/admin/settings')
      .set(authHeader(adminId, 'admin'))
      .send({
        expected_revision: ov1.body.data.settings.revision,
        reason: 'Enable beta feedback promo wave 1',
        changes: {
          app_promo_enabled: true,
          app_promo_campaign_id: 'beta-wave-1',
          app_promo_title: 'Share Your Beta Feedback!',
          app_promo_body: 'Take a quick 2-minute survey about your trip.',
          app_promo_cta_label: 'Open Survey',
          app_promo_url: 'https://forms.gle/example123',
          app_promo_until: futureUntil,
        },
      });
    expect(save1.status).toBe(200);

    const verActive = await request(app).get('/api/v1/app/version');
    expect(verActive.status).toBe(200);
    expect(verActive.body.data.promo_panel).toEqual({
      campaign_id: 'beta-wave-1',
      title: 'Share Your Beta Feedback!',
      body: 'Take a quick 2-minute survey about your trip.',
      cta_label: 'Open Survey',
      url: 'https://forms.gle/example123',
      until: futureUntil,
    });

    const ov2 = await request(app).get('/api/v1/admin/mobile-app/overview').set(authHeader(adminId, 'admin'));
    expect(ov2.body.data.settings).toMatchObject({
      app_promo_enabled: true,
      app_promo_campaign_id: 'beta-wave-1',
      app_promo_title: 'Share Your Beta Feedback!',
      app_promo_body: 'Take a quick 2-minute survey about your trip.',
      app_promo_cta_label: 'Open Survey',
      app_promo_url: 'https://forms.gle/example123',
      app_promo_until: futureUntil,
    });

    // Blank campaign_id falls back to a deterministic promo-* ID
    const saveFallback = await request(app)
      .put('/api/v1/admin/settings')
      .set(authHeader(adminId, 'admin'))
      .send({
        expected_revision: ov2.body.data.settings.revision,
        reason: 'Test fallback campaign ID',
        changes: { app_promo_campaign_id: '' },
      });
    expect(saveFallback.status).toBe(200);
    const verFallback = await request(app).get('/api/v1/app/version');
    expect(verFallback.body.data.promo_panel?.campaign_id).toMatch(/^promo-[a-f0-9]{12}$/);

    // Expired app_promo_until hides promo_panel
    const ov3 = await request(app).get('/api/v1/admin/mobile-app/overview').set(authHeader(adminId, 'admin'));
    const pastUntil = new Date(Date.now() - 60_000).toISOString();
    const saveExpired = await request(app)
      .put('/api/v1/admin/settings')
      .set(authHeader(adminId, 'admin'))
      .send({
        expected_revision: ov3.body.data.settings.revision,
        reason: 'Expire promo wave',
        changes: { app_promo_until: pastUntil },
      });
    expect(saveExpired.status).toBe(200);

    const verExpired = await request(app).get('/api/v1/app/version');
    expect(verExpired.status).toBe(200);
    expect(verExpired.body.data.promo_panel).toBeNull();
  });
});
