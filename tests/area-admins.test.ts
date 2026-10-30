import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { spotStore } from '../src/spots/store.js';

describe('Plan 59 area administrator access (real PostgreSQL when JDQ_REAL_PG_URL is set)', () => {
  let fixture: TestDbInstance;
  const platformId = 'area-admin-platform';
  const areaUserId = 'area-admin-user';
  const platformToken = jwt.sign({ id: platformId, seed_id: 'area-admin-platform-seed', role: 'admin' }, env.JWT_SECRET);
  const plainAdminId = 'area-admin-plain-platform';
  const plainAdminToken = jwt.sign({ id: plainAdminId, seed_id: 'area-admin-plain-seed', role: 'admin' }, env.JWT_SECRET);
  const areaToken = jwt.sign({ id: areaUserId, seed_id: 'area-admin-user-seed', role: 'area_admin' }, env.JWT_SECRET);
  const spotIds = ['spot-area-test-dagupan', 'spot-area-test-other', 'spot-area-test-null'];
  const savedAreaFields = new Map<string, { town_area_id?: string | null; created_by?: string }>();
  let originalFindById: typeof db.usersRepo.findById;

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    await db.hydrateFromPg(fixture.pool);
    // Granting/revoking changes users.role, which is developer-only since migration 076.
    await fixture.pool.query(`INSERT INTO users(id,seed_id,display_name,email,role,admin_scope) VALUES
      ($1,'area-admin-platform-seed','Platform Developer','area-platform@test.local','admin','developer'),
      ($2,'area-admin-user-seed','Area Admin','area-user@test.local','user',NULL),
      ($3,'area-admin-plain-seed','Platform Admin','area-plain@test.local','admin','platform')`, [platformId, areaUserId, plainAdminId]);
    originalFindById = db.usersRepo.findById.bind(db.usersRepo);
    jest.spyOn(db.usersRepo, 'findById').mockImplementation(async (id: string) => {
      const user = await originalFindById(id);
      return id === areaUserId && user ? { ...user, role: 'area_admin' } : user;
    });
    const addArea = (id: string, level: string, name: string, display: string, parent: string | null) =>
      fixture.pool.query(`INSERT INTO admin_areas(id,level,name,display_name,parent_id,has_boundary,label_lat,label_lng,bbox,min_zoom)
        VALUES ($1,$2,$3,$4,$5,TRUE,16,120,$6,5)`, [id, level, name, display, parent, [119,15,121,17]]);
    await addArea('pangasinan', 'province', 'Pangasinan', 'Pangasinan', null);
    await addArea('dagupan', 'town', 'Dagupan City', 'Dagupan City, Pangasinan', 'pangasinan');
    await addArea('la-union', 'province', 'La Union', 'La Union', null);
    await fixture.pool.query(`INSERT INTO admin_area_assignments(id,user_id,area_id,powers,granted_by)
      VALUES ('area-admin-grant', $1, 'pangasinan', ARRAY['destinations','analytics']::text[], $2)`, [areaUserId, platformId]);
    for (const id of spotIds) {
      const spot = spotStore.spots.find((item) => item.id === id);
      if (spot) savedAreaFields.set(id, { town_area_id: spot.town_area_id, created_by: spot.created_by });
    }
    spotStore.spots.push(
      { id: spotIds[0], slug: spotIds[0], name: 'Dagupan test destination', description: '', category: 'culture_heritage', subcategory: 'heritage_site', tags: [], municipality: 'Dagupan City', address: '', gps_lat: 16, gps_lng: 120, price_level: 0, hours: {}, amenities: [], image_url: '', source_type: 'lgu', source_name: 'test', trust_level: 'lgu_verified', status: 'published', created_by: 'another-user', town_area_id: 'dagupan', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: spotIds[1], slug: spotIds[1], name: 'Outside test destination', description: '', category: 'culture_heritage', subcategory: 'heritage_site', tags: [], municipality: 'La Union', address: '', gps_lat: 16, gps_lng: 120, price_level: 0, hours: {}, amenities: [], image_url: '', source_type: 'lgu', source_name: 'test', trust_level: 'lgu_verified', status: 'published', town_area_id: 'la-union', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: spotIds[2], slug: spotIds[2], name: 'Unassigned test destination', description: '', category: 'culture_heritage', subcategory: 'heritage_site', tags: [], municipality: 'Unknown', address: '', gps_lat: 16, gps_lng: 120, price_level: 0, hours: {}, amenities: [], image_url: '', source_type: 'lgu', source_name: 'test', trust_level: 'lgu_verified', status: 'published', town_area_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    );
  });

  afterAll(async () => {
    spotStore.spots = spotStore.spots.filter((spot) => !spotIds.includes(spot.id));
    for (const [id, fields] of savedAreaFields) {
      const existing = spotStore.spots.find((spot) => spot.id === id);
      if (existing) Object.assign(existing, fields);
    }
    setPool(null);
    db.usersRepo.setPool(null);
    jest.restoreAllMocks();
    if (fixture) await fixture.close();
  });

  it('filters destination lists to the assigned area subtree and denies outside or NULL-area details', async () => {
    const list = await request(app).get('/api/v1/admin/spots').set('Authorization', `Bearer ${areaToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((spot: { id: string }) => spot.id)).toContain(spotIds[0]);
    expect(list.body.data.map((spot: { id: string }) => spot.id)).not.toContain(spotIds[1]);
    expect(list.body.data.map((spot: { id: string }) => spot.id)).not.toContain(spotIds[2]);
    expect((await request(app).get(`/api/v1/admin/spots/${spotIds[1]}`).set('Authorization', `Bearer ${areaToken}`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/admin/spots/${spotIds[2]}`).set('Authorization', `Bearer ${areaToken}`)).status).toBe(404);
  });

  it.each([
    ['economy', '/api/v1/admin/treasury'],
    ['chain', '/api/v1/admin/chain/overview'],
    ['settings', '/api/v1/admin/settings'],
    ['cosmetics', '/api/v1/admin/shop/cosmetics'],
    ['area-admin assignment', '/api/v1/admin/area-admins'],
  ])('keeps the %s route platform-only', async (_name, path) => {
    const response = await request(app).get(path).set('Authorization', `Bearer ${areaToken}`);
    expect(response.status).toBe(403);
  });

  it('blocks an area admin from moderating a destination they created', async () => {
    const spot = spotStore.spots.find((item) => item.id === spotIds[0])!;
    const previousAuthor = spot.created_by;
    spot.created_by = areaUserId;
    const response = await request(app).patch(`/api/v1/admin/spots/${spotIds[0]}`).set('Authorization', `Bearer ${areaToken}`)
      .send({ status: 'unpublished', crowd_capacity_band: 'medium', recommendation_suppressed: false });
    spot.created_by = previousAuthor;
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('SELF_MODERATION_FORBIDDEN');
  });

  it('lets only developers grant or revoke area admins (role changes, migration 076)', async () => {
    const grant = await request(app).post('/api/v1/admin/area-admins').set('Authorization', `Bearer ${plainAdminToken}`)
      .send({ user_id: areaUserId, area_id: 'pangasinan', powers: ['destinations'] });
    expect(grant.status).toBe(403);
    expect(grant.body.error.code).toBe('DEVELOPER_ONLY');
    const revoke = await request(app).delete('/api/v1/admin/area-admins/area-admin-grant').set('Authorization', `Bearer ${plainAdminToken}`);
    expect(revoke.status).toBe(403);
  });

  it('requires the requested power and applies grant revocation on the next request', async () => {
    const noMerchantPower = await request(app).get('/api/v1/admin/merchants').set('Authorization', `Bearer ${areaToken}`);
    expect(noMerchantPower.status).toBe(403);
    const revoke = await request(app).delete('/api/v1/admin/area-admins/area-admin-grant').set('Authorization', `Bearer ${platformToken}`);
    expect(revoke.status).toBe(200);
    expect(revoke.body.data.demoted).toBe(true);
    expect((await request(app).get('/api/v1/admin/spots').set('Authorization', `Bearer ${areaToken}`)).status).toBe(403);
  });

  const realPg = process.env.JDQ_REAL_PG_URL ? it : it.skip;
  realPg('creates assignments and records grant, revoke, and scoped destination writes in the audit log', async () => {
    await fixture.pool.query("UPDATE users SET role='user' WHERE id=$1", [areaUserId]);
    const granted = await request(app).post('/api/v1/admin/area-admins').set('Authorization', `Bearer ${platformToken}`)
      .send({ user_id: areaUserId, area_id: 'pangasinan', powers: ['destinations'] });
    expect(granted.status).toBe(201);
    const patch = await request(app).patch(`/api/v1/admin/spots/${spotIds[0]}`).set('Authorization', `Bearer ${areaToken}`)
      .send({ status: 'unpublished', crowd_capacity_band: 'medium', recommendation_suppressed: false });
    expect(patch.status).toBe(200);
    const revoked = await request(app).delete(`/api/v1/admin/area-admins/${granted.body.data.id}`).set('Authorization', `Bearer ${platformToken}`);
    expect(revoked.status).toBe(200);
    const actions = await fixture.pool.query("SELECT action FROM admin_audit_log WHERE subject_type IN ('area_admin_assignment','spot') ORDER BY created_at");
    expect(actions.rows.map((row) => row.action)).toEqual(expect.arrayContaining(['area_admin.granted', 'destination.reviewed', 'area_admin.revoked']));
    const roleAudit = await fixture.pool.query('SELECT old_role, new_role FROM user_role_audit WHERE target_id=$1 ORDER BY created_at', [areaUserId]);
    expect(roleAudit.rows.map((row) => `${row.old_role}->${row.new_role}`)).toEqual(expect.arrayContaining(['user->area_admin', 'area_admin->user']));
  });
});
