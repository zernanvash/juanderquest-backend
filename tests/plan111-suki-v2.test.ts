import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { env } from '../src/config/env.js';
import { SukiService } from '../src/suki/service.js';
import { signSukiPass, standeeUrl } from '../src/suki/codes.js';

const realPgDescribe = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPgDescribe('Plan 111 Suki Card v2: multi-tier ladder, points & redemption (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  let svc: SukiService;

  const ownerId = 'p111-owner';
  const staffId = 'p111-staff';
  const otherOwnerId = 'p111-other-owner';
  const aliceId = 'p111-alice';
  const bobId = 'p111-bob';
  const carolId = 'p111-carol';
  const areaAdminId = 'p111-area-admin';
  const merchantId = 'p111-merchant';
  const otherMerchantId = 'p111-merchant-2';
  const shop = { lat: 16.043, lng: 120.333 };
  const otherShop = { lat: 16.044, lng: 120.335 };

  const token = (id: string, role = 'user') =>
    jwt.sign({ id, seed_id: `${id}-seed`, role, typ: 'session' }, env.JWT_SECRET);
  const day = (n: number) => new Date(Date.UTC(2026, 11, 1 + n, 4, 0, 0));
  const setSettings = (values: Record<string, unknown>) =>
    fixture.pool.query(`UPDATE system_settings_document SET values = values || $1::jsonb WHERE id = 1`, [
      JSON.stringify(values),
    ]);
  const program = async (mId = merchantId) =>
    (await fixture.pool.query('SELECT * FROM suki_programs WHERE merchant_id = $1', [mId])).rows[0];
  const standee = async (mId = merchantId) => {
    const p = await program(mId);
    return standeeUrl(p.id, p.standee_version);
  };
  const visit = (userId: string, now: Date, mId = merchantId, coords = shop) =>
    standee(mId).then((s) =>
      svc.recordStandeeVisit(
        userId,
        {
          standee: s,
          lat: coords.lat,
          lng: coords.lng,
          accuracy_m: 10,
          idempotency_key: randomUUID(),
        },
        now,
      ),
    );

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    svc = new SukiService(fixture.pool);

    const created = new Date('2026-01-01T00:00:00Z').toISOString();
    const users: Array<[string, string]> = [
      [ownerId, 'user'],
      [staffId, 'user'],
      [otherOwnerId, 'user'],
      [aliceId, 'user'],
      [bobId, 'user'],
      [carolId, 'user'],
      [areaAdminId, 'area_admin'],
    ];
    for (const [id, role] of users) {
      await fixture.pool.query(
        `INSERT INTO users(id, seed_id, display_name, email, handle, role, is_public, is_test, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,FALSE,$7) ON CONFLICT (id) DO NOTHING`,
        [id, `${id}-seed`, `Name ${id}`, `${id}@test.local`, id.replace(/-/g, ''), role, created],
      );
      db.users.push({
        id,
        seed_id: `${id}-seed`,
        display_name: `Name ${id}`,
        email: `${id}@test.local`,
        handle: id.replace(/-/g, ''),
        avatar_url: '',
        role: role as any,
        admin_scope: null,
        is_public: true,
        is_test: false,
        created_at: created,
        updated_at: created,
      } as any);
    }

    await fixture.pool.query(
      `INSERT INTO admin_areas(id, level, name, display_name, parent_id, has_boundary, label_lat, label_lng, bbox, min_zoom, boundary)
       VALUES ('p111-pangasinan','province','Pangasinan','Pangasinan',NULL,FALSE,16.0,120.3,$1,5,NULL),
              ('p111-dagupan','town','Dagupan City','Dagupan City','p111-pangasinan',FALSE,16.043,120.333,$2,8,NULL)
       ON CONFLICT (id) DO NOTHING`,
      [
        [119.8, 15.8, 120.8, 16.4],
        [120.3, 16.01, 120.37, 16.08],
      ],
    );
    await fixture.pool.query(
      `INSERT INTO admin_area_assignments(id, user_id, area_id, powers, granted_by)
       VALUES ('p111-grant-in', $1, 'p111-dagupan', ARRAY['merchants_vouchers']::text[], $1)
       ON CONFLICT (id) DO NOTHING`,
      [areaAdminId],
    );
    await fixture.pool.query(
      `INSERT INTO merchants(id, name, location, description, status, is_published, municipality, town_area_id, gps_lat, gps_lng)
       VALUES ($1, 'Kapehan Suki', 'Dagupan', 'Coffee shop', 'active', TRUE, 'Dagupan City', 'p111-dagupan', $2, $3),
              ($4, 'Puto Calasiao Hub', 'Dagupan', 'Rice cake shop', 'active', TRUE, 'Dagupan City', 'p111-dagupan', $5, $6)`,
      [merchantId, shop.lat, shop.lng, otherMerchantId, otherShop.lat, otherShop.lng],
    );
    await fixture.pool.query(
      `INSERT INTO merchant_memberships(id, merchant_id, user_id, role, status)
       VALUES ($1,$2,$3,'owner','active'), ($4,$2,$5,'staff','active'), ($6,$7,$8,'owner','active')`,
      [randomUUID(), merchantId, ownerId, randomUUID(), staffId, randomUUID(), otherMerchantId, otherOwnerId],
    );

    db.usersRepo.setPool(fixture.pool);
    await setSettings({ suki_enabled: true, suki_points_enabled: false, suki_max_points_per_day: 60 });
  });

  afterAll(async () => {
    setPool(null);
    db.usersRepo.setPool(null);
    await fixture?.close();
  });

  it('places migration 108 right after 107 in the migration ledger', () => {
    expect(MIGRATIONS).toContain('108_suki_v2_tiers_points.sql');
    expect(MIGRATIONS.indexOf('108_suki_v2_tiers_points.sql')).toBeGreaterThan(
      MIGRATIONS.indexOf('107_avatar_reports.sql'),
    );
  });

  it('validates multi-tier ladder (1..4 tiers, strictly increasing visit numbers, final >= 3)', async () => {
    const auth = { Authorization: `Bearer ${token(ownerId)}` };

    const nonIncreasing = await request(app)
      .put('/api/v1/merchant/suki')
      .set(auth)
      .send({
        title: 'Kapehan Loyalty',
        tiers: [
          { visit_number: 5, reward_kind: 'free_item', reward_text: 'Free cookie' },
          { visit_number: 3, reward_kind: 'free_item', reward_text: 'Free coffee' },
        ],
      });
    expect(nonIncreasing.status).toBe(400);

    const tooShort = await request(app)
      .put('/api/v1/merchant/suki')
      .set(auth)
      .send({
        title: 'Kapehan Loyalty',
        tiers: [{ visit_number: 2, reward_kind: 'free_item', reward_text: 'Free coffee' }],
      });
    expect(tooShort.status).toBe(400);

    const badPct = await request(app)
      .put('/api/v1/merchant/suki')
      .set(auth)
      .send({
        title: 'Kapehan Loyalty',
        tiers: [{ visit_number: 5, reward_kind: 'percent_off', reward_value: 60, reward_text: '60% off' }],
      });
    expect(badPct.status).toBe(400);

    const ok = await request(app)
      .put('/api/v1/merchant/suki')
      .set(auth)
      .send({
        title: 'Kapehan Loyalty',
        skin_key: 'jdq_classic',
        points_enabled: true,
        points_per_visit: 15,
        pesos_per_point: 20,
        max_points_per_visit: 50,
        tiers: [
          {
            visit_number: 2,
            reward_kind: 'amount_off',
            reward_value: 15,
            reward_text: '₱15 off drink',
            icon_key: 'discount',
          },
          { visit_number: 4, reward_kind: 'free_item', reward_text: 'Free cold brew', icon_key: 'coffee' },
        ],
      });
    expect(ok.status).toBe(200);
    expect(ok.body.data.program).toMatchObject({
      visits_required: 4,
      reward_kind: 'free_item',
      reward_text: 'Free cold brew',
      skin_key: 'jdq_classic',
    });
    expect(ok.body.data.program.tiers).toHaveLength(2);
    expect(ok.body.data.program.tiers[0]).toMatchObject({
      visit_number: 2,
      icon_key: 'discount',
      reward_tag: '₱15 OFF',
    });

    await svc.activate(ownerId);
  });

  it('unlocks milestone tiers without resetting early, snapshots cycle_tiers mid-cycle, and resets on final tier', async () => {
    const v1 = await visit(aliceId, day(1));
    expect(v1.card.visits).toBe(1);
    expect(v1.card.required).toBe(4);
    expect(v1.rewards_issued).toHaveLength(0);
    expect(v1.points_awarded).toBe(0); // global suki_points_enabled is still false!

    const v2 = await visit(aliceId, day(2));
    expect(v2.card.visits).toBe(2);
    expect(v2.card.cycle).toBe(1);
    expect(v2.rewards_issued).toHaveLength(1);
    expect(v2.reward_issued).toMatchObject({ reward_text: '₱15 off drink', tier_visit: 2, source: 'visits' });

    // Edit ladder mid-cycle to 6 visits with 1 tier only: Alice stays on her 4-visit cycle 1 snapshot!
    await svc.upsertProgram(ownerId, {
      title: 'Kapehan Loyalty',
      points_enabled: true,
      points_per_visit: 15,
      pesos_per_point: 20,
      max_points_per_visit: 50,
      tiers: [
        { visit_number: 3, reward_kind: 'promo', reward_text: 'Free upsize', icon_key: 'drink' },
        { visit_number: 6, reward_kind: 'free_item', reward_text: 'Free signature latte', icon_key: 'coffee' },
      ],
    });

    const cardsMid = await request(app)
      .get('/api/v1/me/suki-cards')
      .set('Authorization', `Bearer ${token(aliceId)}`);
    expect(cardsMid.status).toBe(200);
    const aliceCard = cardsMid.body.data.cards[0];
    expect(aliceCard.card_no).toMatch(/^SUKI \d{4}-[0-9A-F]{4}$/);
    expect(aliceCard.skin_key).toBe('jdq_classic');
    expect(aliceCard.holder).toMatchObject({ display_name: `Name ${aliceId}`, handle: aliceId.replace(/-/g, '') });
    expect(aliceCard.tiers.map((t: any) => [t.visit_number, t.state])).toEqual([
      [2, 'issued'],
      [4, 'locked'],
    ]);

    // Scan tier 2 reward at counter -> tier 2 state becomes 'claimed'.
    await svc.scan(staffId, aliceCard.rewards[0].code);
    const afterClaim = await svc.listMyCards(aliceId, day(2));
    expect(afterClaim.cards[0].tiers.map((t: any) => [t.visit_number, t.state])).toEqual([
      [2, 'claimed'],
      [4, 'locked'],
    ]);

    await visit(aliceId, day(3));
    const v4 = await visit(aliceId, day(4));
    expect(v4.reward_issued).toMatchObject({ reward_text: 'Free cold brew', tier_visit: 4 });
    expect(v4.card).toMatchObject({ visits: 0, cycle: 2, required: 6, total_visits: 4 });

    const nextCycle = await svc.listMyCards(aliceId, day(4));
    expect(nextCycle.cards[0].tiers.map((t: any) => [t.visit_number, t.state])).toEqual([
      [3, 'locked'],
      [6, 'locked'],
    ]);
  });

  it('enforces points menu limit, permissions, points earn/cap rules, idempotent redemption & ledger paging', async () => {
    const p = await program();
    await setSettings({ suki_points_enabled: true, suki_max_points_per_day: 60 });

    // Staff cannot write points menu
    const staffTry = await request(app)
      .post('/api/v1/merchant/suki/points-menu')
      .set('Authorization', `Bearer ${token(staffId)}`)
      .send({ title: 'Free Cookie', points_cost: 30, icon_key: 'snack' });
    expect(staffTry.status).toBe(403);

    // Owner creates up to 12 items (10 via service + 2 over HTTP to stay below 20/min write limiter); 13th rejected with POINTS_MENU_LIMIT
    const ownerAuth = { Authorization: `Bearer ${token(ownerId)}` };
    const createdIds: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const created = await svc.createPointsMenuItem(ownerId, {
        title: `Item #${i + 1}`,
        points_cost: 25 + i * 5,
        icon_key: 'snack',
        sort_order: i,
      });
      createdIds.push(created.item.id);
    }
    for (let i = 10; i < 12; i += 1) {
      const res = await request(app)
        .post('/api/v1/merchant/suki/points-menu')
        .set(ownerAuth)
        .send({ title: `Item #${i + 1}`, points_cost: 25 + i * 5, icon_key: 'snack', sort_order: i });
      expect(res.status).toBe(201);
      createdIds.push(res.body.data.item.id);
    }
    const overLimit = await request(app)
      .post('/api/v1/merchant/suki/points-menu')
      .set(ownerAuth)
      .send({ title: 'Item 13', points_cost: 100 });
    expect(overLimit.status).toBe(409);
    expect(overLimit.body.error.code).toBe('POINTS_MENU_LIMIT');

    // Delete 10 items, update first item
    const delHttp = await request(app).delete(`/api/v1/merchant/suki/points-menu/${createdIds[2]}`).set(ownerAuth);
    expect(delHttp.status).toBe(200);
    for (const delId of createdIds.slice(3)) {
      await svc.deletePointsMenuItem(ownerId, delId);
    }
    const patched = await request(app)
      .patch(`/api/v1/merchant/suki/points-menu/${createdIds[0]}`)
      .set(ownerAuth)
      .send({ title: 'Iced Americano', points_cost: 30, icon_key: 'coffee' });
    expect(patched.status).toBe(200);
    expect(patched.body.data.item).toMatchObject({ title: 'Iced Americano', points_cost: 30, icon_key: 'coffee' });

    // Configure second shop with points enabled too
    await svc.upsertProgram(otherOwnerId, {
      title: 'Puto Loyalty',
      points_enabled: true,
      points_per_visit: 30,
      tiers: [{ visit_number: 5, reward_kind: 'free_item', reward_text: 'Free puto box' }],
    });
    await svc.activate(otherOwnerId);

    // Switch primary shop temporarily to staff_scan so staff scan can test amount_spent spend points
    await svc.upsertProgram(ownerId, {
      title: 'Kapehan Loyalty',
      mode: 'staff_scan',
      points_enabled: true,
      points_per_visit: 15,
      pesos_per_point: 20,
      max_points_per_visit: 40,
      tiers: [
        { visit_number: 3, reward_kind: 'promo', reward_text: 'Free upsize', icon_key: 'drink' },
        { visit_number: 6, reward_kind: 'free_item', reward_text: 'Free signature latte', icon_key: 'coffee' },
      ],
    });

    // Bob gets staff-scanned pass with ₱500 spent: +15 visit + 25 spend = 40 points!
    const bobPass = signSukiPass(p.id, bobId).pass;
    const scan1 = await svc.scan(staffId, bobPass, day(5), 500);
    expect(scan1.kind).toBe('visit');
    expect((scan1 as any).points_awarded).toBe(40);
    expect(scan1.visit.card.points).toMatchObject({ enabled: true, balance: 40, lifetime: 40 });

    // Cross-shop daily cap check: Bob already earned 40 today out of max 60 -> second shop gives 20 (capped from 30)!
    const secondShopVisit = await visit(bobId, new Date(day(5).getTime() + 60_000), otherMerchantId, otherShop);
    expect(secondShopVisit.points_awarded).toBe(20);

    // Insufficient points check for expensive item (item #2 = 30 vs try updating cost to 50)
    await request(app)
      .patch(`/api/v1/merchant/suki/points-menu/${createdIds[1]}`)
      .set(ownerAuth)
      .send({ points_cost: 50 });
    const tooPoor = await request(app)
      .post('/api/v1/suki/points/redeem')
      .set('Authorization', `Bearer ${token(bobId)}`)
      .send({ item_id: createdIds[1], idempotency_key: 'redeem-poor-001' });
    expect(tooPoor.status).toBe(409);
    expect(tooPoor.body.error.code).toBe('POINTS_INSUFFICIENT');

    // Redeem Iced Americano (30 pts): balance drops 40 -> 10, lifetime stays 40, reward SUKI-... issued
    const bobCardsBefore = await svc.listMyCards(bobId, day(5));
    const bobCardId = bobCardsBefore.cards.find((c) => c.program.id === p.id)!.card_id;
    const idemKey = `redeem-ok-${randomUUID()}`;
    const redeemed = await request(app)
      .post('/api/v1/suki/points/redeem')
      .set('Authorization', `Bearer ${token(bobId)}`)
      .send({ item_id: createdIds[0], idempotency_key: idemKey });
    expect(redeemed.status).toBe(201);
    expect(redeemed.body.data.replayed).toBe(false);
    expect(redeemed.body.data.reward).toMatchObject({
      source: 'points',
      points_cost: 30,
      tier_visit: null,
      reward_text: 'Iced Americano',
      status: 'issued',
    });
    expect(redeemed.body.data.card.points).toMatchObject({ balance: 10, lifetime: 40 });

    // Idempotent replay with same key
    const replayed = await request(app)
      .post('/api/v1/suki/points/redeem')
      .set('Authorization', `Bearer ${token(bobId)}`)
      .send({ item_id: createdIds[0], idempotency_key: idemKey });
    expect(replayed.body.data.replayed).toBe(true);
    expect(replayed.body.data.reward.code).toBe(redeemed.body.data.reward.code);
    expect(replayed.body.data.card.points.balance).toBe(10);

    // Redeem code can be claimed by staff at counter
    const claimed = await svc.scan(staffId, redeemed.body.data.reward.code);
    expect(claimed).toMatchObject({ kind: 'reward', title: 'Reward claimed', detail: 'Iced Americano' });

    // Ledger cursor pagination + holder scoping
    const alien = await request(app)
      .get(`/api/v1/suki/cards/${bobCardId}/points`)
      .set('Authorization', `Bearer ${token(carolId)}`);
    expect(alien.status).toBe(404);

    const page1 = await request(app)
      .get(`/api/v1/suki/cards/${bobCardId}/points?limit=2`)
      .set('Authorization', `Bearer ${token(bobId)}`);
    expect(page1.status).toBe(200);
    expect(page1.body.data.balance).toBe(10);
    expect(page1.body.data.items).toHaveLength(2);
    expect(page1.body.data.next_cursor).toBeTruthy();

    const page2 = await request(app)
      .get(`/api/v1/suki/cards/${bobCardId}/points?limit=2&cursor=${encodeURIComponent(page1.body.data.next_cursor)}`)
      .set('Authorization', `Bearer ${token(bobId)}`);
    expect(page2.status).toBe(200);
    expect(page2.body.data.items.length).toBeGreaterThanOrEqual(1);

    // Public program detail includes tiers, points config, and points_menu
    const pub = await request(app).get(`/api/v1/suki/programs/${p.id}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.program.tiers).toHaveLength(2);
    expect(pub.body.data.program.points).toMatchObject({ enabled: true, per_visit: 15, pesos_per_point: 20 });
    expect(pub.body.data.points_menu.length).toBeGreaterThanOrEqual(2);

    // Merchant stats and admin overview include points aggregates
    const stats = await svc.stats(ownerId, 30, day(6));
    expect(stats.points_issued).toBe(40);
    expect(stats.points_redeemed).toBe(30);
    expect(stats.rewards_by_tier.some((r) => r.source === 'points' && r.claimed === 1)).toBe(true);

    const adminRes = await request(app)
      .get('/api/v1/admin/suki/programs')
      .set('Authorization', `Bearer ${token(areaAdminId, 'area_admin')}`);
    expect(adminRes.status).toBe(200);
    const adminRow = adminRes.body.data.items.find((r: any) => r.id === p.id);
    expect(adminRow).toMatchObject({ points_enabled: true, tiers_count: 2, skin_key: 'jdq_classic' });
    expect(adminRow.points_issued_30d).toBeGreaterThanOrEqual(40);
    expect(adminRow.points_redeemed_30d).toBeGreaterThanOrEqual(30);

    // Turning global suki_points_enabled back off returns POINTS_DISABLED on redeem
    await setSettings({ suki_points_enabled: false });
    const blocked = await request(app)
      .post('/api/v1/suki/points/redeem')
      .set('Authorization', `Bearer ${token(bobId)}`)
      .send({ item_id: createdIds[1], idempotency_key: 'redeem-disabled-1' });
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe('POINTS_DISABLED');
  });
});
