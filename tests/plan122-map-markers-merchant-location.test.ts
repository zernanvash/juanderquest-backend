import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';
import { setPool } from '../src/db/pool.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { spotStore } from '../src/spots/store.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('Plan 122a — 3-tier map markers & Merchant Hub destination linking (real PG)', () => {
  let fixture: TestDbInstance;
  const originalMarketplace = env.MARKETPLACE_ENABLED;

  const ownerAId = `p122-owner-a-${randomUUID().slice(0, 8)}`;
  const staffAId = `p122-staff-a-${randomUUID().slice(0, 8)}`;
  const ownerBId = `p122-owner-b-${randomUUID().slice(0, 8)}`;
  const adminId = `p122-admin-${randomUUID().slice(0, 8)}`;
  const areaAdminId = `p122-area-admin-${randomUUID().slice(0, 8)}`;

  const merchantAId = `m-p122-a-${randomUUID().slice(0, 8)}`;
  const merchantBId = `m-p122-b-${randomUUID().slice(0, 8)}`;

  const townAId = `area-p122-a-${randomUUID().slice(0, 8)}`;
  const townBId = `area-p122-b-${randomUUID().slice(0, 8)}`;

  const authoredSpotId = `spot-p122-auth-${randomUUID().slice(0, 8)}`;
  const authoredSlug = `pangasinan-cafe-${randomUUID().slice(0, 6)}`;
  const lguSpotId = `spot-p122-lgu-${randomUUID().slice(0, 8)}`;
  const lguSlug = `lingayen-capitol-${randomUUID().slice(0, 6)}`;
  const baseSpotId = `spot-p122-base-${randomUUID().slice(0, 8)}`;
  const baseSlug = `alaminos-wharf-${randomUUID().slice(0, 6)}`;

  const signToken = (id: string, role: string) => jwt.sign({ id, seed_id: id, role, typ: 'session' }, env.JWT_SECRET);

  const ownerAToken = signToken(ownerAId, 'user');
  const staffAToken = signToken(staffAId, 'user');
  const ownerBToken = signToken(ownerBId, 'user');
  const adminToken = signToken(adminId, 'admin');
  const areaAdminToken = signToken(areaAdminId, 'area_admin');

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);

    await fixture.pool.query(
      `INSERT INTO admin_areas (id, level, name, display_name, label_lat, label_lng, bbox)
       VALUES
         ($1, 'town', 'Lingayen', 'Lingayen, Pangasinan', 16.02, 120.23, ARRAY[120.1, 15.9, 120.3, 16.1]),
         ($2, 'town', 'Alaminos', 'Alaminos, Pangasinan', 16.15, 119.98, ARRAY[119.8, 16.0, 120.1, 16.3])`,
      [townAId, townBId],
    );

    await fixture.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, role, handle, avatar_url, demo_points)
       VALUES
         ($1::text, $1::text, 'Owner Alpha', 'owner-a@example.test', 'user', 'owner_a_122', '', 100),
         ($2::text, $2::text, 'Staff Alpha', 'staff-a@example.test', 'user', 'staff_a_122', '', 50),
         ($3::text, $3::text, 'Owner Beta', 'owner-b@example.test', 'user', 'owner_b_122', '', 100),
         ($4::text, $4::text, 'Platform Admin', 'admin122@example.test', 'admin', 'admin_122', '', 0),
         ($5::text, $5::text, 'Alaminos Area Admin', 'area122@example.test', 'area_admin', 'area_122', '', 0)`,
      [ownerAId, staffAId, ownerBId, adminId, areaAdminId],
    );

    // Area admin is scoped ONLY to townB (Alaminos), NOT townA (Lingayen).
    await fixture.pool.query(
      `INSERT INTO admin_area_assignments (id, user_id, area_id, powers, granted_by)
       VALUES ($1, $2, $3, ARRAY['merchants_vouchers']::text[], $4)`,
      [`assign-122-${randomUUID().slice(0, 8)}`, areaAdminId, townBId, adminId],
    );

    await fixture.pool.query(
      `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng,
         status, is_test, recommendation_suppressed, source_type, source_name, trust_level, created_by, town_area_id)
       VALUES
         ($1, $2, 'Kape Pangasinan', 'Local heritage coffee shop by the baywalk.', 'food_dining', 'cafe',
          'Lingayen', 'Baywalk Rd, Lingayen', 16.0250, 120.2310, 'published', false, false, 'community', 'Owner Alpha', 'community', $7, $8),
         ($3, $4, 'Lingayen Capitol Grounds', 'Historic provincial capitol landmark.', 'culture_heritage', 'landmark',
          'Lingayen', 'Capitol Blvd, Lingayen', 16.0290, 120.2340, 'published', false, false, 'lgu', 'Pangasinan LGU', 'lgu_verified', NULL, $8),
         ($5, $6, 'Alaminos Lucap Wharf', 'Gateway wharf to Hundred Islands.', 'nature_outdoors', 'coastal',
          'Alaminos', 'Lucap, Alaminos', 16.1920, 120.0020, 'published', false, false, 'lgu', 'Alaminos LGU', 'lgu_verified', NULL, $9)`,
      [authoredSpotId, authoredSlug, lguSpotId, lguSlug, baseSpotId, baseSlug, ownerAId, townAId, townBId],
    );

    await fixture.pool.query(
      `INSERT INTO merchants (id, name, location, description, status, is_published, category, municipality, is_test, created_at)
       VALUES
         ($1, 'Kape Pangasinan Roasters', 'Lingayen Baywalk', 'Artisanal Pangasinan coffee.', 'active', true, 'Cafe', 'Lingayen', false, NOW() - INTERVAL '2 days'),
         ($2, 'Bolinao Artisans Co.', 'Lingayen Plaza', 'Local crafts and delicacies.', 'active', true, 'Crafts', 'Lingayen', false, NOW() - INTERVAL '1 day')`,
      [merchantAId, merchantBId],
    );

    await fixture.pool.query(
      `INSERT INTO merchant_memberships (id, merchant_id, user_id, role, status)
       VALUES
         ($1, $4, $5, 'owner', 'active'),
         ($2, $4, $6, 'staff', 'active'),
         ($3, $7, $8, 'owner', 'active')`,
      [
        `mm-${randomUUID().slice(0, 8)}`,
        `mm-${randomUUID().slice(0, 8)}`,
        `mm-${randomUUID().slice(0, 8)}`,
        merchantAId,
        ownerAId,
        staffAId,
        merchantBId,
        ownerBId,
      ],
    );

    await db.hydrateFromPg(fixture.pool);
    await spotStore.hydrateFromPg(fixture.pool);
  }, 60_000);

  afterAll(async () => {
    (env as any).MARKETPLACE_ENABLED = originalMarketplace;
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  });

  test('migration 117 is registered, enforces uq_merchants_spot_id, and deduplication keeps oldest merchant', async () => {
    expect(MIGRATIONS).toContain('117_merchant_spot_links.sql');

    // Verify deduplication CTE logic directly on a temporary pair of merchants sharing a spot_id
    // by dropping the unique index inside a rolled-back savepoint and re-running the 117 SQL.
    const sql117 = readFileSync(join(process.cwd(), 'migrations', '117_merchant_spot_links.sql'), 'utf8');
    const client = await fixture.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP INDEX IF EXISTS uq_merchants_spot_id');
      await client.query(`UPDATE merchants SET spot_id = $1 WHERE id IN ($2, $3)`, [
        baseSpotId,
        merchantAId,
        merchantBId,
      ]);
      await client.query(sql117);
      const rows = (
        await client.query(`SELECT id, spot_id FROM merchants WHERE id IN ($1, $2) ORDER BY created_at ASC`, [
          merchantAId,
          merchantBId,
        ])
      ).rows;
      // merchantA was created 2 days ago (older), merchantB 1 day ago (newer)
      expect(rows[0].id).toBe(merchantAId);
      expect(rows[0].spot_id).toBe(baseSpotId);
      expect(rows[1].id).toBe(merchantBId);
      expect(rows[1].spot_id).toBeNull();
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  test('owner check rejects staff (403) and non-author owner (403 SPOT_AUTHORSHIP_REQUIRED); author owner links instantly', async () => {
    // Staff cannot link
    const staffRes = await request(app)
      .put('/api/v1/merchant/location')
      .set('Authorization', `Bearer ${staffAToken}`)
      .send({ spot_id: authoredSpotId });
    expect(staffRes.status).toBe(403);
    expect(staffRes.body.error.code).toBe('MERCHANT_OWNER_REQUIRED');

    // Owner A cannot directly link LGU spot they did not author
    const nonAuthorRes = await request(app)
      .put('/api/v1/merchant/location')
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ spot_id: lguSpotId });
    expect(nonAuthorRes.status).toBe(403);
    expect(nonAuthorRes.body.error.code).toBe('SPOT_AUTHORSHIP_REQUIRED');

    // Owner A lists candidates and sees authoredSpotId
    const candRes = await request(app)
      .get('/api/v1/merchant/location/candidates')
      .set('Authorization', `Bearer ${ownerAToken}`);
    expect(candRes.status).toBe(200);
    expect(candRes.body.data.authored_spots.some((s: any) => s.id === authoredSpotId)).toBe(true);
    expect(candRes.body.data.linked_spot).toBeNull();

    // Owner A links their authored spot immediately
    const linkRes = await request(app)
      .put('/api/v1/merchant/location')
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ spot_id: authoredSpotId });
    expect(linkRes.status).toBe(200);
    expect(linkRes.body.data.linked_spot.id).toBe(authoredSpotId);

    // Owner B trying to claim already-linked spot gets 409 SPOT_ALREADY_LINKED_TO_MERCHANT
    const dupClaimRes = await request(app)
      .post('/api/v1/merchant/location/claim')
      .set('Authorization', `Bearer ${ownerBToken}`)
      .send({ spot_id: authoredSpotId, note: 'We operate our branch inside this location.' });
    expect(dupClaimRes.status).toBe(409);
    expect(dupClaimRes.body.error.code).toBe('SPOT_ALREADY_LINKED_TO_MERCHANT');

    // Hydrated linked_spot shows on /merchant/me and /merchants/:id
    const meRes = await request(app).get('/api/v1/merchant/me').set('Authorization', `Bearer ${ownerAToken}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.merchant.spot_id).toBe(authoredSpotId);
    expect(meRes.body.data.linked_spot.slug).toBe(authoredSlug);

    const pubRes = await request(app).get(`/api/v1/merchants/${merchantAId}`);
    expect(pubRes.status).toBe(200);
    expect(pubRes.body.data.merchant.spot_id).toBe(authoredSpotId);
    expect(pubRes.body.data.merchant.linked_spot.id).toBe(authoredSpotId);
  });

  test('MARKETPLACE_ENABLED=false hides Local Partner pins & badges; MARKETPLACE_ENABLED=true exposes merchant marker_kind', async () => {
    const bbox = '119.5,15.5,121.0,16.5';

    // When MARKETPLACE_ENABLED = false (production default)
    (env as any).MARKETPLACE_ENABLED = false;

    const mapOff = await request(app).get(`/api/v1/spots/map?bbox=${bbox}&zoom=12`);
    expect(mapOff.status).toBe(200);
    const authoredMarkerOff = mapOff.body.data.markers.find((m: any) => m.id === authoredSpotId);
    expect(authoredMarkerOff).toBeDefined();
    expect(authoredMarkerOff.marker_kind).toBe('spot');
    expect(authoredMarkerOff.is_local_partner).toBe(false);
    expect(authoredMarkerOff.merchant_id).toBeNull();
    expect(authoredMarkerOff.merchant_name).toBeNull();

    const detailOff = await request(app).get(`/api/v1/spots/${authoredSlug}`);
    expect(detailOff.status).toBe(200);
    expect(detailOff.body.data.marker_kind).toBe('spot');
    expect(detailOff.body.data.local_partner).toBeNull();

    const listFilterOff = await request(app).get('/api/v1/spots?local_partner=true');
    expect(listFilterOff.status).toBe(200);
    expect(listFilterOff.body.data).toEqual([]);

    // When MARKETPLACE_ENABLED = true
    (env as any).MARKETPLACE_ENABLED = true;

    const mapOn = await request(app).get(`/api/v1/spots/map?bbox=${bbox}&zoom=12`);
    expect(mapOn.status).toBe(200);
    const authoredMarkerOn = mapOn.body.data.markers.find((m: any) => m.id === authoredSpotId);
    const baseMarkerOn = mapOn.body.data.markers.find((m: any) => m.id === baseSpotId);
    expect(authoredMarkerOn.marker_kind).toBe('merchant');
    expect(authoredMarkerOn.is_local_partner).toBe(true);
    expect(authoredMarkerOn.merchant_id).toBe(merchantAId);
    expect(authoredMarkerOn.merchant_name).toBe('Kape Pangasinan Roasters');
    expect(baseMarkerOn.marker_kind).toBe('spot');
    expect(baseMarkerOn.is_local_partner).toBe(false);

    const detailOn = await request(app).get(`/api/v1/spots/${authoredSlug}`);
    expect(detailOn.status).toBe(200);
    expect(detailOn.body.data.marker_kind).toBe('merchant');
    expect(detailOn.body.data.local_partner).toMatchObject({
      merchant_id: merchantAId,
      name: 'Kape Pangasinan Roasters',
      category: 'Cafe',
      is_published: true,
    });

    const listFilterOn = await request(app).get('/api/v1/spots?local_partner=true');
    expect(listFilterOn.status).toBe(200);
    expect(listFilterOn.body.data.map((s: any) => s.id)).toEqual([authoredSpotId]);
  });

  test('quest upgrade via reviewed_quest_spot_bindings overrides spot/merchant to quest and reverts when drafted or inactive', async () => {
    (env as any).MARKETPLACE_ENABLED = true;
    const bbox = '119.5,15.5,121.0,16.5';
    const questId = `q-p122-${randomUUID().slice(0, 8)}`;

    await fixture.pool.query(
      `INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, reward_points, marker_code, is_active, status, is_test, author_id)
       VALUES ($1, 'Coffee Heritage Trail', 'Visit the historic baywalk cafe.', 'food_trade', 'Lingayen', 16.0250, 120.2310, 50, $3, true, 'published', false, $2)`,
      [questId, ownerAId, `MK-${questId.slice(-6).toUpperCase()}`],
    );
    await fixture.pool.query(
      `INSERT INTO reviewed_quest_spot_bindings (id, quest_id, spot_id, status, is_test)
       VALUES ($1, $2, $3, 'active', false)`,
      [randomUUID(), questId, authoredSpotId],
    );

    // Active published quest upgrades merchant pin to 'quest' while preserving is_local_partner
    const mapUpgraded = await request(app).get(`/api/v1/spots/map?bbox=${bbox}&zoom=12`);
    const upgraded = mapUpgraded.body.data.markers.find((m: any) => m.id === authoredSpotId);
    expect(upgraded.marker_kind).toBe('quest');
    expect(upgraded.is_local_partner).toBe(true);
    expect(upgraded.active_quest_count).toBe(1);
    expect(upgraded.active_quest_ids).toEqual([questId]);

    // Drafting the quest reverts cleanly to 'merchant'
    await fixture.pool.query(`UPDATE quests SET status = 'draft' WHERE id = $1`, [questId]);
    const mapDrafted = await request(app).get(`/api/v1/spots/map?bbox=${bbox}&zoom=12`);
    const drafted = mapDrafted.body.data.markers.find((m: any) => m.id === authoredSpotId);
    expect(drafted.marker_kind).toBe('merchant');
    expect(drafted.active_quest_count).toBe(0);

    // Re-publish then set is_active = FALSE -> also reverts cleanly to 'merchant'
    await fixture.pool.query(`UPDATE quests SET status = 'published', is_active = FALSE WHERE id = $1`, [questId]);
    const mapInactive = await request(app).get(`/api/v1/spots/map?bbox=${bbox}&zoom=12`);
    const inactive = mapInactive.body.data.markers.find((m: any) => m.id === authoredSpotId);
    expect(inactive.marker_kind).toBe('merchant');
    expect(inactive.active_quest_count).toBe(0);

    // Unlink merchant -> reverts to 'spot'
    const delRes = await request(app).delete('/api/v1/merchant/location').set('Authorization', `Bearer ${ownerAToken}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body.data.spot_id).toBeNull();

    const mapUnlinked = await request(app).get(`/api/v1/spots/map?bbox=${bbox}&zoom=12`);
    const unlinked = mapUnlinked.body.data.markers.find((m: any) => m.id === authoredSpotId);
    expect(unlinked.marker_kind).toBe('spot');
    expect(unlinked.is_local_partner).toBe(false);
  });

  test('claim workflow: submit, area-admin scope enforcement (403), approve links merchant & auto-rejects competing claims', async () => {
    (env as any).MARKETPLACE_ENABLED = true;

    // Owner B submits a claim on lguSpotId (in Lingayen / townA)
    const claimB = await request(app)
      .post('/api/v1/merchant/location/claim')
      .set('Authorization', `Bearer ${ownerBToken}`)
      .send({ spot_id: lguSpotId, note: 'Our crafts kiosk is officially located inside Lingayen Capitol Grounds.' });
    expect(claimB.status).toBe(201);
    const claimBId = claimB.body.data.id;

    // Duplicate pending claim from same merchant -> 409 CLAIM_ALREADY_PENDING
    const dupPending = await request(app)
      .post('/api/v1/merchant/location/claim')
      .set('Authorization', `Bearer ${ownerBToken}`)
      .send({ spot_id: baseSpotId, note: 'Attempting a second concurrent pending claim.' });
    expect(dupPending.status).toBe(409);
    expect(dupPending.body.error.code).toBe('CLAIM_ALREADY_PENDING');

    // Owner A also submits a competing claim for lguSpotId
    const claimA = await request(app)
      .post('/api/v1/merchant/location/claim')
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ spot_id: lguSpotId, note: 'Competing location claim for the capitol grounds.' });
    expect(claimA.status).toBe(201);
    const claimAId = claimA.body.data.id;

    // Area admin (scoped to Alaminos / townB) does NOT see Lingayen claims and gets 403 on review
    const areaList = await request(app)
      .get('/api/v1/admin/merchant-spot-claims?status=pending')
      .set('Authorization', `Bearer ${areaAdminToken}`);
    expect(areaList.status).toBe(200);
    expect(areaList.body.data.some((c: any) => c.id === claimBId)).toBe(false);

    const areaReview = await request(app)
      .post(`/api/v1/admin/merchant-spot-claims/${claimBId}/review`)
      .set('Authorization', `Bearer ${areaAdminToken}`)
      .send({ decision: 'approve', review_note: 'Trying outside scope' });
    expect(areaReview.status).toBe(403);
    expect(areaReview.body.error.code).toBe('AREA_SCOPE_FORBIDDEN');

    // Platform admin approves claimB -> links merchantB to lguSpotId & auto-rejects claimA
    const approveRes = await request(app)
      .post(`/api/v1/admin/merchant-spot-claims/${claimBId}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'approve', review_note: 'Verified DTI permit and storefront photo.' });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.data.status).toBe('approved');
    expect(approveRes.body.data.competing_rejected).toBe(1);

    const competingRow = (
      await fixture.pool.query(`SELECT status, review_note FROM merchant_spot_claim_requests WHERE id = $1`, [claimAId])
    ).rows[0];
    expect(competingRow.status).toBe('rejected');

    const linkedMerchant = (await fixture.pool.query(`SELECT spot_id FROM merchants WHERE id = $1`, [merchantBId]))
      .rows[0];
    expect(linkedMerchant.spot_id).toBe(lguSpotId);

    // Owner A can submit and cancel a new claim on baseSpotId
    const claimCancelTarget = await request(app)
      .post('/api/v1/merchant/location/claim')
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ spot_id: baseSpotId, note: 'Testing cancel flow for Alaminos Lucap Wharf.' });
    expect(claimCancelTarget.status).toBe(201);
    const cancelRes = await request(app)
      .delete(`/api/v1/merchant/location/claim/${claimCancelTarget.body.data.id}`)
      .set('Authorization', `Bearer ${ownerAToken}`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.status).toBe('cancelled');
  });
});
