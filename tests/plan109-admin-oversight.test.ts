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
});
