import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { spotStore } from '../src/spots/store.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
jest.setTimeout(180_000);

realPg('Plan 92a: admin roles, CHECK constraint, and access boundaries (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const devId = `p92a-dev-${randomUUID()}`;
  const staffId = `p92a-staff-${randomUUID()}`;
  const plainAdminId = `p92a-plain-${randomUUID()}`;
  const areaAdminId = `p92a-area-${randomUUID()}`;
  const travelerId = `p92a-user-${randomUUID()}`;
  const demoteAdminId = `p92a-demote-${randomUUID()}`;
  const testSpotIds = [`spot-p92a-town-${randomUUID()}`, `spot-p92a-other-${randomUUID()}`];

  const token = (id: string, role: string) =>
    jwt.sign({ id, seed_id: id, role, typ: 'session' }, env.JWT_SECRET, { expiresIn: '1h' });
  const as = (id: string, role: string) => ({ Authorization: `Bearer ${token(id, role)}` });

  const prevJuanChoiceEnabled = env.JUANCHOICE_ENABLED;

  beforeAll(async () => {
    Reflect.set(env, 'JUANCHOICE_ENABLED', true);
    fixture = await createTestDb({ poolMax: 10 });
    setPool(fixture.pool);
    db.attachDurabilityPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);

    await fixture.pool.query(
      `INSERT INTO users(id, seed_id, display_name, email, role, admin_scope, is_test) VALUES
      ($1::text, $1::text, 'Dev 92a', $1::text || '@example.test', 'admin', 'developer', FALSE),
      ($2::text, $2::text, 'Staff 92a', $2::text || '@example.test', 'admin', 'platform', FALSE),
      ($3::text, $3::text, 'Plain 92a', $3::text || '@example.test', 'admin', NULL, FALSE),
      ($4::text, $4::text, 'Area 92a', $4::text || '@example.test', 'area_admin', NULL, FALSE),
      ($5::text, $5::text, 'User 92a', $5::text || '@example.test', 'user', NULL, FALSE),
      ($6::text, $6::text, 'Demote 92a', $6::text || '@example.test', 'admin', 'platform', FALSE)`,
      [devId, staffId, plainAdminId, areaAdminId, travelerId, demoteAdminId],
    );

    const addArea = (id: string, level: string, name: string, display: string, parent: string | null) =>
      fixture.pool.query(
        `INSERT INTO admin_areas(id, level, name, display_name, parent_id, has_boundary, label_lat, label_lng, bbox, min_zoom)
         VALUES ($1, $2, $3, $4, $5, TRUE, 16, 120, $6, 5)
         ON CONFLICT (id) DO NOTHING`,
        [id, level, name, display, parent, [119, 15, 121, 17]],
      );
    await addArea('province:p92a-pang', 'province', 'Pangasinan', 'Pangasinan', null);
    await addArea('town:p92a-bolinao', 'town', 'Bolinao', 'Bolinao, Pangasinan', 'province:p92a-pang');
    await addArea('town:p92a-alaminos', 'town', 'Alaminos', 'Alaminos, Pangasinan', 'province:p92a-pang');

    await fixture.pool.query(
      `INSERT INTO admin_area_assignments(id, user_id, area_id, powers, granted_by)
       VALUES ($1, $2, 'town:p92a-bolinao', ARRAY['destinations']::text[], $3)`,
      [randomUUID(), areaAdminId, devId],
    );

    spotStore.spots.push(
      {
        id: testSpotIds[0],
        slug: testSpotIds[0],
        name: 'Bolinao 92a Spot',
        description: '',
        category: 'nature_outdoors',
        subcategory: 'beach',
        tags: [],
        municipality: 'Bolinao',
        address: '',
        gps_lat: 16.38,
        gps_lng: 119.89,
        price_level: 0,
        hours: {},
        amenities: [],
        image_url: '',
        source_type: 'lgu',
        source_name: 'test',
        trust_level: 'lgu_verified',
        status: 'published',
        created_by: 'other',
        town_area_id: 'town:p92a-bolinao',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: testSpotIds[1],
        slug: testSpotIds[1],
        name: 'Alaminos 92a Spot',
        description: '',
        category: 'nature_outdoors',
        subcategory: 'island',
        tags: [],
        municipality: 'Alaminos',
        address: '',
        gps_lat: 16.15,
        gps_lng: 119.98,
        price_level: 0,
        hours: {},
        amenities: [],
        image_url: '',
        source_type: 'lgu',
        source_name: 'test',
        trust_level: 'lgu_verified',
        status: 'published',
        created_by: 'other',
        town_area_id: 'town:p92a-alaminos',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    );
  });

  afterAll(async () => {
    Reflect.set(env, 'JUANCHOICE_ENABLED', prevJuanChoiceEnabled);
    for (const id of testSpotIds) {
      const idx = spotStore.spots.findIndex((s) => s.id === id);
      if (idx !== -1) spotStore.spots.splice(idx, 1);
    }
    await fixture?.close();
  });

  it('rejects PUT /admin/developer/users/:id/role with admin_scope="area" (400)', async () => {
    const res = await request(app)
      .put(`/api/v1/admin/developer/users/${travelerId}/role`)
      .set(as(devId, 'admin'))
      .send({ role: 'admin', admin_scope: 'area', reason: 'Should be rejected in 92a' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('rejects invalid (role, admin_scope) pairs via users_role_admin_scope_check', async () => {
    const badAdminArea = `p92a-bad1-${randomUUID()}`;
    await expect(
      fixture.pool.query(
        `INSERT INTO users(id, seed_id, display_name, email, role, admin_scope)
         VALUES ($1::text, $1::text, 'Bad Admin Area', $1::text || '@example.test', 'admin', 'area')`,
        [badAdminArea],
      ),
    ).rejects.toThrow(/users_role_admin_scope_check/);

    const badUserPlatform = `p92a-bad2-${randomUUID()}`;
    await expect(
      fixture.pool.query(
        `INSERT INTO users(id, seed_id, display_name, email, role, admin_scope)
         VALUES ($1::text, $1::text, 'Bad User Platform', $1::text || '@example.test', 'user', 'platform')`,
        [badUserPlatform],
      ),
    ).rejects.toThrow(/users_role_admin_scope_check/);
  });

  it('migration 087 normalizes admin+area to admin+NULL and writes user_role_audit', async () => {
    const legacyAreaAdminId = `p92a-mig-${randomUUID()}`;
    // Temporarily drop the CHECK so we can seed a pre-087 admin+area row and replay 087 SQL
    await fixture.pool.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_admin_scope_check');
    await fixture.pool.query(
      `INSERT INTO users(id, seed_id, display_name, email, role, admin_scope, is_test)
       VALUES ($1::text, $1::text, 'Legacy Admin Area', $1::text || '@example.test', 'admin', 'area', FALSE)`,
      [legacyAreaAdminId],
    );

    const migrationSql = readFileSync(join(process.cwd(), 'migrations', '087_admin_role_scope_check.sql'), 'utf8');
    await fixture.pool.query(migrationSql);

    const userRow = (await fixture.pool.query('SELECT role, admin_scope FROM users WHERE id = $1', [legacyAreaAdminId]))
      .rows[0];
    expect(userRow).toEqual({ role: 'admin', admin_scope: null });

    const auditRows = (
      await fixture.pool.query(
        `SELECT actor_id, old_role, new_role, old_scope, new_scope, reason
         FROM user_role_audit
         WHERE target_id = $1`,
        [legacyAreaAdminId],
      )
    ).rows;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toEqual({
      actor_id: 'system:migration-087',
      old_role: 'admin',
      new_role: 'admin',
      old_scope: 'area',
      new_scope: null,
      reason: '087: Area admin option removed; access unchanged',
    });
  });

  it('rejects PUT /admin/developer/users/:id/role on an area_admin target with 409', async () => {
    const res = await request(app)
      .put(`/api/v1/admin/developer/users/${areaAdminId}/role`)
      .set(as(devId, 'admin'))
      .send({ role: 'user', admin_scope: null, reason: 'Attempt to bypass area-admins page' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AREA_ADMIN_MANAGED_IN_AREA_ADMINS');
  });

  it('enforces access boundaries across developer, staff, plain admin, and town area admin', async () => {
    // Developer: 200 on GET /admin/developer/users
    const devUsers = await request(app).get('/api/v1/admin/developer/users').set(as(devId, 'admin'));
    expect(devUsers.status).toBe(200);

    // JuanderQuest staff (admin + platform): 403 on developer/users, 200 on perk-controls
    const staffDev = await request(app).get('/api/v1/admin/developer/users').set(as(staffId, 'admin'));
    expect(staffDev.status).toBe(403);
    const staffPerks = await request(app).get('/api/v1/juanchoice/admin/perk-controls').set(as(staffId, 'admin'));
    expect(staffPerks.status).toBe(200);

    // Plain admin (admin + NULL): 200 on /admin/submissions, 403 on perk-controls
    const plainSubs = await request(app).get('/api/v1/admin/submissions').set(as(plainAdminId, 'admin'));
    expect(plainSubs.status).toBe(200);
    const plainPerks = await request(app).get('/api/v1/juanchoice/admin/perk-controls').set(as(plainAdminId, 'admin'));
    expect(plainPerks.status).toBe(403);

    // Area admin on town:p92a-bolinao with destinations: 200 on /admin/spots (only Bolinao spot), 403 on /admin/submissions
    const areaSpots = await request(app).get('/api/v1/admin/spots').set(as(areaAdminId, 'area_admin'));
    expect(areaSpots.status).toBe(200);
    const spotIdsReturned = areaSpots.body.data.map((s: { id: string }) => s.id);
    expect(spotIdsReturned).toContain(testSpotIds[0]);
    expect(spotIdsReturned).not.toContain(testSpotIds[1]);

    const areaSubs = await request(app).get('/api/v1/admin/submissions').set(as(areaAdminId, 'area_admin'));
    expect(areaSubs.status).toBe(403);
  });

  it('immediately invalidates session scope cache when a developer demotes an admin to user', async () => {
    // Prime sessionScopeCache for demoteAdminId
    const before = await request(app).get('/api/v1/auth/me').set(as(demoteAdminId, 'admin'));
    expect(before.status).toBe(200);
    expect(before.body.data.role).toBe('admin');

    const demote = await request(app)
      .put(`/api/v1/admin/developer/users/${demoteAdminId}/role`)
      .set(as(devId, 'admin'))
      .send({ role: 'user', admin_scope: null, reason: 'Testing immediate cache invalidation' });
    expect(demote.status).toBe(200);

    // Next request with the same token must immediately see role='user' and get 403 on admin routes
    const meAfter = await request(app).get('/api/v1/auth/me').set(as(demoteAdminId, 'admin'));
    expect(meAfter.status).toBe(200);
    expect(meAfter.body.data.role).toBe('user');

    const adminAfter = await request(app).get('/api/v1/admin/submissions').set(as(demoteAdminId, 'admin'));
    expect(adminAfter.status).toBe(403);
  });
});
