import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { FundingPlansService } from '../src/funding/plans.js';
import { MerchantPointsService } from '../src/funding/merchantPoints.js';
import { publicFundingSummaries } from '../src/funding/readModel.js';
import { SponsorshipService, evaluateConditions } from '../src/funding/sponsorships.js';
import { spotStore } from '../src/spots/store.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('Plan 108: sponsorship conditions and Sponsored by (disposable PostgreSQL)', () => {
  let fixture: TestDbInstance;
  let plans: FundingPlansService;
  let sponsors: SponsorshipService;
  let merchantPoints: MerchantPointsService;
  const originalFlag = env.QUEST_FUNDING_ENABLED;

  const token = (id: string, role = 'user') =>
    `Bearer ${jwt.sign({ id, seed_id: id, role, typ: 'session' }, env.JWT_SECRET)}`;

  async function createUser(id: string, { points = 0, emailVerified = true, isTest = false } = {}) {
    await fixture.pool.query(
      'INSERT INTO users(id,seed_id,display_name,email,role,demo_points,is_test) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id, id, id, `${id}@example.test`, 'user', points, isTest],
    );
    await fixture.pool.query(
      `INSERT INTO account_emails(id,user_id,email,normalized_email,is_verified,is_primary)
       VALUES($1,$2,$3,$4,$5,TRUE)`,
      [`ae-${id}`, id, `${id}@example.test`, `${id}@example.test`, emailVerified],
    );
    db.users.push({
      id,
      seed_id: id,
      display_name: id,
      email: `${id}@example.test`,
      role: 'user',
      demo_points: points,
      is_test: isTest,
    } as any);
  }

  async function seedMerchant({
    id,
    ownerId,
    name = 'Shop',
    municipality = 'Dagupan',
    gpsLat = null as number | null,
    gpsLng = null as number | null,
    townAreaId = null as string | null,
  }) {
    let appId: string | null = null;
    if (gpsLat !== null || gpsLng !== null) {
      appId = `app-${id}`;
      await fixture.pool.query(
        `INSERT INTO merchant_affiliate_applications
          (id,user_id,business_name,category,municipality,contact_name,contact_email,contact_phone,sponsorship_goals,proposal_details,status,gps_lat,gps_lng)
         VALUES($1,$2,$3,'cafe',$4,'Owner','owner@shop.test','09170000000','[]'::jsonb,'Local shop','approved',$5,$6)`,
        [appId, ownerId, name, municipality, gpsLat, gpsLng],
      );
    }
    await fixture.pool.query(
      `INSERT INTO merchants(id,name,location,description,status,is_published,municipality,town_area_id,source_application_id,is_test)
       VALUES($1,$2,$3,'Local partner','active',TRUE,$4,$5,$6,FALSE)`,
      [id, name, municipality, municipality, townAreaId, appId],
    );
    await fixture.pool.query(
      "INSERT INTO merchant_memberships(id,merchant_id,user_id,role,status) VALUES($1,$2,$3,'owner','active')",
      [randomUUID(), id, ownerId],
    );
    await merchantPoints.purchase(ownerId, id, 500, randomUUID());
  }

  async function seedQuestAndPlan({
    suffix,
    authorId,
    spotLat = 16.0433,
    spotLng = 120.3333,
    spotMunicipality = 'Dagupan City',
    spotStatus = 'published',
    steps,
  }: {
    suffix: string;
    authorId: string;
    spotLat?: number;
    spotLng?: number;
    spotMunicipality?: string;
    spotStatus?: string;
    steps?: any[];
  }) {
    const questId = `q-${suffix}`;
    const spotId = `spot-${suffix}`;
    const questSteps = steps ?? [
      { step_order: 1, title: 'Arrive', description: 'Visit', checkpoint_type: 'location', required: true },
    ];
    await fixture.pool.query(
      `INSERT INTO quests(id,title,description,category,location_name,gps_lat,gps_lng,radius_meters,reward_points,marker_code,marker_image_url,author_id,status,version,steps,is_active,is_test)
       VALUES($1,$2,'Desc','eco',$3,$4,$5,100,50,$6,'',$7,'draft',1,$8::jsonb,false,false)`,
      [
        questId,
        `Quest ${suffix}`,
        spotMunicipality,
        spotLat,
        spotLng,
        `marker-${suffix}`,
        authorId,
        JSON.stringify(questSteps),
      ],
    );
    await fixture.pool.query(
      `INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,source_type,source_name,status,quest_id,created_by,is_test)
       VALUES($1,$2,$3,'Desc','Heritage','Landmark',$4,$5,$6,$7,'community','Author',$8,$9,$10,false)`,
      [
        spotId,
        spotId,
        `Spot ${suffix}`,
        spotMunicipality,
        spotMunicipality,
        spotLat,
        spotLng,
        spotStatus,
        questId,
        authorId,
      ],
    );
    const plan = await plans.create(
      authorId,
      questId,
      {
        mode: 'budget',
        planned_completions: 2,
        starts_at: new Date(Date.now() - 60_000).toISOString(),
        ends_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      },
      randomUUID(),
    );
    await plans.contribute(authorId, plan.id, 53, randomUUID());
    await plans.submit(authorId, plan.id, randomUUID());
    return { questId, spotId, planId: plan.id };
  }

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    env.QUEST_FUNDING_ENABLED = true;
    plans = new FundingPlansService(fixture.pool);
    sponsors = new SponsorshipService(fixture.pool);
    merchantPoints = new MerchantPointsService(fixture.pool);
  });

  afterAll(async () => {
    env.QUEST_FUNDING_ENABLED = originalFlag;
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  });

  it('has 098_sponsorship_conditions.sql registered in the migration ledger', async () => {
    expect(MIGRATIONS).toContain('098_sponsorship_conditions.sql');
    const ledger = await fixture.pool.query(
      "SELECT filename FROM schema_migrations WHERE filename = '098_sponsorship_conditions.sql'",
    );
    expect(ledger.rowCount).toBe(1);
  });

  it('evaluates all four condition types (met, unmet, and unknown when shop has no GPS)', async () => {
    const suffix = randomUUID().slice(0, 8);
    const authorId = `author-${suffix}`;
    const p1Id = `player1-${suffix}`;
    const p2Id = `player2-${suffix}`;
    const testPlayerId = `testplayer-${suffix}`;
    const ownerSame = `owner-same-${suffix}`;
    const ownerOther = `owner-other-${suffix}`;
    await createUser(authorId, { points: 500, emailVerified: true });
    await createUser(p1Id);
    await createUser(p2Id);
    await createUser(testPlayerId, { isTest: true });
    await createUser(ownerSame);
    await createUser(ownerOther);

    await fixture.pool.query(
      `INSERT INTO admin_areas(id,level,name,display_name,has_boundary,label_lat,label_lng,bbox)
       VALUES($1,'town','Dagupan City','Dagupan City, Pangasinan',FALSE,16.0433,120.3333,ARRAY[120.3,16.0,120.4,16.1])
       ON CONFLICT(id) DO NOTHING`,
      ['town-dagupan'],
    );
    await seedMerchant({
      id: `m-same-${suffix}`,
      ownerId: ownerSame,
      name: 'Dagupan Roasters',
      municipality: 'Dagupan',
      townAreaId: 'town-dagupan',
      gpsLat: 16.0434,
      gpsLng: 120.3334,
    });
    await seedMerchant({
      id: `m-other-${suffix}`,
      ownerId: ownerOther,
      name: 'Calasiao Bakery',
      municipality: 'Calasiao',
      gpsLat: null,
      gpsLng: null,
    });

    const { questId, spotId, planId } = await seedQuestAndPlan({
      suffix,
      authorId,
      spotLat: 16.0433,
      spotLng: 120.3333,
      spotMunicipality: 'Dagupan',
    });

    await fixture.pool.query(
      `INSERT INTO quest_attempts(id,quest_id,user_id,status,completed_at)
       VALUES($1,$2,$3,'completed',NOW()),($4,$2,$5,'completed',NOW()),($6,$2,$7,'completed',NOW())`,
      [`att1-${suffix}`, questId, p1Id, `att2-${suffix}`, p2Id, `att3-${suffix}`, testPlayerId],
    );

    const allConditions = [
      { type: 'same_town' },
      { type: 'visits_shop' },
      { type: 'min_players', value: 2 },
      { type: 'creator_good_standing' },
    ];
    const sSame = await sponsors.request(
      authorId,
      planId,
      `m-same-${suffix}`,
      { points: 53, voucher_id: null, voucher_qty: 0, promo: false },
      randomUUID(),
    );
    await fixture.pool.query('UPDATE quest_sponsorships SET conditions=$2::jsonb WHERE id=$1', [
      sSame.id,
      JSON.stringify(allConditions),
    ]);
    const metList = await evaluateConditions(fixture.pool, {
      plan_id: planId,
      merchant_id: `m-same-${suffix}`,
      requested_by: authorId,
      conditions: allConditions,
    });
    expect(metList).toEqual([
      expect.objectContaining({ type: 'same_town', met: true }),
      expect.objectContaining({ type: 'visits_shop', met: true }),
      expect.objectContaining({ type: 'min_players', value: 2, met: true, detail: '2 of 2 players' }),
      expect.objectContaining({ type: 'creator_good_standing', met: true }),
    ]);

    const sOther = await sponsors.request(
      authorId,
      planId,
      `m-other-${suffix}`,
      { points: 53, voucher_id: null, voucher_qty: 0, promo: false },
      randomUUID(),
    );
    const unmetConds = [
      { type: 'same_town' },
      { type: 'visits_shop' },
      { type: 'min_players', value: 5 },
      { type: 'creator_good_standing' },
    ];
    await fixture.pool.query('UPDATE spots SET status=$2 WHERE id=$1', [spotId, 'held']);
    await fixture.pool.query('UPDATE account_emails SET is_verified=FALSE WHERE user_id=$1', [authorId]);
    const unmetList = await evaluateConditions(fixture.pool, {
      plan_id: planId,
      merchant_id: sOther.merchant_id,
      requested_by: authorId,
      conditions: unmetConds,
    });
    expect(unmetList).toEqual([
      expect.objectContaining({ type: 'same_town', met: false }),
      expect.objectContaining({ type: 'visits_shop', met: 'unknown' }),
      expect.objectContaining({ type: 'min_players', value: 5, met: false, detail: '2 of 5 players' }),
      expect.objectContaining({ type: 'creator_good_standing', met: false }),
    ]);
  });

  it('enforces unmet conditions with 409 unless merchant overrides with acknowledge_unmet and records audit', async () => {
    const suffix = randomUUID().slice(0, 8);
    const authorId = `au-${suffix}`;
    const ownerId = `ow-${suffix}`;
    await createUser(authorId, { points: 500, emailVerified: true });
    await createUser(ownerId);
    await seedMerchant({ id: `m-${suffix}`, ownerId, name: 'Far Shop', municipality: 'Calasiao' });
    const { planId } = await seedQuestAndPlan({ suffix, authorId, spotMunicipality: 'Bolinao' });

    const reqRow = await sponsors.request(
      authorId,
      planId,
      `m-${suffix}`,
      { points: 53, voucher_id: null, voucher_qty: 0, promo: false },
      randomUUID(),
    );

    // Creator cannot call PUT /conditions -> 403
    const creatorPut = await request(app)
      .put(`/api/v1/sponsorships/${reqRow.id}/conditions`)
      .set('Authorization', token(authorId))
      .send({ conditions: [{ type: 'same_town' }] });
    expect(creatorPut.status).toBe(403);

    // Merchant owner sets same_town + min_players=5
    const merchantPut = await request(app)
      .put(`/api/v1/sponsorships/${reqRow.id}/conditions`)
      .set('Authorization', token(ownerId))
      .send({ conditions: [{ type: 'same_town' }, { type: 'min_players', value: 5 }] });
    expect(merchantPut.status).toBe(200);
    expect(merchantPut.body.data.conditions).toHaveLength(2);

    // Creator's funding plan view also returns evaluated conditions
    const creatorPlanRes = await request(app)
      .get(`/api/v1/funding-plans/${planId}`)
      .set('Authorization', token(authorId));
    expect(creatorPlanRes.status).toBe(200);
    expect(creatorPlanRes.body.data.sponsorships[0].conditions).toEqual([
      expect.objectContaining({ type: 'same_town', met: false }),
      expect.objectContaining({ type: 'min_players', value: 5, met: false }),
    ]);

    // Accept without acknowledge_unmet -> 409 CONDITIONS_NOT_MET + data.conditions, nothing changed
    const blockedRes = await request(app)
      .post(`/api/v1/sponsorships/${reqRow.id}/accept`)
      .set('Authorization', token(ownerId))
      .send({ terms_version: reqRow.terms_version, idempotency_key: randomUUID() });
    expect(blockedRes.status).toBe(409);
    expect(blockedRes.body.error.code).toBe('CONDITIONS_NOT_MET');
    expect(blockedRes.body.data.conditions).toHaveLength(2);

    const rowAfterBlocked = (await fixture.pool.query('SELECT status FROM quest_sponsorships WHERE id=$1', [reqRow.id]))
      .rows[0];
    expect(rowAfterBlocked.status).toBe('requested');

    // Accept WITH acknowledge_unmet: true -> 200, stores accepted_with_unmet + override audit
    const overrideRes = await request(app)
      .post(`/api/v1/sponsorships/${reqRow.id}/accept`)
      .set('Authorization', token(ownerId))
      .send({ terms_version: reqRow.terms_version, idempotency_key: randomUUID(), acknowledge_unmet: true });
    expect(overrideRes.status).toBe(200);
    expect(overrideRes.body.data.status).toBe('accepted');
    expect(overrideRes.body.data.accepted_with_unmet).toHaveLength(2);
    expect(overrideRes.body.data.override_acknowledged_at).toBeTruthy();

    const auditRow = (
      await fixture.pool.query(
        "SELECT metadata FROM governance_audit WHERE action='sponsorship.accept' AND subject_id=$1 ORDER BY created_at DESC LIMIT 1",
        [reqRow.id],
      )
    ).rows[0];
    expect(auditRow.metadata.override).toBe(true);
  });

  it('rejects invalid conditions on counter with 400 and blocks creator accept-counter when unmet (no override)', async () => {
    const suffix = randomUUID().slice(0, 8);
    const authorId = `ac-au-${suffix}`;
    const ownerId = `ac-ow-${suffix}`;
    await createUser(authorId, { points: 500, emailVerified: true });
    await createUser(ownerId);
    await seedMerchant({ id: `m-ac-${suffix}`, ownerId, name: 'Counter Shop', municipality: 'Dagupan' });
    const { planId } = await seedQuestAndPlan({ suffix, authorId, spotMunicipality: 'Dagupan' });

    const reqRow = await sponsors.request(
      authorId,
      planId,
      `m-ac-${suffix}`,
      { points: 40, voucher_id: null, voucher_qty: 0, promo: false },
      randomUUID(),
    );

    const badCounter = await request(app)
      .post(`/api/v1/sponsorships/${reqRow.id}/counter`)
      .set('Authorization', token(ownerId))
      .send({
        points: 53,
        voucher_qty: 0,
        promo: false,
        terms_version: reqRow.terms_version,
        idempotency_key: randomUUID(),
        conditions: [{ type: 'min_players', value: 0 }],
      });
    expect(badCounter.status).toBe(400);

    const goodCounter = await request(app)
      .post(`/api/v1/sponsorships/${reqRow.id}/counter`)
      .set('Authorization', token(ownerId))
      .send({
        points: 53,
        voucher_qty: 0,
        promo: false,
        terms_version: reqRow.terms_version,
        idempotency_key: randomUUID(),
        conditions: [{ type: 'min_players', value: 10 }],
      });
    expect(goodCounter.status).toBe(200);
    const counteredVersion = goodCounter.body.data.terms_version;

    // Creator accept-counter cannot override -> 409 CONDITIONS_NOT_MET
    const blockedAcceptCounter = await request(app)
      .post(`/api/v1/sponsorships/${reqRow.id}/accept-counter`)
      .set('Authorization', token(authorId))
      .send({ terms_version: counteredVersion, idempotency_key: randomUUID() });
    expect(blockedAcceptCounter.status).toBe(409);
    expect(blockedAcceptCounter.body.error.code).toBe('CONDITIONS_NOT_MET');
    expect(blockedAcceptCounter.body.data.conditions).toEqual([
      expect.objectContaining({ type: 'min_players', value: 10, met: false }),
    ]);

    // Passing acknowledge_unmet on accept-counter is rejected (no override possible)
    const overrideAttempt = await request(app)
      .post(`/api/v1/sponsorships/${reqRow.id}/accept-counter`)
      .set('Authorization', token(authorId))
      .send({ terms_version: counteredVersion, idempotency_key: randomUUID(), acknowledge_unmet: true });
    expect(overrideAttempt.status).toBe(400);
  });

  it('includes non-promo accepted sponsors in funding.sponsors (deduped) and active quest sponsors on GET /spots/:slug', async () => {
    const suffix = randomUUID().slice(0, 8);
    const authorId = `sp-au-${suffix}`;
    const owner1 = `sp-ow1-${suffix}`;
    const owner2 = `sp-ow2-${suffix}`;
    await createUser(authorId, { points: 500, emailVerified: true });
    await createUser(owner1);
    await createUser(owner2);

    await seedMerchant({ id: `m-s1-${suffix}`, ownerId: owner1, name: 'NonPromo Cafe', municipality: 'Dagupan' });
    await seedMerchant({ id: `m-s2-${suffix}`, ownerId: owner2, name: 'Declined Bistro', municipality: 'Dagupan' });

    const { questId, spotId, planId } = await seedQuestAndPlan({
      suffix,
      authorId,
      spotLat: 16.25,
      spotLng: 120.15,
      spotMunicipality: 'Dagupan',
    });

    const s1 = await sponsors.request(
      authorId,
      planId,
      `m-s1-${suffix}`,
      { points: 53, voucher_id: null, voucher_qty: 0, promo: false },
      randomUUID(),
    );
    await sponsors.accept(owner1, s1.id, s1.terms_version, randomUUID());

    const s2 = await sponsors.request(
      authorId,
      planId,
      `m-s2-${suffix}`,
      { points: 20, voucher_id: null, voucher_qty: 0, promo: true },
      randomUUID(),
    );
    await sponsors.decide(owner2, s2.id, 'decline', randomUUID());

    const summaries = await publicFundingSummaries(fixture.pool, [questId], false);
    expect(summaries.get(questId)?.sponsors).toEqual([{ name: 'NonPromo Cafe', logo: null }]);

    // Register spot in spotStore so GET /spots/:slug serves it cleanly
    spotStore.spots.push({
      id: spotId,
      slug: spotId,
      name: `Spot ${suffix}`,
      description: 'Desc',
      category: 'Heritage',
      subcategory: 'Landmark',
      tags: [],
      municipality: 'Dagupan',
      address: 'Dagupan',
      gps_lat: 16.25,
      gps_lng: 120.15,
      price_level: 0,
      hours: {},
      amenities: [],
      good_for: [],
      best_time: [],
      source_type: 'community',
      source_name: 'Author',
      trust_level: 'community',
      status: 'published',
      quest_id: questId,
      created_by: authorId,
      is_test: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any);

    const spotRes = await request(app).get(`/api/v1/spots/${spotId}`);
    expect(spotRes.status).toBe(200);
    expect(spotRes.body.data.sponsors).toEqual([{ name: 'NonPromo Cafe', logo: null, quest_id: questId }]);
  });
});
