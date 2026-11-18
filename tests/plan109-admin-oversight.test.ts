import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { FundingPlansService } from '../src/funding/plans.js';
import { SponsorshipService } from '../src/funding/sponsorships.js';
import { startFundedAttempt } from '../src/funding/holds.js';
import { MerchantPointsService } from '../src/funding/merchantPoints.js';
import { ensureAreaCache } from '../src/maps/areas-service.js';
import { spotStore } from '../src/spots/store.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
jest.setTimeout(180_000);

realPg('Plan 109: Admin funding oversight, crowd monitoring, controls & quizzes (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const adminId = `p109-admin-${randomUUID()}`;
  const areaAdminId = `p109-area-${randomUUID()}`;
  const authorId = `p109-author-${randomUUID()}`;
  const merchantOwnerId = `p109-mowner-${randomUUID()}`;
  const travelerId = `p109-trav-${randomUUID()}`;
  const merchantId = `p109-merch-${randomUUID()}`;

  const prevFunding = env.QUEST_FUNDING_ENABLED;

  const authHeader = (id: string, role = 'user') => ({
    Authorization: `Bearer ${jwt.sign({ id, seed_id: id, role, typ: 'session' }, env.JWT_SECRET, { expiresIn: '1h' })}`,
  });

  beforeAll(async () => {
    Reflect.set(env, 'QUEST_FUNDING_ENABLED', true);
    fixture = await createTestDb({ poolMax: 10 });
    setPool(fixture.pool);
    db.attachDurabilityPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    await spotStore.hydrateFromPg(fixture.pool);

    await fixture.pool.query(
      `INSERT INTO users(id, seed_id, display_name, email, role, admin_scope, demo_points, is_test) VALUES
       ($1::text, $1::text, 'Platform Admin 109', $1::text || '@example.test', 'admin', 'platform', 0, FALSE),
       ($2::text, $2::text, 'Area Admin 109', $2::text || '@example.test', 'area_admin', NULL, 0, FALSE),
       ($3::text, $3::text, 'Author 109', $3::text || '@example.test', 'user', NULL, 1000, FALSE),
       ($4::text, $4::text, 'Merchant Owner 109', $4::text || '@example.test', 'user', NULL, 0, FALSE),
       ($5::text, $5::text, 'Traveler 109', $5::text || '@example.test', 'user', NULL, 0, FALSE)`,
      [adminId, areaAdminId, authorId, merchantOwnerId, travelerId],
    );

    await fixture.pool.query(
      `INSERT INTO admin_areas(id, level, name, display_name, parent_id, has_boundary, label_lat, label_lng, bbox, min_zoom)
       VALUES
         ('province:p109-pang', 'province', 'Pangasinan', 'Pangasinan', NULL, TRUE, 16.0, 120.2, ARRAY[119.7, 15.7, 120.9, 16.5]::double precision[], 5),
         ('town:p109-dagupan', 'town', 'Dagupan City', 'Dagupan City, Pangasinan', 'province:p109-pang', TRUE, 16.0431, 120.3333, ARRAY[120.30, 16.01, 120.37, 16.08]::double precision[], 11),
         ('town:p109-bolinao', 'town', 'Bolinao', 'Bolinao, Pangasinan', 'province:p109-pang', TRUE, 16.386, 119.893, ARRAY[119.83, 16.30, 119.95, 16.43]::double precision[], 11)
       ON CONFLICT (id) DO NOTHING`,
    );
    await ensureAreaCache(fixture.pool);
    await fixture.pool.query(
      `INSERT INTO admin_area_assignments(id, user_id, area_id, powers, granted_by)
       VALUES ($1::uuid, $2, 'town:p109-dagupan', ARRAY['analytics','destinations','quests_quizzes']::text[], $3)`,
      [randomUUID(), areaAdminId, adminId],
    );

    await fixture.pool.query(
      `INSERT INTO merchants(id, name, location, description, category, municipality, status, is_published, is_test, town_area_id)
       VALUES ($1, 'Dagupan Milkfish Grill', 'Dagupan City', 'Fresh grilled bangus', 'Dining', 'Dagupan City', 'active', TRUE, FALSE, 'town:p109-dagupan')`,
      [merchantId],
    );
    await fixture.pool.query(
      `INSERT INTO merchant_memberships(id, merchant_id, user_id, role, status)
       VALUES ($1, $2, $3, 'owner', 'active')`,
      [randomUUID(), merchantId, merchantOwnerId],
    );
    await new MerchantPointsService(fixture.pool).adminAdjust(
      adminId,
      merchantId,
      2000,
      'Plan 109 initial test grant',
      randomUUID(),
    );
  });

  afterAll(async () => {
    Reflect.set(env, 'QUEST_FUNDING_ENABLED', prevFunding);
    await fixture?.close();
  });

  async function seedQuest(title: string) {
    const questId = `p109-q-${randomUUID()}`;
    const steps = [
      { step_order: 1, title: 'Arrive', description: 'Check in at spot', checkpoint_type: 'location', required: true },
    ];
    await fixture.pool.query(
      `INSERT INTO quests(id, title, description, category, location_name, gps_lat, gps_lng, radius_meters,
        reward_points, marker_code, marker_image_url, author_id, status, version, steps, is_active, is_test)
       VALUES($1, $2, 'Desc for quest', 'eco', 'Dagupan City', 16.04, 120.33, 100, 50, $3, '', $4, 'draft', 1, $5::jsonb, FALSE, FALSE)`,
      [questId, title, `mk-${questId}`, authorId, JSON.stringify(steps)],
    );
    return questId;
  }

  it('WP-1: treasury reconciles, transactions list matches ledger, hold release enforces expiry, cancel refunds', async () => {
    const plansSvc = new FundingPlansService(fixture.pool);
    const questId = await seedQuest('Plan 109 Treasury Quest');

    const plan = await plansSvc.create(
      authorId,
      questId,
      {
        mode: 'budget',
        planned_completions: 4,
        starts_at: new Date(Date.now() - 60_000).toISOString(),
        ends_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      },
      randomUUID(),
    );
    await plansSvc.contribute(authorId, plan.id, Number(plan.target_points), randomUUID());
    const activePlan = await plansSvc.submit(authorId, plan.id, randomUUID());
    expect(activePlan.status).toBe('active');

    // Start a funded attempt (creates a 53-pt hold: 50 reward + 3 fee)
    const started = await startFundedAttempt(fixture.pool, questId, travelerId);
    expect(started?.funding_hold.id).toBeTruthy();
    const holdId = started!.funding_hold.id;

    // Treasury reconciles cleanly
    const treasuryRes = await request(app)
      .get(`/api/v1/admin/funding-plans/${plan.id}/treasury`)
      .set(authHeader(adminId, 'admin'));
    expect(treasuryRes.status).toBe(200);
    expect(treasuryRes.body.data.reconciliation.ok).toBe(true);
    expect(treasuryRes.body.data.committed_points).toBe(212);
    expect(treasuryRes.body.data.held_points).toBe(53);
    expect(treasuryRes.body.data.available_points).toBe(159);
    expect(treasuryRes.body.data.live_holds_count).toBe(1);

    // Transactions list matches ledger rows and supports type filter
    const txRes = await request(app)
      .get(`/api/v1/admin/funding-plans/${plan.id}/transactions`)
      .set(authHeader(adminId, 'admin'));
    expect(txRes.status).toBe(200);
    const types = txRes.body.data.items.map((item: any) => item.type);
    expect(types).toContain('quest_fund_lock');
    expect(types).toContain('quest_fund_hold');

    const filteredTxRes = await request(app)
      .get(`/api/v1/admin/funding-plans/${plan.id}/transactions?type=quest_fund_hold`)
      .set(authHeader(adminId, 'admin'));
    expect(filteredTxRes.status).toBe(200);
    expect(filteredTxRes.body.data.items).toHaveLength(1);
    expect(filteredTxRes.body.data.items[0].points).toBe(53);

    // Active (non-expired) hold cannot be released by admin
    const activeReleaseRes = await request(app)
      .post(`/api/v1/admin/funding-holds/${holdId}/release`)
      .set(authHeader(adminId, 'admin'))
      .send({ reason: 'Should fail while active', idempotency_key: randomUUID() });
    expect(activeReleaseRes.status).toBe(409);
    expect(activeReleaseRes.body.error.code).toBe('HOLD_NOT_EXPIRED');

    // Expire hold, then admin release succeeds
    await fixture.pool.query("UPDATE quest_funding_holds SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [
      holdId,
    ]);
    const expiredReleaseRes = await request(app)
      .post(`/api/v1/admin/funding-holds/${holdId}/release`)
      .set(authHeader(adminId, 'admin'))
      .send({ reason: 'Expired hold cleanup', idempotency_key: randomUUID() });
    expect(expiredReleaseRes.status).toBe(200);
    expect(expiredReleaseRes.body.data.status).toBe('released');

    // Pause holds blocks new attempt, resume restores
    const pauseRes = await request(app)
      .post(`/api/v1/admin/funding-plans/${plan.id}/pause-holds`)
      .set(authHeader(adminId, 'admin'))
      .send({ reason: 'Reviewing activity', idempotency_key: randomUUID() });
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.data.holds_paused).toBe(true);
    await expect(startFundedAttempt(fixture.pool, questId, travelerId)).rejects.toMatchObject({
      code: 'FUNDING_HOLDS_PAUSED',
      status: 409,
    });

    const resumeRes = await request(app)
      .post(`/api/v1/admin/funding-plans/${plan.id}/resume-holds`)
      .set(authHeader(adminId, 'admin'))
      .send({ idempotency_key: randomUUID() });
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.data.holds_paused).toBe(false);

    // Admin flag + extend
    const flagRes = await request(app)
      .post(`/api/v1/admin/funding-plans/${plan.id}/flag`)
      .set(authHeader(adminId, 'admin'))
      .send({ flagged: true, note: 'Check sponsor terms', idempotency_key: randomUUID() });
    expect(flagRes.status).toBe(200);
    expect(flagRes.body.data.admin_flagged).toBe(true);

    // Admin cancel refunds a scheduled/pending_sponsors plan
    const cancelQuestId = await seedQuest('Plan 109 Cancel Refund Quest');
    const cancelPlan = await plansSvc.create(
      authorId,
      cancelQuestId,
      {
        mode: 'budget',
        planned_completions: 2,
        starts_at: new Date(Date.now() + 86_400_000).toISOString(),
        ends_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      },
      randomUUID(),
    );
    const beforeBal = Number(
      (await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1', [authorId])).rows[0].demo_points,
    );
    await plansSvc.contribute(authorId, cancelPlan.id, 105, randomUUID());
    const cancelRes = await request(app)
      .post(`/api/v1/admin/funding-plans/${cancelPlan.id}/cancel`)
      .set(authHeader(adminId, 'admin'))
      .send({ reason: 'Admin cancel refund test', idempotency_key: randomUUID() });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.status).toBe('cancelled');
    const afterBal = Number(
      (await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1', [authorId])).rows[0].demo_points,
    );
    expect(afterBal).toBe(beforeBal);
  });

  it('WP-1: merchant sponsoring suspension blocks accept and offer with 409 SPONSORING_SUSPENDED', async () => {
    const plansSvc = new FundingPlansService(fixture.pool);
    const sponsorSvc = new SponsorshipService(fixture.pool);
    const questId = await seedQuest('Plan 109 Sponsor Suspend Quest');

    const plan = await plansSvc.create(
      authorId,
      questId,
      {
        mode: 'budget',
        planned_completions: 4,
        starts_at: new Date(Date.now() - 60_000).toISOString(),
        ends_at: new Date(Date.now() + 4 * 86_400_000).toISOString(),
      },
      randomUUID(),
    );
    await plansSvc.submit(authorId, plan.id, randomUUID());

    const sp1 = await sponsorSvc.request(
      authorId,
      plan.id,
      merchantId,
      { points: 100, voucher_qty: 0, promo: false, message: 'Sponsor please' },
      randomUUID(),
    );

    // Suspend sponsoring
    const suspendRes = await request(app)
      .post(`/api/v1/admin/merchants/${merchantId}/sponsoring/suspend`)
      .set(authHeader(adminId, 'admin'))
      .send({ reason: 'Audit hold on sponsorships', idempotency_key: randomUUID() });
    expect(suspendRes.status).toBe(200);
    expect(suspendRes.body.data.sponsoring_suspended).toBe(true);

    // Merchant accept returns 409 SPONSORING_SUSPENDED
    const acceptRes = await request(app)
      .post(`/api/v1/sponsorships/${sp1.id}/accept`)
      .set(authHeader(merchantOwnerId, 'user'))
      .send({ terms_version: sp1.terms_version, idempotency_key: randomUUID() });
    expect(acceptRes.status).toBe(409);
    expect(acceptRes.body.error.code).toBe('SPONSORING_SUSPENDED');

    // Merchant counter (offer) returns 409 SPONSORING_SUSPENDED
    const counterRes = await request(app)
      .post(`/api/v1/sponsorships/${sp1.id}/counter`)
      .set(authHeader(merchantOwnerId, 'user'))
      .send({
        points: 150,
        voucher_qty: 0,
        promo: false,
        terms_version: sp1.terms_version,
        idempotency_key: randomUUID(),
      });
    expect(counterRes.status).toBe(409);
    expect(counterRes.body.error.code).toBe('SPONSORING_SUSPENDED');

    // Creator requesting suspended merchant returns 409 SPONSORING_SUSPENDED
    const reqRes = await request(app)
      .post(`/api/v1/funding-plans/${plan.id}/sponsorships`)
      .set(authHeader(authorId, 'user'))
      .send({ merchant_id: merchantId, points: 200, voucher_qty: 0, promo: false, idempotency_key: randomUUID() });
    expect(reqRes.status).toBe(409);
    expect(reqRes.body.error.code).toBe('SPONSORING_SUSPENDED');

    // A suspended merchant can still decline an open request.
    const declineRes = await request(app)
      .post(`/api/v1/sponsorships/${sp1.id}/decline`)
      .set(authHeader(merchantOwnerId, 'user'))
      .send({ idempotency_key: randomUUID() });
    expect(declineRes.status).toBe(200);
    expect(declineRes.body.data.status).toBe('declined');

    // Merchant funding list & detail endpoints report suspended status
    const mfList = await request(app).get('/api/v1/admin/merchant-funding').set(authHeader(adminId, 'admin'));
    expect(mfList.status).toBe(200);
    const mRow = mfList.body.data.items.find((r: any) => r.merchant_id === merchantId);
    expect(mRow?.sponsoring_suspended).toBe(true);

    const mfDetail = await request(app)
      .get(`/api/v1/admin/merchant-funding/${merchantId}`)
      .set(authHeader(adminId, 'admin'));
    expect(mfDetail.status).toBe(200);
    expect(mfDetail.body.data.merchant.balance_points).toBe(2000);

    // Resume sponsoring
    const resumeRes = await request(app)
      .post(`/api/v1/admin/merchants/${merchantId}/sponsoring/resume`)
      .set(authHeader(adminId, 'admin'))
      .send({ reason: 'Audit cleared', idempotency_key: randomUUID() });
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.data.sponsoring_suspended).toBe(false);
  });

  it('WP-2: crowd overview buckets in Manila time, scopes area admins, masks <3 buckets, and excludes test data by default', async () => {
    const dagupanSpotId = `p109-spot-dag-${randomUUID()}`;
    const bolinaoSpotId = `p109-spot-bol-${randomUUID()}`;
    const testSpotId = `p109-spot-test-${randomUUID()}`;
    const subId = `p109-sub-${randomUUID()}`;

    await fixture.pool.query(
      `INSERT INTO spots(id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng,
                         source_type, source_name, trust_level, status, crowd_capacity_band, town_area_id, is_test)
       VALUES
         ($1::text, $1::text, 'Dagupan Plaza', 'Town plaza', 'culture_heritage', 'Plaza', 'Dagupan City', 'Dagupan', 16.043, 120.333, 'editorial', 'Admin', 'lgu_verified', 'published', 'medium', 'town:p109-dagupan', FALSE),
         ($2::text, $2::text, 'Bolinao Falls', 'Scenic falls', 'nature', 'Waterfalls', 'Bolinao', 'Bolinao', 16.386, 119.893, 'editorial', 'Admin', 'lgu_verified', 'published', 'medium', 'town:p109-bolinao', FALSE),
         ($3::text, $3::text, 'QA Test Spot', 'Test spot', 'nature', 'Park', 'Dagupan City', 'Dagupan', 16.044, 120.334, 'editorial', 'Admin', 'lgu_verified', 'published', 'medium', 'town:p109-dagupan', TRUE)`,
      [dagupanSpotId, bolinaoSpotId, testSpotId],
    );

    const qId = await seedQuest('Plan 109 Crowd Quest');
    await fixture.pool.query(
      `INSERT INTO submissions(id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status)
       VALUES ($1::text, $1::text, $2::text, $3::text, 'MK', 16.043, 120.333, 5, 'approved')`,
      [subId, travelerId, qId],
    );
    // 2026-11-10T23:30:00Z -> 2026-11-11 07:30:00+08 (Manila next day!)
    await fixture.pool.query(
      `INSERT INTO verified_visits(id, user_id, spot_id, source_submission_id, occurred_at, is_test)
       VALUES ($1::uuid, $2, $3, $4, '2026-11-10T23:30:00Z', FALSE)`,
      [randomUUID(), travelerId, dagupanSpotId, subId],
    );

    // Also add 1 activity event on Bolinao spot and 1 on QA test spot
    await fixture.pool.query(
      `INSERT INTO spot_activity_events(id, user_id, spot_id, activity_type, created_at, is_test)
       VALUES
         ($1, $2, $3, 'view', '2026-11-11T04:00:00Z', FALSE),
         ($4, $2, $5, 'visit', '2026-11-11T04:00:00Z', TRUE)`,
      [randomUUID(), travelerId, bolinaoSpotId, randomUUID(), testSpotId],
    );

    // Platform admin overview (test excluded by default)
    const platRes = await request(app)
      .get('/api/v1/admin/crowd/overview?from=2026-11-10&to=2026-11-12&granularity=day')
      .set(authHeader(adminId, 'admin'));
    expect(platRes.status).toBe(200);
    expect(platRes.body.data.kpis.verified_visits).toBe(1);
    const manilaBucket = platRes.body.data.timeseries.find((b: any) => b.bucket === '2026-11-11');
    expect(manilaBucket?.verified_visits).toBe(1);
    expect(platRes.body.data.timeseries.find((b: any) => b.bucket === '2026-11-10')).toBeUndefined();
    expect(platRes.body.data.top_destinations.some((d: any) => d.spot_id === testSpotId)).toBe(false);
    expect(platRes.body.data.top_destinations.some((d: any) => d.spot_id === bolinaoSpotId)).toBe(true);

    // Platform admin with include_test=true sees test spot
    const platTestRes = await request(app)
      .get('/api/v1/admin/crowd/overview?from=2026-11-10&to=2026-11-12&include_test=true')
      .set(authHeader(adminId, 'admin'));
    expect(platTestRes.status).toBe(200);
    expect(platTestRes.body.data.top_destinations.some((d: any) => d.spot_id === testSpotId)).toBe(true);

    // Area admin sees only Dagupan spot, and small counts (<3) are masked as '<3'
    const areaRes = await request(app)
      .get('/api/v1/admin/crowd/overview?from=2026-11-10&to=2026-11-12&include_test=true')
      .set(authHeader(areaAdminId, 'area_admin'));
    expect(areaRes.status).toBe(200);
    expect(areaRes.body.data.privacy_masked).toBe(true);
    expect(areaRes.body.data.kpis.verified_visits).toBe('<3');
    expect(areaRes.body.data.top_destinations.map((d: any) => d.spot_id)).toEqual([dagupanSpotId]);

    // Area admin cannot drill into out-of-scope Bolinao spot
    const outRes = await request(app)
      .get(`/api/v1/admin/crowd/spots/${bolinaoSpotId}?from=2026-11-10&to=2026-11-12`)
      .set(authHeader(areaAdminId, 'area_admin'));
    expect(outRes.status).toBe(404);

    // Heatmap returns 7x24 = 168 cells
    const hmRes = await request(app)
      .get('/api/v1/admin/crowd/heatmap?from=2026-11-10&to=2026-11-12')
      .set(authHeader(adminId, 'admin'));
    expect(hmRes.status).toBe(200);
    expect(hmRes.body.data.cells).toHaveLength(168);
  });

  it('WP-4: temporary spot suppression auto-unsuppresses, quest feature/bulk-pause work, and submissions bulk-review works', async () => {
    const wp4SpotId = `p109-wp4-spot-${randomUUID()}`;
    const wp4QuestA = `p109-wp4-qa-${randomUUID()}`;
    const wp4QuestB = `p109-wp4-qb-${randomUUID()}`;

    await fixture.pool.query(
      `INSERT INTO quests(id, title, description, category, location_name, gps_lat, gps_lng, radius_meters,
        reward_points, marker_code, marker_image_url, author_id, status, version, steps, is_active, is_featured, is_test)
       VALUES
        ($1, 'Alpha Non-Featured', 'Desc', 'eco', 'Dagupan Pier', 16.04, 120.33, 100, 20, $3, '', $4, 'published', 1, '[]'::jsonb, TRUE, FALSE, FALSE),
        ($2, 'Beta To Feature', 'Desc', 'eco', 'Dagupan Pier', 16.04, 120.33, 100, 20, $5, '', $4, 'published', 1, '[]'::jsonb, TRUE, FALSE, FALSE)`,
      [wp4QuestA, wp4QuestB, `mk-${wp4QuestA}`, authorId, `mk-${wp4QuestB}`],
    );
    await fixture.pool.query(
      `INSERT INTO spots(id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng,
                         source_type, source_name, trust_level, status, crowd_capacity_band, quest_id, town_area_id, is_test)
       VALUES
        ($1::text, $1::text, 'Dagupan Pier', 'Pier', 'nature', 'Park', 'Dagupan City', 'Dagupan', 16.04, 120.33, 'editorial', 'Admin', 'lgu_verified', 'published', 'medium', $2, 'town:p109-dagupan', FALSE)`,
      [wp4SpotId, wp4QuestA],
    );
    const subA = `p109-wp4-subA-${randomUUID()}`;
    const subB = `p109-wp4-subB-${randomUUID()}`;
    await fixture.pool.query(
      `INSERT INTO submissions(id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status)
       VALUES
        ($1::text, $1::text, $3::text, $4::text, $5, 16.04, 120.33, 5, 'pending'),
        ($2::text, $2::text, $6::text, $7::text, $8, 16.04, 120.33, 5, 'pending')`,
      [subA, subB, travelerId, wp4QuestA, `mk-${wp4QuestA}`, areaAdminId, wp4QuestB, `mk-${wp4QuestB}`],
    );

    await spotStore.hydrateFromPg(fixture.pool);
    await db.hydrateFromPg(fixture.pool);

    // 1. Spot temporary suppression with past expiry auto-unsuppresses
    const futureRes = await request(app)
      .patch(`/api/v1/admin/spots/${wp4SpotId}`)
      .set(authHeader(adminId, 'admin'))
      .send({ status: 'published', crowd_capacity_band: 'high', recommendation_suppressed: true, suppress_hours: 4 });
    expect(futureRes.status).toBe(200);
    expect(futureRes.body.data.crowd_capacity_band).toBe('high');
    expect(futureRes.body.data.recommendation_suppressed).toBe(true);
    expect(futureRes.body.data.recommendation_suppressed_until).toBeTruthy();

    const expiredIso = new Date(Date.now() - 60_000).toISOString();
    const pastRes = await request(app)
      .patch(`/api/v1/admin/spots/${wp4SpotId}`)
      .set(authHeader(adminId, 'admin'))
      .send({
        status: 'published',
        crowd_capacity_band: 'low',
        recommendation_suppressed: true,
        recommendation_suppressed_until: expiredIso,
      });
    expect(pastRes.status).toBe(200);

    const listSpots = await request(app).get('/api/v1/admin/spots').set(authHeader(adminId, 'admin'));
    const reloaded = listSpots.body.data.find((s: any) => s.id === wp4SpotId);
    expect(reloaded.recommendation_suppressed).toBe(false);
    expect(reloaded.recommendation_suppressed_until).toBeNull();
    expect(reloaded.crowd_capacity_band).toBe('low');

    // 2. Quest feature pins to top of /api/v1/quests
    const featRes = await request(app)
      .post(`/api/v1/admin/quests/${wp4QuestB}/feature`)
      .set(authHeader(adminId, 'admin'))
      .send({ featured: true });
    expect(featRes.status).toBe(200);
    expect(featRes.body.data.is_featured).toBe(true);

    const pubQuests = await request(app).get('/api/v1/quests');
    expect(pubQuests.status).toBe(200);
    const idxB = pubQuests.body.data.findIndex((q: any) => q.id === wp4QuestB);
    const idxA = pubQuests.body.data.findIndex((q: any) => q.id === wp4QuestA);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeGreaterThan(idxB);

    // 3. Bulk pause quests by destination
    const bulkPauseRes = await request(app)
      .post('/api/v1/admin/quests/bulk-pause')
      .set(authHeader(areaAdminId, 'area_admin'))
      .send({ destination_id: wp4SpotId, reason: 'Overcrowding hold' });
    expect(bulkPauseRes.status).toBe(200);
    expect(bulkPauseRes.body.data.paused_ids).toEqual(expect.arrayContaining([wp4QuestA, wp4QuestB]));

    // 4. Bulk review submissions (reject requires reason; bulk approve updates pending rows)
    const badBulk = await request(app)
      .post('/api/v1/admin/submissions/bulk-review')
      .set(authHeader(adminId, 'admin'))
      .send({ ids: [subA], action: 'reject' });
    expect(badBulk.status).toBe(400);

    const bulkApprove = await request(app)
      .post('/api/v1/admin/submissions/bulk-review')
      .set(authHeader(adminId, 'admin'))
      .send({ ids: [subA, subB], action: 'approve' });
    expect(bulkApprove.status).toBe(200);
    expect(bulkApprove.body.data.updated_ids).toEqual(expect.arrayContaining([subA, subB]));
  });

  it('WP-5: mobile app overview aggregates builds/push/preferences and app_version reflects settings', async () => {
    await fixture.pool.query(
      `INSERT INTO user_devices(id, user_id, token, platform, app_build, last_seen_at)
       VALUES
        ($1, $3, $1 || '_token_placeholder_123456', 'android', 5, NOW()),
        ($2, $4, $2 || '_token_placeholder_123456', 'android', 3, NOW() - INTERVAL '15 days')`,
      [`dev-a-${randomUUID()}`, `dev-b-${randomUUID()}`, travelerId, authorId],
    );
    await fixture.pool.query(
      `INSERT INTO user_notification_preferences(user_id, push_overtaken, push_friend_activity, push_social, push_weekly_recap, quiet_hours)
       VALUES ($1, TRUE, FALSE, TRUE, TRUE, TRUE)
       ON CONFLICT (user_id) DO NOTHING`,
      [travelerId],
    );
    await fixture.pool.query(
      `INSERT INTO push_deliveries(id, user_id, category, collapse_key, title, body, href, status, is_test)
       VALUES
        ($1, $3, 'social', 'k1', 'Hi', 'Cheer', '/plaza', 'sent', FALSE),
        ($2, $3, 'social', 'k2', 'Hi', 'Cheer', '/plaza', 'failed', FALSE)`,
      [`push-a-${randomUUID()}`, `push-b-${randomUUID()}`, travelerId],
    );

    const ovBefore = await request(app).get('/api/v1/admin/mobile-app/overview').set(authHeader(adminId, 'admin'));
    expect(ovBefore.status).toBe(200);
    expect(ovBefore.body.data.devices.total_registered).toBeGreaterThanOrEqual(2);
    expect(ovBefore.body.data.devices.active_7d).toBeGreaterThanOrEqual(1);
    expect(ovBefore.body.data.push_7d.totals.sent).toBeGreaterThanOrEqual(1);
    expect(ovBefore.body.data.push_7d.totals.failed).toBeGreaterThanOrEqual(1);
    expect(ovBefore.body.data.notification_preferences.total_profiles).toBeGreaterThanOrEqual(1);

    // Update min supported build and announcement banner through optimistic concurrency settings API
    const rev = ovBefore.body.data.settings.revision;
    const futureUntil = new Date(Date.now() + 86_400_000).toISOString();
    const putRes = await request(app)
      .put('/api/v1/admin/settings')
      .set(authHeader(adminId, 'admin'))
      .send({
        expected_revision: rev,
        reason: 'WP-5 release floor and maintenance banner',
        changes: {
          app_min_supported_build: 4,
          app_announcement_text: 'Maintenance tonight 11 PM PHT',
          app_announcement_severity: 'warning',
          app_announcement_until: futureUntil,
        },
      });
    expect(putRes.status).toBe(200);

    const verRes = await request(app).get('/api/v1/app/version');
    expect(verRes.status).toBe(200);
    expect(verRes.body.data.min_supported_build).toBe(4);
    expect(verRes.body.data.announcement).toEqual({
      text: 'Maintenance tonight 11 PM PHT',
      severity: 'warning',
      until: futureUntil,
    });

    // Area admins cannot read mobile-app overview
    const areaDenied = await request(app)
      .get('/api/v1/admin/mobile-app/overview')
      .set(authHeader(areaAdminId, 'area_admin'));
    expect(areaDenied.status).toBe(403);
  });

  it('WP-6: crowd suggestions detect busy_now and proof_anomaly with Apply actions and 24h dismiss', async () => {
    const busySpotId = `p109-wp6-spot-${randomUUID()}`;
    const anomalyQuestId = `p109-wp6-q-${randomUUID()}`;
    await fixture.pool.query(
      `INSERT INTO quests(id, title, description, category, location_name, gps_lat, gps_lng, radius_meters,
        reward_points, marker_code, marker_image_url, author_id, status, version, steps, is_active, is_test)
       VALUES ($1, 'WP6 Crowd Quest', 'Desc', 'eco', 'Dagupan Market', 16.04, 120.33, 100, 20, $2, '', $3, 'published', 1, '[]'::jsonb, TRUE, FALSE)`,
      [anomalyQuestId, `mk-${anomalyQuestId}`, authorId],
    );
    await fixture.pool.query(
      `INSERT INTO spots(id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng,
                         source_type, source_name, trust_level, status, crowd_capacity_band, quest_id, town_area_id, is_test)
       VALUES ($1::text, $1::text, 'Dagupan Market', 'Market', 'nature', 'Park', 'Dagupan City', 'Dagupan', 16.04, 120.33, 'editorial', 'Admin', 'lgu_verified', 'published', 'low', $2, 'town:p109-dagupan', FALSE)`,
      [busySpotId, anomalyQuestId],
    );

    // Seed pressure >= 8 across 2 distinct consecutive Manila hours inside the last 3h window
    // Use NOW() - 125 min and NOW() - 65 min so they are strictly in two consecutive clock hours inside 3h.
    for (const offsetSql of [`NOW() - INTERVAL '125 minutes'`, `NOW() - INTERVAL '65 minutes'`]) {
      await fixture.pool.query(
        `INSERT INTO spot_activity_events(id, user_id, spot_id, activity_type, created_at, is_test)
         VALUES
           ($1, $3, $4, 'visit', ${offsetSql}, FALSE),
           ($2, $3, $4, 'directions', ${offsetSql}, FALSE)`,
        [randomUUID(), randomUUID(), travelerId, busySpotId],
      );
    }

    // Seed 3 submissions from same account (2 rejected + 1 pending) -> proof_anomaly
    const statuses = ['rejected', 'rejected', 'pending'];
    for (let i = 0; i < 3; i += 1) {
      const sId = `p109-wp6-sub-${i}-${randomUUID()}`;
      await fixture.pool.query(
        `INSERT INTO submissions(id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status)
         VALUES ($1::text, $1::text, $2::text, $3::text, $4, 16.04, 120.33, 5, $5)`,
        [sId, travelerId, anomalyQuestId, `mk-${anomalyQuestId}`, statuses[i]],
      );
    }

    const sugRes = await request(app)
      .get(`/api/v1/admin/crowd/suggestions?spot_id=${busySpotId}`)
      .set(authHeader(areaAdminId, 'area_admin'));
    expect(sugRes.status).toBe(200);
    const keys = sugRes.body.data.suggestions.map((s: any) => s.suggestion_key);
    expect(keys).toContain('busy_now');
    expect(keys).toContain('proof_anomaly');

    const busySug = sugRes.body.data.suggestions.find((s: any) => s.suggestion_key === 'busy_now');
    expect(busySug.actions.some((a: any) => a.path?.includes(`/admin/spots/${busySpotId}`))).toBe(true);

    // Dismiss proof_anomaly for 24h
    const disRes = await request(app)
      .post('/api/v1/admin/crowd/suggestions/dismiss')
      .set(authHeader(areaAdminId, 'area_admin'))
      .send({ spot_id: busySpotId, suggestion_key: 'proof_anomaly' });
    expect(disRes.status).toBe(200);
    expect(disRes.body.data.suggestion_key).toBe('proof_anomaly');

    const afterDismiss = await request(app)
      .get(`/api/v1/admin/crowd/suggestions?spot_id=${busySpotId}`)
      .set(authHeader(areaAdminId, 'area_admin'));
    expect(afterDismiss.body.data.suggestions.map((s: any) => s.suggestion_key)).not.toContain('proof_anomaly');
  });

  it('WP-7: allows creating, publishing, starting, and grading a 1-question quiz', async () => {
    const spotId = `p109-wp7-spot-${randomUUID()}`;
    await fixture.pool.query(
      `INSERT INTO spots(id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng,
                         source_type, source_name, trust_level, status, town_area_id, is_test)
       VALUES ($1::text, $1::text, 'Lingayen Capitol Quiz Spot', 'Spot', 'culture_heritage', 'Heritage', 'Dagupan City', 'Dagupan', 16.04, 120.33, 'editorial', 'Admin', 'lgu_verified', 'published', 'town:p109-dagupan', FALSE)`,
      [spotId],
    );

    const createRes = await request(app)
      .post('/api/v1/admin/quizzes')
      .set(authHeader(adminId, 'admin'))
      .send({
        destination_id: spotId,
        title: 'One Question Heritage Quiz',
        description: 'Testing a minimal single-question cultural quiz end to end.',
        language: 'en',
        radius_meters: 300,
        xp_reward: 35,
        time_limit_minutes: 15,
        cooldown_hours: 12,
        questions: [
          {
            ordinal: 1,
            question_type: 'multiple_choice',
            question_text: 'Where is the capitol located?',
            explanation: 'It sits beside Lingayen Gulf.',
            options: [
              { ordinal: 1, option_text: 'Lingayen', is_correct: true },
              { ordinal: 2, option_text: 'Vigan', is_correct: false },
              { ordinal: 3, option_text: 'Baguio', is_correct: false },
              { ordinal: 4, option_text: 'Iloilo', is_correct: false },
            ],
          },
        ],
      });
    expect(createRes.status).toBe(201);
    const quizId = createRes.body.data.quiz.id;

    const pubRes = await request(app).post(`/api/v1/admin/quizzes/${quizId}/publish`).set(authHeader(adminId, 'admin'));
    expect(pubRes.status).toBe(200);

    const startRes = await request(app)
      .post(`/api/v1/quizzes/${quizId}/attempts`)
      .set(authHeader(travelerId, 'user'))
      .send({ lat: 16.04, lng: 120.33 });
    expect(startRes.status).toBe(201);
    const attemptId = startRes.body.data.attempt.id;
    const questions = startRes.body.data.questions;
    expect(questions).toHaveLength(1);

    const rightOpt = questions[0].options.find((o: any) => o.option_text === 'Lingayen');
    expect(rightOpt).toBeTruthy();

    const submitRes = await request(app)
      .put(`/api/v1/quiz-attempts/${attemptId}/submission`)
      .set(authHeader(travelerId, 'user'))
      .send({
        answers: [{ question_id: questions[0].id, selected_option_id: rightOpt.id }],
      });
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.data.passed).toBe(true);
    expect(submitRes.body.data.score).toBe(1);
    expect(submitRes.body.data.total_questions).toBe(1);
    expect(submitRes.body.data.xp_awarded).toBeGreaterThanOrEqual(35);
  });
});
