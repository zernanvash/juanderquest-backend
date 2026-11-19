import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { ensureAreaCache } from '../src/maps/areas-service.js';
import { spotStore } from '../src/spots/store.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
jest.setTimeout(180_000);

realPg('Nationwide crowd monitoring, province/municipality rollups & area-admin scoping (real PG)', () => {
  let fixture: TestDbInstance;
  const suffix = randomUUID().slice(0, 8);
  const platformAdminId = `cn-plat-${suffix}`;
  const provAdminId = `cn-prov-${suffix}`;
  const muniAdminId = `cn-muni-${suffix}`;
  const v1Id = `cn-u1-${suffix}`;
  const v2Id = `cn-u2-${suffix}`;
  const v3Id = `cn-u3-${suffix}`;

  const pangProvId = `prov:cn-pang-${suffix}`;
  const laUnionProvId = `prov:cn-lu-${suffix}`;
  const dagupanTownId = `town:cn-dagupan-${suffix}`;
  const bolinaoTownId = `town:cn-bolinao-${suffix}`;
  const sanJuanTownId = `town:cn-sanjuan-${suffix}`;

  const dagupanSpotId = `spot-cn-dag-${suffix}`;
  const bolinaoSpotId = `spot-cn-bol-${suffix}`;
  const sanJuanSpotId = `spot-cn-sj-${suffix}`;

  const authHeader = (id: string, role = 'user') => ({
    Authorization: `Bearer ${jwt.sign({ id, seed_id: id, role, typ: 'session' }, env.JWT_SECRET, { expiresIn: '1h' })}`,
  });

  beforeAll(async () => {
    fixture = await createTestDb({ poolMax: 8 });
    setPool(fixture.pool);
    db.attachDurabilityPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    await spotStore.hydrateFromPg(fixture.pool);

    await fixture.pool.query(
      `INSERT INTO users(id, seed_id, display_name, email, role, admin_scope, demo_points, is_test, home_municipality) VALUES
       ($1::text, $1::text, 'Platform Admin', $1::text || '@example.test', 'admin', 'platform', 0, FALSE, NULL),
       ($2::text, $2::text, 'Pangasinan Admin', $2::text || '@example.test', 'area_admin', NULL, 0, FALSE, 'Dagupan City'),
       ($3::text, $3::text, 'Dagupan Admin', $3::text || '@example.test', 'area_admin', NULL, 0, FALSE, 'Dagupan City'),
       ($4::text, $4::text, 'Visitor One', $4::text || '@example.test', 'user', NULL, 0, FALSE, 'San Juan'),
       ($5::text, $5::text, 'Visitor Two', $5::text || '@example.test', 'user', NULL, 0, FALSE, 'Dagupan City'),
       ($6::text, $6::text, 'Visitor Three', $6::text || '@example.test', 'user', NULL, 0, FALSE, 'Quezon City')`,
      [platformAdminId, provAdminId, muniAdminId, v1Id, v2Id, v3Id],
    );

    await fixture.pool.query(
      `INSERT INTO admin_areas(id, level, name, display_name, parent_id, has_boundary, label_lat, label_lng, bbox, min_zoom) VALUES
       ($1, 'province', 'Pangasinan', 'Pangasinan', NULL, TRUE, 16.0, 120.2, ARRAY[119.7, 15.7, 120.9, 16.5]::double precision[], 5),
       ($2, 'province', 'La Union', 'La Union', NULL, TRUE, 16.6, 120.3, ARRAY[120.2, 16.2, 120.6, 16.9]::double precision[], 5),
       ($3, 'town', 'Dagupan City', 'Dagupan City, Pangasinan', $1, TRUE, 16.04, 120.33, ARRAY[120.30, 16.01, 120.37, 16.08]::double precision[], 11),
       ($4, 'town', 'Bolinao', 'Bolinao, Pangasinan', $1, TRUE, 16.38, 119.89, ARRAY[119.83, 16.30, 119.95, 16.43]::double precision[], 11),
       ($5, 'town', 'San Juan', 'San Juan, La Union', $2, TRUE, 16.67, 120.34, ARRAY[120.30, 16.63, 120.38, 16.72]::double precision[], 11)`,
      [pangProvId, laUnionProvId, dagupanTownId, bolinaoTownId, sanJuanTownId],
    );
    await ensureAreaCache(fixture.pool);

    await fixture.pool.query(
      `INSERT INTO admin_area_assignments(id, user_id, area_id, powers, granted_by) VALUES
       ($1::uuid, $2, $3, ARRAY['analytics']::text[], $4),
       ($5::uuid, $6, $7, ARRAY['analytics']::text[], $4)`,
      [randomUUID(), provAdminId, pangProvId, platformAdminId, randomUUID(), muniAdminId, dagupanTownId],
    );

    await fixture.pool.query(
      `INSERT INTO spots(id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng, source_type, source_name, trust_level, status, crowd_capacity_band, town_area_id, is_test) VALUES
       ($1::text, $1::text, 'Bonuan Tondaligan Beach', 'Beachfront park', 'nature_outdoors', 'beach', 'Dagupan City', 'Bonuan Gueset', 16.07, 120.34, 'official_lgu', 'Tourism Office', 'lgu_verified', 'published', 'medium', $4, FALSE),
       ($2::text, $2::text, 'Patar White Beach', 'White sand beach', 'nature_outdoors', 'beach', 'Bolinao', 'Patar', 16.33, 119.79, 'official_lgu', 'Tourism Office', 'lgu_verified', 'published', 'medium', $5, FALSE),
       ($3::text, $3::text, 'Urbiztondo Surf Beach', 'Surfing spot', 'nature_outdoors', 'beach', 'San Juan', 'Urbiztondo', 16.66, 120.32, 'official_lgu', 'Tourism Office', 'lgu_verified', 'published', 'medium', $6, FALSE)`,
      [dagupanSpotId, bolinaoSpotId, sanJuanSpotId, dagupanTownId, bolinaoTownId, sanJuanTownId],
    );

    const questId1 = `cn-quest1-${suffix}`;
    const questId2 = `cn-quest2-${suffix}`;
    const sub1 = `cn-sub1-${suffix}`;
    const sub2 = `cn-sub2-${suffix}`;
    const sub3 = `cn-sub3-${suffix}`;
    const sub4 = `cn-sub4-${suffix}`;
    await fixture.pool.query(
      `INSERT INTO quests(id, title, description, category, location_name, gps_lat, gps_lng, radius_meters,
        reward_points, marker_code, marker_image_url, author_id, status, version, steps, is_active, is_test)
       VALUES
        ($1::text, 'Nationwide Crowd Quest 1', 'Desc', 'eco', 'Dagupan', 16.07, 120.34, 100, 10, $3, '', $5, 'published', 1, '[]'::jsonb, TRUE, FALSE),
        ($2::text, 'Nationwide Crowd Quest 2', 'Desc', 'eco', 'Bolinao', 16.33, 119.79, 100, 10, $4, '', $5, 'published', 1, '[]'::jsonb, TRUE, FALSE)`,
      [questId1, questId2, `mk-${questId1}`, `mk-${questId2}`, platformAdminId],
    );
    await fixture.pool.query(
      `INSERT INTO submissions(id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status) VALUES
       ($1::text, $1::text, $5::text, $8::text, $10, 16.07, 120.34, 5, 'approved'),
       ($2::text, $2::text, $6::text, $8::text, $10, 16.07, 120.34, 5, 'approved'),
       ($3::text, $3::text, $5::text, $9::text, $11, 16.33, 119.79, 5, 'approved'),
       ($4::text, $4::text, $7::text, $8::text, $10, 16.66, 120.32, 5, 'approved')`,
      [sub1, sub2, sub3, sub4, v1Id, v2Id, v3Id, questId1, questId2, `mk-${questId1}`, `mk-${questId2}`],
    );

    await fixture.pool.query(
      `INSERT INTO verified_visits(id, user_id, spot_id, source_submission_id, occurred_at, is_test) VALUES
       ($1::uuid, $5::text, $8::text, $11::text, '2026-11-10T04:00:00Z', FALSE),
       ($2::uuid, $6::text, $8::text, $12::text, '2026-11-10T05:00:00Z', FALSE),
       ($3::uuid, $5::text, $9::text, $13::text, '2026-11-10T06:00:00Z', FALSE),
       ($4::uuid, $7::text, $10::text, $14::text, '2026-11-10T07:00:00Z', FALSE)`,
      [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        v1Id,
        v2Id,
        v3Id,
        dagupanSpotId,
        bolinaoSpotId,
        sanJuanSpotId,
        sub1,
        sub2,
        sub3,
        sub4,
      ],
    );
  });

  afterAll(async () => {
    await fixture?.close();
  });

  it('GET /admin/crowd/areas returns accessible provinces & municipalities and locks area admins cleanly', async () => {
    const plat = await request(app).get('/api/v1/admin/crowd/areas').set(authHeader(platformAdminId, 'admin'));
    expect(plat.status).toBe(200);
    expect(plat.body.data.scope_mode).toBe('platform');
    expect(plat.body.data.locked_province).toBeNull();
    expect(plat.body.data.locked_municipality).toBeNull();
    expect(plat.body.data.provinces.map((p: any) => p.name)).toEqual(
      expect.arrayContaining(['La Union', 'Pangasinan']),
    );

    const prov = await request(app).get('/api/v1/admin/crowd/areas').set(authHeader(provAdminId, 'area_admin'));
    expect(prov.status).toBe(200);
    expect(prov.body.data.scope_mode).toBe('province');
    expect(prov.body.data.locked_province).toBe(pangProvId);
    expect(prov.body.data.locked_municipality).toBeNull();
    expect(prov.body.data.provinces).toHaveLength(1);
    expect(prov.body.data.provinces[0].id).toBe(pangProvId);
    expect(prov.body.data.municipalities.map((m: any) => m.name).sort()).toEqual(['Bolinao', 'Dagupan City']);

    const muni = await request(app).get('/api/v1/admin/crowd/areas').set(authHeader(muniAdminId, 'area_admin'));
    expect(muni.status).toBe(200);
    expect(muni.body.data.scope_mode).toBe('municipality');
    expect(muni.body.data.locked_province).toBe(pangProvId);
    expect(muni.body.data.locked_municipality).toBe('Dagupan City');
    expect(muni.body.data.municipalities.map((m: any) => m.name)).toEqual(['Dagupan City']);
  });

  it('GET /admin/crowd/overview computes province vs municipality rollups, paginates, and blocks cross-area leaks', async () => {
    // Platform nationwide -> province rollup with both provinces
    const nationwide = await request(app)
      .get('/api/v1/admin/crowd/overview?from=2026-11-10&to=2026-11-11')
      .set(authHeader(platformAdminId, 'admin'));
    expect(nationwide.status).toBe(200);
    expect(nationwide.body.data.area_breakdown.level).toBe('province');
    expect(nationwide.body.data.area_breakdown.items.map((i: any) => i.area_name)).toEqual(
      expect.arrayContaining(['La Union', 'Pangasinan']),
    );
    expect(nationwide.body.data.kpis.verified_visits).toBe(4);

    // Filtered to Pangasinan -> municipality rollup & excludes San Juan (La Union)
    const filteredProv = await request(app)
      .get(`/api/v1/admin/crowd/overview?from=2026-11-10&to=2026-11-11&province=${encodeURIComponent(pangProvId)}`)
      .set(authHeader(platformAdminId, 'admin'));
    expect(filteredProv.status).toBe(200);
    expect(filteredProv.body.data.area_breakdown.level).toBe('municipality');
    expect(filteredProv.body.data.area_breakdown.items.map((i: any) => i.area_name).sort()).toEqual([
      'Bolinao',
      'Dagupan City',
    ]);
    expect(filteredProv.body.data.top_destinations.some((d: any) => d.spot_id === sanJuanSpotId)).toBe(false);

    // Pagination limits destinations and returns metadata
    const page1 = await request(app)
      .get(
        `/api/v1/admin/crowd/overview?from=2026-11-10&to=2026-11-11&province=${encodeURIComponent(pangProvId)}&page=1&limit=1&sort=name&dir=asc`,
      )
      .set(authHeader(platformAdminId, 'admin'));
    expect(page1.status).toBe(200);
    expect(page1.body.data.top_destinations).toHaveLength(1);
    expect(page1.body.data.destinations_pagination).toEqual({
      page: 1,
      limit: 1,
      total: 2,
      total_pages: 2,
    });

    // Municipal admin trying to query La Union or Bolinao gets 0 spots (never leaks)
    const muniEscapeProv = await request(app)
      .get(`/api/v1/admin/crowd/overview?from=2026-11-10&to=2026-11-11&province=${encodeURIComponent(laUnionProvId)}`)
      .set(authHeader(muniAdminId, 'area_admin'));
    expect(muniEscapeProv.status).toBe(200);
    expect(muniEscapeProv.body.data.top_destinations).toEqual([]);
    expect(muniEscapeProv.body.data.kpis.verified_visits).toBe(0);

    // Municipal admin reading own scope gets Dagupan masked '<3' (2 visits)
    const muniOwn = await request(app)
      .get('/api/v1/admin/crowd/overview?from=2026-11-10&to=2026-11-11')
      .set(authHeader(muniAdminId, 'area_admin'));
    expect(muniOwn.status).toBe(200);
    expect(muniOwn.body.data.privacy_masked).toBe(true);
    expect(muniOwn.body.data.top_destinations.map((d: any) => d.spot_id)).toEqual([dagupanSpotId]);
    expect(muniOwn.body.data.kpis.verified_visits).toBe('<3');

    // Area-switcher ?area_id= narrows provincial admin down to Dagupan
    const provSwitched = await request(app)
      .get(`/api/v1/admin/crowd/overview?from=2026-11-10&to=2026-11-11&area_id=${encodeURIComponent(dagupanTownId)}`)
      .set(authHeader(provAdminId, 'area_admin'));
    expect(provSwitched.status).toBe(200);
    expect(provSwitched.body.data.top_destinations.map((d: any) => d.spot_id)).toEqual([dagupanSpotId]);

    // Heatmap supports ?province=
    const luHeat = await request(app)
      .get(`/api/v1/admin/crowd/heatmap?from=2026-11-10&to=2026-11-11&province=${encodeURIComponent(laUnionProvId)}`)
      .set(authHeader(platformAdminId, 'admin'));
    expect(luHeat.status).toBe(200);
    const luTotalHeat = luHeat.body.data.cells.reduce((sum: number, c: any) => sum + Number(c.count), 0);
    expect(luTotalHeat).toBe(1);
  });
});
