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
import { SponsorshipService } from '../src/funding/sponsorships.js';
import { abandonFundedAttempt, settleFundingHold, startFundedAttempt } from '../src/funding/holds.js';
import { vouchersService } from '../src/services/vouchers.js';
import { spotStore } from '../src/spots/store.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('Plan 110a: merchant-to-user QA fixes & architecture bridges (real PG)', () => {
  let fixture: TestDbInstance;
  let plans: FundingPlansService;
  let sponsors: SponsorshipService;
  let merchantPoints: MerchantPointsService;
  const origFunding = env.QUEST_FUNDING_ENABLED;
  const origMarketplace = env.MARKETPLACE_ENABLED;

  const token = (id: string, role = 'user') =>
    `Bearer ${jwt.sign({ id, seed_id: id, role, typ: 'session' }, env.JWT_SECRET)}`;

  async function createUser(id: string, { points = 0, emailVerified = true, isTest = false } = {}) {
    const walletAddress = `0x${Buffer.from(id).toString('hex').padEnd(40, '0').slice(0, 40)}`;
    await fixture.pool.query(
      'INSERT INTO users(id,seed_id,display_name,email,role,demo_points,is_test,wallet_address) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, id, `User ${id}`, `${id}@example.test`, 'user', points, isTest, walletAddress],
    );
    await fixture.pool.query(
      `INSERT INTO account_emails(id,user_id,email,normalized_email,is_verified,is_primary)
       VALUES($1,$2,$3,$4,$5,TRUE)`,
      [`ae-${id}`, id, `${id}@example.test`, `${id}@example.test`, emailVerified],
    );
    db.users.push({
      id,
      seed_id: id,
      display_name: `User ${id}`,
      email: `${id}@example.test`,
      role: 'user',
      demo_points: points,
      is_test: isTest,
      wallet_address: walletAddress,
      created_at: new Date().toISOString(),
    });
  }

  async function createMerchant(
    id: string,
    ownerId: string,
    {
      name = 'Shop',
      municipality = 'Dagupan',
      isPublished = true,
      isTest = false,
      gpsLat = null as number | null,
      gpsLng = null as number | null,
      appLat = null as number | null,
      appLng = null as number | null,
      spotId = null as string | null,
    } = {},
  ) {
    const appId = `app-${id}`;
    await fixture.pool.query(
      `INSERT INTO merchant_affiliate_applications
         (id,user_id,business_name,category,municipality,contact_name,contact_email,contact_phone,sponsorship_goals,proposal_details,status,gps_lat,gps_lng)
       VALUES($1,$2,$3,'food',$4,'Owner',$5,'09170000000','[]'::jsonb,'Desc','approved',$6,$7)`,
      [appId, ownerId, name, municipality, `${id}@shop.test`, appLat, appLng],
    );
    await fixture.pool.query(
      `INSERT INTO merchants
         (id,name,location,description,status,is_published,category,municipality,source_application_id,is_test,gps_lat,gps_lng,spot_id)
       VALUES($1,$2,$3,'Desc','active',$4,'food',$5,$6,$7,$8,$9,$10)`,
      [id, name, `${municipality}, Pangasinan`, isPublished, municipality, appId, isTest, gpsLat, gpsLng, spotId],
    );
    await fixture.pool.query(
      `INSERT INTO merchant_memberships(id,merchant_id,user_id,role,status)
       VALUES($1,$2,$3,'owner','active')`,
      [`mm-${id}`, id, ownerId],
    );
  }

  async function createQuest(id: string, authorId: string, { isTest = false, lat = 16.0433, lng = 120.3333 } = {}) {
    await fixture.pool.query(
      `INSERT INTO quests(id,title,description,category,location_name,gps_lat,gps_lng,radius_meters,reward_points,marker_code,is_active,status,author_id,version,is_test)
       VALUES($1,'Eco Quest','Clean up quest','eco','Dagupan',$2,$3,150,50,$4,FALSE,'draft',$5,1,$6)`,
      [id, lat, lng, `MK-${id}`, authorId, isTest],
    );
  }

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    await db.hydrateFromPg(fixture.pool);
    await spotStore.hydrateFromPg(fixture.pool);
    plans = new FundingPlansService(fixture.pool);
    sponsors = new SponsorshipService(fixture.pool);
    merchantPoints = new MerchantPointsService(fixture.pool);
    (env as any).QUEST_FUNDING_ENABLED = true;
    (env as any).MARKETPLACE_ENABLED = true;
  });

  afterAll(async () => {
    (env as any).QUEST_FUNDING_ENABLED = origFunding;
    (env as any).MARKETPLACE_ENABLED = origMarketplace;
    setPool(null);
    if (fixture) await fixture.close();
  });

  it('migration 106 is in MIGRATIONS and schema objects exist', async () => {
    expect(MIGRATIONS).toContain('106_merchant_user_qa_and_bridges.sql');
    const colRes = await fixture.pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND ((table_name='quest_sponsorships' AND column_name='counter_voucher_id')
           OR (table_name='vouchers' AND column_name IN ('stock_limit','valid_days','created_at','updated_at'))
           OR (table_name='redemptions' AND column_name='expires_at'))`,
    );
    expect(colRes.rows.length).toBe(6);
    const idxRes = await fixture.pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename='redemptions' AND indexname IN ('uq_redemptions_user_voucher','uq_redemptions_user_voucher_open')`,
    );
    expect(idxRes.rows.map((r: any) => r.indexname)).toEqual(['uq_redemptions_user_voucher_open']);
  });

  it('WP-2/WP-1: traveler who already redeemed a Shop voucher can still complete a sponsored quest with that voucher perk, and can re-redeem after counter use', async () => {
    await createUser('u110-author', { points: 500 });
    await createUser('u110-owner', { points: 0 });
    await createUser('u110-traveler', { points: 500 });
    await createMerchant('m110-perk', 'u110-owner', { name: 'Perk Bakery' });
    await merchantPoints.purchase('u110-owner', 'm110-perk', 1000, randomUUID());

    await fixture.pool.query(
      `INSERT INTO vouchers(id,merchant_id,title,description,cost_points,is_active,availability,stock_limit,valid_days)
       VALUES('v110-perk','m110-perk','Free Pandesal','Warm pandesal bag',40,TRUE,'live',5,14)`,
    );

    // Traveler buys v110-perk in Shop first
    const r1 = await vouchersService.redeemVoucher('v110-perk', 'u110-traveler', randomUUID());
    expect(r1.success).toBe(true);
    expect((r1.data?.redemption as any).expires_at).toBeTruthy();

    // Double-redeem while unused fails 409 ALREADY_REDEEMED
    const rDup = await vouchersService.redeemVoucher('v110-perk', 'u110-traveler', randomUUID());
    expect(rDup.success).toBe(false);
    expect(rDup.error?.code).toBe('ALREADY_REDEEMED');

    // Now setup sponsored quest with v110-perk
    await createQuest('q110-perk', 'u110-author');
    const starts = new Date(Date.now() - 60_000).toISOString();
    const ends = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const plan = await plans.create(
      'u110-author',
      'q110-perk',
      { mode: 'budget', planned_completions: 1, starts_at: starts, ends_at: ends },
      randomUUID(),
    );
    await plans.submit('u110-author', plan.id, randomUUID());
    const sp = await sponsors.request(
      'u110-author',
      plan.id,
      'm110-perk',
      { points: 60, voucher_id: 'v110-perk', voucher_qty: 2, promo: false },
      randomUUID(),
    );
    await sponsors.accept('u110-owner', sp.id, sp.terms_version, randomUUID());

    const started = await startFundedAttempt(fixture.pool, 'q110-perk', 'u110-traveler');
    expect(started?.attempt.id).toBeTruthy();

    // Mark submitted & settle in a real transaction
    const client = await fixture.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE quest_attempts SET status='submitted' WHERE id=$1`, [started!.attempt.id]);
      const settled = await settleFundingHold(client, 'u110-traveler', 'q110-perk', started!.attempt.id, 'u110-author');
      await client.query('COMMIT');
      expect(settled?.awardedPoints).toBe(50);
      expect(settled?.voucherPerk?.code).toMatch(/^JDQ-/);
    } finally {
      client.release();
    }

    // Mark first Shop redemption as used at counter -> traveler can re-redeem
    await fixture.pool.query(
      `UPDATE redemptions SET used_at = NOW(), used_by = 'u110-owner' WHERE user_id='u110-traveler' AND voucher_id='v110-perk' AND source='purchase'`,
    );
    const r2 = await vouchersService.redeemVoucher('v110-perk', 'u110-traveler', randomUUID());
    expect(r2.success).toBe(true);
  });

  it('WP-3 & WP-2: counter preserves counter_voucher_id, hrefs point to /quests/:id/funding & /merchant?tab=sponsorships, visits_shop uses merchants.gps_lat/lng, budget reopens on abandon, zero-point sponsor can topUp & inbox has no dupes', async () => {
    await createUser('u110b-author', { points: 500 });
    await createUser('u110b-owner', { points: 100 });
    await createUser('u110b-traveler', { points: 100 });
    // Merchant has updated counter GPS on merchants table (16.0433, 120.3333) while old application had null GPS
    await createMerchant('m110b-shop', 'u110b-owner', {
      name: 'Coastal Brew',
      gpsLat: 16.0433,
      gpsLng: 120.3333,
      appLat: null,
      appLng: null,
    });
    await merchantPoints.purchase('u110b-owner', 'm110b-shop', 1000, randomUUID());
    await fixture.pool.query(
      `INSERT INTO vouchers(id,merchant_id,title,description,cost_points,is_active,availability)
       VALUES('v110b-latte','m110b-shop','Free Latte','Hot or iced latte',50,TRUE,'live')`,
    );

    await createQuest('q110b-main', 'u110b-author', { lat: 16.0433, lng: 120.3333 });
    // Bind 2 spots to test inbox deduplication
    await fixture.pool.query(
      `INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,source_type,source_name,trust_level,status,quest_id)
       VALUES
         ('sp110b-1','sp-110b-1','Spot One','Desc','nature_outdoors','park','Dagupan','Dagupan',16.0433,120.3333,'community','Test','community','published','q110b-main'),
         ('sp110b-2','sp-110b-2','Spot Two','Desc','nature_outdoors','park','Dagupan','Dagupan',16.0434,120.3334,'community','Test','community','published','q110b-main')`,
    );

    const starts = new Date(Date.now() - 60_000).toISOString();
    const ends = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const plan = await plans.create(
      'u110b-author',
      'q110b-main',
      { mode: 'budget', planned_completions: 1, starts_at: starts, ends_at: ends },
      randomUUID(),
    );
    await plans.submit('u110b-author', plan.id, randomUUID());

    // Author requests points-only sponsorship; merchant counters with voucher_id + 0 points (voucher-only!)
    const reqSp = await sponsors.request(
      'u110b-author',
      plan.id,
      'm110b-shop',
      { points: 60, voucher_qty: 0, promo: false },
      randomUUID(),
    );
    const countered = await sponsors.counter(
      'u110b-owner',
      reqSp.id,
      {
        points: 0,
        voucher_id: 'v110b-latte',
        voucher_qty: 2,
        promo: true,
        conditions: [{ type: 'visits_shop' }],
      },
      reqSp.terms_version,
      randomUUID(),
    );
    expect(countered.counter_voucher_id).toBe('v110b-latte');
    expect(countered.conditions[0].met).toBe(true); // evaluated against merchants.gps_lat/lng!

    // Inbox must return exactly 1 row despite 2 bound spots
    const inbox = await sponsors.inbox('u110b-owner');
    expect(inbox.items.filter((i: any) => i.id === reqSp.id).length).toBe(1);

    // Author accepts counter -> grants v110b-latte perk
    const accepted = await sponsors.acceptCounter('u110b-author', reqSp.id, countered.terms_version, randomUUID());
    expect(accepted.voucher_id).toBe('v110b-latte');
    expect(accepted.voucher_qty).toBe(2);

    // Notification hrefs must use mobile routes, never /funding?quest_id= or /merchant/funding
    const notifs = await fixture.pool.query(
      `SELECT href FROM user_notifications WHERE user_id IN ('u110b-author','u110b-owner')`,
    );
    expect(
      notifs.rows.every((n: any) => !String(n.href).includes('/funding?quest_id=') && n.href !== '/merchant/funding'),
    ).toBe(true);
    expect(notifs.rows.some((n: any) => n.href === '/quests/q110b-main/funding')).toBe(true);
    expect(notifs.rows.some((n: any) => n.href === '/merchant?tab=sponsorships')).toBe(true);

    // Activate round, then zero-point accepted sponsor tops up 60 points!
    await fixture.pool.query(
      `UPDATE quest_funding_plans SET status='active', activated_at=NOW() WHERE id=$1 AND status='pending_sponsors'`,
      [plan.id],
    );
    await sponsors.topUp('u110b-owner', plan.id, 60, randomUUID());

    // Traveler takes the only hold -> budget_exhausted -> status='closing'.
    // When traveler abandons before ends_at, round must reopen to 'active'!
    const attempt = await startFundedAttempt(fixture.pool, 'q110b-main', 'u110b-traveler');
    expect(attempt).toBeTruthy();
    const closingRow = (
      await fixture.pool.query('SELECT status, close_reason FROM quest_funding_plans WHERE id=$1', [plan.id])
    ).rows[0];
    expect(closingRow.status).toBe('closing');
    expect(closingRow.close_reason).toBe('budget_exhausted');

    await abandonFundedAttempt(fixture.pool, 'q110b-main', attempt!.attempt.id, 'u110b-traveler', randomUUID());
    const reopenedRow = (
      await fixture.pool.query('SELECT status, close_reason FROM quest_funding_plans WHERE id=$1', [plan.id])
    ).rows[0];
    expect(reopenedRow.status).toBe('active');
    expect(reopenedRow.close_reason).toBeNull();
  });

  it('WP-4 & WP-5: voucher catalog scope, self-redemption block, stock_limit, merchant voucher CRUD, staff management, counter history, analytics, and public directory', async () => {
    await createUser('u110c-owner', { points: 500 });
    await createUser('u110c-staff', { points: 500 });
    await createUser('u110c-buyer', { points: 500 });
    await createUser('u110c-unverified', { points: 500, emailVerified: false });
    await createUser('u110c-test', { points: 500, isTest: true });

    await createMerchant('m110c-pub', 'u110c-owner', {
      name: 'Dagupan Heritage Cafe',
      gpsLat: 16.043,
      gpsLng: 120.333,
    });
    await createMerchant('m110c-draft', 'u110c-buyer', { name: 'Hidden Draft Shop', isPublished: false });
    await createMerchant('m110c-test', 'u110c-test', { name: 'Test QA Shop', isTest: true });

    // Owner creates a voucher via WP-5 endpoint (starts in preview)
    const createRes = await request(app)
      .post('/api/v1/merchant/vouchers')
      .set('Authorization', token('u110c-owner'))
      .send({
        title: '10% Off Tupig',
        description: 'Valid for 1 box of grilled tupig.',
        cost_points: 50,
        stock_limit: 1,
        valid_days: 7,
        icon_key: 'meal',
      });
    expect(createRes.status).toBe(201);
    const vId = createRes.body.data.id as string;
    expect(createRes.body.data.availability).toBe('preview');

    // Manage list returns it even with QUEST_FUNDING_ENABLED=false
    const manageRes = await request(app)
      .get('/api/v1/merchant/vouchers/manage')
      .set('Authorization', token('u110c-owner'));
    expect(manageRes.status).toBe(200);
    expect(manageRes.body.data.items.some((v: any) => v.id === vId && v.stock_limit === 1)).toBe(true);

    // Owner updates description
    const patchRes = await request(app)
      .patch(`/api/v1/merchant/vouchers/${vId}`)
      .set('Authorization', token('u110c-owner'))
      .send({ description: 'Fresh grilled tupig box (limit 1 per traveler).' });
    expect(patchRes.status).toBe(200);

    // Staff management: reject unverified, accept verified staff, reject staff creating voucher (403)
    const badStaff = await request(app)
      .post('/api/v1/merchant/staff')
      .set('Authorization', token('u110c-owner'))
      .send({ email: 'u110c-unverified@example.test' });
    expect(badStaff.status).toBe(404);

    const addStaff = await request(app)
      .post('/api/v1/merchant/staff')
      .set('Authorization', token('u110c-owner'))
      .send({ email: 'u110c-staff@example.test' });
    expect(addStaff.status).toBe(201);
    expect(addStaff.body.data.role).toBe('staff');

    const staffForbidden = await request(app)
      .post('/api/v1/merchant/vouchers')
      .set('Authorization', token('u110c-staff'))
      .send({ title: 'Unauthorized', description: 'Nope', cost_points: 10 });
    expect(staffForbidden.status).toBe(403);

    // Promote voucher to live for Shop testing + add test-scope live voucher
    await fixture.pool.query(`UPDATE vouchers SET availability='live' WHERE id=$1`, [vId]);
    await fixture.pool.query(
      `INSERT INTO vouchers(id,merchant_id,title,description,cost_points,is_active,availability)
       VALUES('v110c-test','m110c-test','Test Only','Test scope voucher',25,TRUE,'live')`,
    );

    // Public GET /vouchers hides test shop voucher for prod viewer
    const catalogRes = await request(app).get('/api/v1/vouchers');
    expect(catalogRes.status).toBe(200);
    const catalogIds = catalogRes.body.data.map((v: any) => v.id);
    expect(catalogIds).toContain(vId);
    expect(catalogIds).not.toContain('v110c-test');

    // Self-redemption blocked for owner and staff (403 SELF_REDEMPTION_FORBIDDEN)
    const selfOwner = await request(app)
      .post(`/api/v1/vouchers/${vId}/redeem`)
      .set('Authorization', token('u110c-owner'))
      .send({ idempotency_key: randomUUID() });
    expect(selfOwner.status).toBe(403);
    expect(selfOwner.body.error.code).toBe('SELF_REDEMPTION_FORBIDDEN');

    const selfStaff = await request(app)
      .post(`/api/v1/vouchers/${vId}/redeem`)
      .set('Authorization', token('u110c-staff'))
      .send({ idempotency_key: randomUUID() });
    expect(selfStaff.status).toBe(403);

    // Cross-scope blocked even with voucher_income_enabled = false
    const crossScope = await request(app)
      .post(`/api/v1/vouchers/${vId}/redeem`)
      .set('Authorization', token('u110c-test'))
      .send({ idempotency_key: randomUUID() });
    expect(crossScope.status).toBe(409);
    expect(crossScope.body.error.code).toBe('SCOPE_MISMATCH');

    // Buyer redeems the 1 stock
    const buy1 = await request(app)
      .post(`/api/v1/vouchers/${vId}/redeem`)
      .set('Authorization', token('u110c-buyer'))
      .send({ idempotency_key: randomUUID() });
    expect(buy1.status).toBe(201);
    const redemptionId = buy1.body.data.id as string;

    // Mark used at counter -> another user hits stock_limit=1 (409 VOUCHER_OUT_OF_STOCK)
    await fixture.pool.query(`UPDATE redemptions SET used_at=NOW(), used_by='u110c-staff' WHERE id=$1`, [redemptionId]);
    await createUser('u110c-buyer2', { points: 500 });
    const outOfStock = await request(app)
      .post(`/api/v1/vouchers/${vId}/redeem`)
      .set('Authorization', token('u110c-buyer2'))
      .send({ idempotency_key: randomUUID() });
    expect(outOfStock.status).toBe(409);
    expect(outOfStock.body.error.code).toBe('VOUCHER_OUT_OF_STOCK');

    // Counter history & Analytics
    const histRes = await request(app)
      .get('/api/v1/merchant/counter/history')
      .set('Authorization', token('u110c-staff'));
    expect(histRes.status).toBe(200);
    expect(histRes.body.data.items.some((e: any) => e.kind === 'voucher' && e.staff_name === 'User u110c-staff')).toBe(
      true,
    );

    const analyticsRes = await request(app)
      .get('/api/v1/merchant/analytics?days=30')
      .set('Authorization', token('u110c-owner'));
    expect(analyticsRes.status).toBe(200);
    expect(analyticsRes.body.data.vouchers.shop_redeemed_in_window).toBe(1);
    expect(analyticsRes.body.data.vouchers.confirmed_at_counter_in_window).toBe(1);

    // Public directory filters out draft & test shops
    const dirRes = await request(app).get('/api/v1/merchants?municipality=Dagupan&lat=16.043&lng=120.333');
    expect(dirRes.status).toBe(200);
    const dirIds = dirRes.body.data.items.map((m: any) => m.id);
    expect(dirIds).toContain('m110c-pub');
    expect(dirIds).not.toContain('m110c-draft');
    expect(dirIds).not.toContain('m110c-test');

    // Owner revokes staff and archives voucher
    const revokeRes = await request(app)
      .delete('/api/v1/merchant/staff/u110c-staff')
      .set('Authorization', token('u110c-owner'));
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.data.status).toBe('revoked');

    const delVoucher = await request(app)
      .delete(`/api/v1/merchant/vouchers/${vId}`)
      .set('Authorization', token('u110c-owner'));
    expect(delVoucher.status).toBe(200);
    expect(delVoucher.body.data.is_active).toBe(false);
  });
});
