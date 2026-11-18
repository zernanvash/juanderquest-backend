import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { manilaDateString } from '../src/stamps/time.js';
import { env } from '../src/config/env.js';
import { SukiService } from '../src/suki/service.js';
import { parseStandee, signSukiPass, standeeUrl } from '../src/suki/codes.js';

const realPgDescribe = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPgDescribe('Plan 107 Suki Card (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  let svc: SukiService;

  const ownerId = 'p107-owner';
  const staffId = 'p107-staff';
  const otherOwnerId = 'p107-other-owner';
  const aliceId = 'p107-alice';
  const bobId = 'p107-bob';
  const unverifiedId = 'p107-unverified';
  const testUserId = 'p107-test-user';
  const platformId = 'p107-platform';
  const areaAdminId = 'p107-area-admin';
  const outsiderAdminId = 'p107-outsider-admin';
  const merchantId = 'p107-merchant';
  const otherMerchantId = 'p107-merchant-2';
  const shop = { lat: 16.043, lng: 120.333 };
  const otherShop = { lat: 16.044, lng: 120.335 };

  const token = (id: string, role = 'user') =>
    jwt.sign({ id, seed_id: `${id}-seed`, role, typ: 'session' }, env.JWT_SECRET);
  const day = (n: number) => new Date(Date.UTC(2026, 10, 10 + n, 4, 0, 0)); // 12:00 Manila on Nov 10+n
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
  const visit = (userId: string, now: Date, overrides: Record<string, unknown> = {}) =>
    standee().then((s) =>
      svc.recordStandeeVisit(
        userId,
        {
          standee: s,
          lat: shop.lat,
          lng: shop.lng,
          accuracy_m: 10,
          idempotency_key: randomUUID(),
          ...overrides,
        } as any,
        now,
      ),
    );
  const expectCode = async (promise: Promise<unknown>, code: string) => {
    await expect(promise).rejects.toMatchObject({ code });
  };

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    svc = new SukiService(fixture.pool);
    const users: Array<[string, string, boolean]> = [
      [ownerId, 'user', false],
      [staffId, 'user', false],
      [otherOwnerId, 'user', false],
      [aliceId, 'user', false],
      [bobId, 'user', false],
      [unverifiedId, 'user', false],
      [testUserId, 'user', true],
      [platformId, 'admin', false],
      [areaAdminId, 'area_admin', false],
      [outsiderAdminId, 'area_admin', false],
    ];
    const created = new Date('2026-01-01T00:00:00Z').toISOString();
    for (const [id, role, isTest] of users) {
      await fixture.pool.query(
        `INSERT INTO users(id, seed_id, display_name, email, handle, role, admin_scope, is_public, is_test, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [
          id,
          `${id}-seed`,
          id,
          `${id}@test.local`,
          id.replace(/-/g, ''),
          role,
          role === 'admin' ? 'developer' : null,
          isTest,
          created,
        ],
      );
      db.users.push({
        id,
        seed_id: `${id}-seed`,
        display_name: id,
        email: `${id}@test.local`,
        handle: id.replace(/-/g, ''),
        avatar_url: '',
        role: role as any,
        admin_scope: role === 'admin' ? 'developer' : null,
        is_public: true,
        is_test: isTest,
        created_at: created,
        updated_at: created,
      } as any);
    }
    await fixture.pool.query(
      `INSERT INTO account_emails(id, user_id, email, normalized_email, is_verified, is_primary)
       VALUES ($1, $2, 'unverified@test.local', 'unverified@test.local', FALSE, TRUE)`,
      [randomUUID(), unverifiedId],
    );
    await fixture.pool.query(
      `INSERT INTO admin_areas(id, level, name, display_name, parent_id, has_boundary, label_lat, label_lng, bbox, min_zoom, boundary)
       VALUES ('p107-pangasinan','province','Pangasinan','Pangasinan',NULL,FALSE,16.0,120.3,$1,5,NULL),
              ('p107-dagupan','town','Dagupan City','Dagupan City','p107-pangasinan',FALSE,16.043,120.333,$2,8,NULL),
              ('p107-la-union','province','La Union','La Union',NULL,FALSE,16.6,120.3,$3,5,NULL)
       ON CONFLICT (id) DO NOTHING`,
      [
        [119.8, 15.8, 120.8, 16.4],
        [120.3, 16.01, 120.37, 16.08],
        [120.2, 16.4, 120.5, 16.8],
      ],
    );
    await fixture.pool.query(
      `INSERT INTO admin_area_assignments(id, user_id, area_id, powers, granted_by)
       VALUES ('p107-grant-in', $1, 'p107-dagupan', ARRAY['merchants_vouchers']::text[], $3),
              ('p107-grant-out', $2, 'p107-la-union', ARRAY['merchants_vouchers']::text[], $3)
       ON CONFLICT (id) DO NOTHING`,
      [areaAdminId, outsiderAdminId, platformId],
    );
    await fixture.pool.query(
      `INSERT INTO merchants(id, name, location, description, status, is_published, municipality, town_area_id, gps_lat, gps_lng)
       VALUES ($1, 'Aling Nena Cafe', 'Dagupan', 'Fixture shop', 'active', TRUE, 'Dagupan City', 'p107-dagupan', $2, $3),
              ($4, 'Bonuan Bakery', 'Dagupan', 'Second shop', 'active', TRUE, 'Dagupan City', 'p107-dagupan', $5, $6)`,
      [merchantId, shop.lat, shop.lng, otherMerchantId, otherShop.lat, otherShop.lng],
    );
    await fixture.pool.query(
      `INSERT INTO merchant_memberships(id, merchant_id, user_id, role, status)
       VALUES ($1,$2,$3,'owner','active'), ($4,$2,$5,'staff','active'), ($6,$7,$8,'owner','active')`,
      [randomUUID(), merchantId, ownerId, randomUUID(), staffId, randomUUID(), otherMerchantId, otherOwnerId],
    );
    await fixture.pool.query(
      `INSERT INTO vouchers(id, merchant_id, title, description, cost_points, is_active)
       VALUES ('p107-voucher', $1, 'Free halo-halo', 'Fixture voucher', 10, TRUE),
              ('p107-voucher-2', $2, 'Pandesal pack', 'Other shop voucher', 10, TRUE)`,
      [merchantId, otherMerchantId],
    );
    db.usersRepo.setPool(fixture.pool);
    await setSettings({ suki_enabled: true });
  });

  afterAll(async () => {
    setPool(null);
    db.usersRepo.setPool(null);
    await fixture?.close();
  });

  it('is placed after 102 in the migration ledger', () => {
    expect(MIGRATIONS).toContain('103_suki_cards.sql');
    expect(MIGRATIONS.indexOf('103_suki_cards.sql')).toBeGreaterThan(MIGRATIONS.indexOf('102_nearby_quest_push.sql'));
  });

  it('is off by default: every Suki route except reading your own cards says SUKI_DISABLED', async () => {
    await setSettings({ suki_enabled: false });
    const res = await request(app)
      .put('/api/v1/merchant/suki')
      .set('Authorization', `Bearer ${token(ownerId)}`)
      .send({ title: 'Suki Card', reward_kind: 'free_item', reward_text: 'Free iced coffee' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SUKI_DISABLED');
    const owner = `Bearer ${token(ownerId)}`;
    // A customer the later HTTP tests don't use, so the visit rate limit (6/min) is not spent here.
    const alice = `Bearer ${token(unverifiedId)}`;
    const routes: Array<[string, string, string, Record<string, unknown>?]> = [
      ['get', '/api/v1/suki/programs', alice],
      ['get', '/api/v1/suki/programs/suki_x', alice],
      [
        'post',
        '/api/v1/suki/visits',
        alice,
        {
          standee: 'https://juanderquest.app/suki/x?v=1&s=00',
          lat: 16,
          lng: 120,
          accuracy_m: 5,
          idempotency_key: 'disabled-1',
        },
      ],
      ['post', '/api/v1/suki/pass', alice, { program_id: 'suki_x' }],
      ['get', '/api/v1/suki/pass/status?program_id=suki_x', alice],
      ['get', '/api/v1/merchant/suki', owner],
      ['put', '/api/v1/merchant/suki/location', owner, { lat: 16, lng: 120, accuracy_m: 5 }],
      ['post', '/api/v1/merchant/suki/activate', owner],
      ['post', '/api/v1/merchant/suki/pause', owner],
      ['get', '/api/v1/merchant/suki/standee', owner],
      ['post', '/api/v1/merchant/suki/standee/rotate', owner],
      ['post', '/api/v1/merchant/suki/scan', owner, { code: 'SUKI-AAAAAA-BBBBBB' }],
      ['get', '/api/v1/merchant/suki/stats', owner],
    ];
    for (const [method, path, auth, body] of routes) {
      const agent = request(app) as any;
      const r = await agent[method](path)
        .set('Authorization', auth)
        .send(body ?? {});
      expect([path, r.status, r.body.error?.code]).toEqual([path, 503, 'SUKI_DISABLED']);
    }
    const mine = await request(app)
      .get('/api/v1/me/suki-cards')
      .set('Authorization', `Bearer ${token(aliceId)}`);
    expect(mine.status).toBe(200);
    await setSettings({ suki_enabled: true });
  });

  it('owner sets up the card (10 visits default, reward types validated); staff cannot', async () => {
    const auth = { Authorization: `Bearer ${token(ownerId)}` };
    const bad = await request(app)
      .put('/api/v1/merchant/suki')
      .set(auth)
      .send({ title: 'Suki Card', reward_kind: 'percent_off', reward_value: 150, reward_text: '150% off' });
    expect(bad.status).toBe(400);
    const missing = await request(app)
      .put('/api/v1/merchant/suki')
      .set(auth)
      .send({ title: 'Suki Card', reward_kind: 'amount_off', reward_text: 'Peso off' });
    expect(missing.status).toBe(400);

    const ok = await request(app)
      .put('/api/v1/merchant/suki')
      .set(auth)
      .send({ title: 'Kape Suki', reward_kind: 'free_item', reward_value: 99, reward_text: 'Free iced coffee' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.program).toMatchObject({
      visits_required: 10,
      reward_kind: 'free_item',
      reward_value: null,
      reward_tag: 'FREE',
      status: 'draft',
    });

    const staff = await request(app)
      .post('/api/v1/merchant/suki/activate')
      .set('Authorization', `Bearer ${token(staffId)}`);
    expect(staff.status).toBe(403);
    expect(staff.body.error.code).toBe('MERCHANT_OWNER_REQUIRED');
    const nobody = await request(app)
      .get('/api/v1/merchant/suki')
      .set('Authorization', `Bearer ${token(aliceId)}`);
    expect(nobody.status).toBe(403);
  });

  it('activation needs a pinned location; ₱ off shows its tag', async () => {
    await fixture.pool.query('UPDATE merchants SET gps_lat = NULL, gps_lng = NULL WHERE id = $1', [merchantId]);
    const auth = { Authorization: `Bearer ${token(ownerId)}` };
    const blocked = await request(app).post('/api/v1/merchant/suki/activate').set(auth);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('SHOP_LOCATION_MISSING');
    const weak = await request(app)
      .put('/api/v1/merchant/suki/location')
      .set(auth)
      .send({ lat: shop.lat, lng: shop.lng, accuracy_m: 80 });
    expect(weak.status).toBe(422);
    const pinned = await request(app)
      .put('/api/v1/merchant/suki/location')
      .set(auth)
      .send({ lat: shop.lat, lng: shop.lng, accuracy_m: 12 });
    expect(pinned.body.data.checklist.has_location).toBe(true);

    const amount = await request(app).put('/api/v1/merchant/suki').set(auth).send({
      title: 'Kape Suki',
      reward_kind: 'amount_off',
      reward_value: 20,
      reward_text: '₱20 off any drink',
      visits_required: 3,
    });
    expect(amount.body.data.program.reward_tag).toBe('₱20 OFF');
    const active = await request(app).post('/api/v1/merchant/suki/activate').set(auth);
    expect(active.status).toBe(200);
    expect(active.body.data.program.status).toBe('active');
  });

  it('standee visits: signature, version, geofence, accuracy, daily limit, idempotency', async () => {
    const auth = { Authorization: `Bearer ${token(aliceId)}` };
    const url = await standee();
    expect(parseStandee(url)?.signatureOk).toBe(true);

    const forged = await request(app)
      .post('/api/v1/suki/visits')
      .set(auth)
      .send({
        standee: url.replace(/s=[0-9a-f]+/, 's=0000000000000000'),
        lat: shop.lat,
        lng: shop.lng,
        accuracy_m: 10,
        idempotency_key: 'forged-key-1',
      });
    expect(forged.body.error.code).toBe('STANDEE_INVALID');

    const far = await request(app)
      .post('/api/v1/suki/visits')
      .set(auth)
      .send({ standee: url, lat: shop.lat + 0.01, lng: shop.lng, accuracy_m: 10, idempotency_key: 'far-key-0001' });
    expect(far.status).toBe(422);
    expect(far.body.error.code).toBe('OUT_OF_RANGE');
    expect(far.body.error.details.distance_m).toBeGreaterThan(1000);

    const fuzzy = await request(app)
      .post('/api/v1/suki/visits')
      .set(auth)
      .send({ standee: url, lat: shop.lat, lng: shop.lng, accuracy_m: 150, idempotency_key: 'fuzzy-key-01' });
    expect(fuzzy.body.error.code).toBe('LOCATION_ACCURACY_TOO_LOW');

    const ok = await request(app)
      .post('/api/v1/suki/visits')
      .set(auth)
      .send({ standee: url, lat: shop.lat + 0.0003, lng: shop.lng, accuracy_m: 10, idempotency_key: 'first-key-01' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.card).toMatchObject({ visits: 1, required: 3, visited_today: true });
    expect(ok.body.data.xp_awarded).toBe(5);

    const replay = await request(app)
      .post('/api/v1/suki/visits')
      .set(auth)
      .send({ standee: url, lat: shop.lat, lng: shop.lng, accuracy_m: 10, idempotency_key: 'first-key-01' });
    expect(replay.status).toBe(201);
    expect(replay.body.data.replayed).toBe(true);
    expect(replay.body.data.visit_id).toBe(ok.body.data.visit_id);

    const again = await request(app)
      .post('/api/v1/suki/visits')
      .set(auth)
      .send({ standee: url, lat: shop.lat, lng: shop.lng, accuracy_m: 10, idempotency_key: 'second-key-1' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_VISITED_TODAY');
    expect(again.body.error.details.next_at).toBeTruthy();
    const count = await fixture.pool.query('SELECT COUNT(*)::int AS n FROM suki_visits WHERE user_id = $1', [aliceId]);
    expect(count.rows[0].n).toBe(1);
  });

  it('members, unverified emails and test accounts cannot collect visits', async () => {
    await expectCode(visit(ownerId, day(1)), 'SELF_VISIT_FORBIDDEN');
    await expectCode(visit(staffId, day(1)), 'SELF_VISIT_FORBIDDEN');
    await expectCode(visit(unverifiedId, day(1)), 'EMAIL_NOT_VERIFIED');
    await expectCode(visit(testUserId, day(1)), 'SUKI_NOT_FOUND');
  });

  it('the Nth visit issues the reward, resets the card, and only the next cycle uses an edited visit count', async () => {
    const first = await visit(bobId, day(1));
    expect(first.card.visits).toBe(1);
    await visit(bobId, day(2));
    // Owner raises the card to 5 visits mid-cycle: Bob's current cycle still ends at 3.
    await svc.upsertProgram(ownerId, {
      title: 'Kape Suki',
      reward_kind: 'amount_off',
      reward_value: 20,
      reward_text: '₱20 off any drink',
      visits_required: 5,
    });
    const third = await visit(bobId, day(3));
    expect(third.reward_issued).toMatchObject({
      reward_kind: 'amount_off',
      reward_value: 20,
      reward_tag: '₱20 OFF',
      status: 'issued',
    });
    expect(third.reward_issued!.code).toMatch(/^SUKI-[0-9A-F]{6}-[0-9A-F]{6}$/);
    expect(third.card).toMatchObject({ visits: 0, cycle: 2, required: 5, total_visits: 3 });
    expect(third.badges).toContain('suki_first_card');

    const notes = await fixture.pool.query(`SELECT kind, href FROM user_notifications WHERE user_id = $1`, [bobId]);
    expect(notes.rows).toEqual([expect.objectContaining({ kind: 'suki_reward' })]);

    const mine = await svc.listMyCards(bobId, day(3));
    expect(mine.cards[0].rewards).toHaveLength(1);
    expect(mine.cards[0].reward).toMatchObject({ code: third.reward_issued!.code, status: 'issued', expired: false });
    expect(mine.cards[0].program.merchant.name).toBe('Aling Nena Cafe');
  });

  it('XP is only given for the first N Suki visits a day', async () => {
    await setSettings({ suki_xp_visits_per_day: 1 });
    await fixture.pool.query(`UPDATE suki_programs SET status = 'active' WHERE merchant_id = $1`, [merchantId]);
    await svc.upsertProgram(otherOwnerId, {
      title: 'Bakery Suki',
      reward_kind: 'promo',
      reward_text: 'Buy 1 Take 1 ensaymada',
    });
    await svc.setLocation(otherOwnerId, { ...otherShop, accuracy_m: 5 });
    await svc.activate(otherOwnerId);
    const a = await visit(aliceId, day(4));
    const otherUrl = await standee(otherMerchantId);
    const b = await svc.recordStandeeVisit(
      aliceId,
      { standee: otherUrl, lat: otherShop.lat, lng: otherShop.lng, accuracy_m: 10, idempotency_key: randomUUID() },
      new Date(day(4).getTime() + 60_000),
    );
    expect(a.xp_awarded).toBe(5);
    expect(b.xp_awarded).toBe(0);
    expect(b.program.reward_tag).toBe('PROMO');
    await setSettings({ suki_xp_visits_per_day: 3 });
  });

  it('flags impossible travel between shops without blocking the visit', async () => {
    await fixture.pool.query('UPDATE merchants SET gps_lat = 18.2, gps_lng = 120.6 WHERE id = $1', [otherMerchantId]);
    const p = await program(otherMerchantId);
    const res = await svc.recordStandeeVisit(
      bobId,
      {
        standee: standeeUrl(p.id, p.standee_version),
        lat: 18.2,
        lng: 120.6,
        accuracy_m: 10,
        idempotency_key: randomUUID(),
      },
      new Date(day(3).getTime() + 10 * 60_000),
    );
    expect(res.card.visits).toBe(1);
    const flagged = await fixture.pool.query('SELECT flagged_reason FROM suki_visits WHERE id = $1', [res.visit_id]);
    expect(flagged.rows[0].flagged_reason).toBe('impossible_travel');
    await fixture.pool.query('UPDATE merchants SET gps_lat = $2, gps_lng = $3 WHERE id = $1', [
      otherMerchantId,
      otherShop.lat,
      otherShop.lng,
    ]);
  });

  it('rotating the standee replaces old prints', async () => {
    const old = await standee();
    const rotated = await request(app)
      .post('/api/v1/merchant/suki/standee/rotate')
      .set('Authorization', `Bearer ${token(ownerId)}`);
    expect(rotated.status).toBe(200);
    expect(rotated.body.data.url).not.toBe(old);
    await expectCode(
      svc.recordStandeeVisit(
        aliceId,
        { standee: old, lat: shop.lat, lng: shop.lng, accuracy_m: 10, idempotency_key: randomUUID() },
        day(5),
      ),
      'STANDEE_REPLACED',
    );
  });

  it('staff-scan shops: pass is single use, expires, and is shop-bound', async () => {
    await svc.upsertProgram(ownerId, {
      title: 'Kape Suki',
      reward_kind: 'amount_off',
      reward_value: 20,
      reward_text: '₱20 off any drink',
      visits_required: 5,
      mode: 'staff_scan',
    });
    await expectCode(visit(aliceId, day(6)), 'SUKI_STAFF_SCAN_ONLY');

    const p = await program();
    const issued = await request(app)
      .post('/api/v1/suki/pass')
      .set('Authorization', `Bearer ${token(bobId)}`)
      .send({ program_id: p.id });
    expect(issued.status).toBe(200);
    const pass = issued.body.data.pass as string;
    expect(pass.startsWith('JDQSUKIPASS:')).toBe(true);

    const otherShopScan = await request(app)
      .post('/api/v1/merchant/suki/scan')
      .set('Authorization', `Bearer ${token(otherOwnerId)}`)
      .send({ code: pass });
    expect(otherShopScan.body.error.code).toBe('PASS_OTHER_SHOP');

    // Fixed dates: Bob's earlier visits were on day(1..3); the scan lands on day(9).
    const scanned = await svc.scan(staffId, pass, day(9));
    expect(scanned.kind).toBe('visit');
    expect(scanned.customer).toMatch(/^Suki #[0-9A-F]{3}$/);
    expect((await svc.passStatus(bobId, p.id, day(9))).visited_today).toBe(true);

    const reused = await svc.scan(staffId, pass, new Date(day(7).getTime())).catch((e) => e);
    expect(reused.code).toBe('PASS_USED');

    const expired = jwt.sign({ typ: 'suki_pass', programId: p.id, userId: bobId, jti: randomUUID() }, env.JWT_SECRET, {
      expiresIn: -10,
    });
    await expectCode(svc.scan(staffId, `JDQSUKIPASS:${expired}`), 'PASS_EXPIRED');
    const own = signSukiPass(p.id, ownerId);
    await expectCode(svc.scan(staffId, own.pass, day(8)), 'SELF_VISIT_FORBIDDEN');
  });

  it('counter scanner claims Suki rewards once, refuses other shops and expired rewards', async () => {
    const reward = (await fixture.pool.query(`SELECT * FROM suki_rewards WHERE user_id = $1`, [bobId])).rows[0];
    await expectCode(svc.scan(otherOwnerId, reward.code), 'REWARD_NOT_FOUND');
    const typed = `  ${reward.code.toLowerCase().replace('-', ' - ')} `;
    const claimed = await svc.scan(staffId, typed);
    expect(claimed).toMatchObject({ kind: 'reward', title: 'Reward claimed', detail: '₱20 off any drink' });
    const after = await svc.listMyCards(bobId);
    const card = after.cards.find((c) => c.card_id === reward.card_id)!;
    expect(card.reward).toMatchObject({ code: reward.code, status: 'claimed' });
    expect(card.rewards).toHaveLength(0);
    await expectCode(svc.scan(staffId, reward.code), 'REWARD_ALREADY_CLAIMED');

    await fixture.pool.query(
      `INSERT INTO suki_rewards (id, card_id, program_id, user_id, cycle, reward_kind, reward_value, reward_text, code, expires_at)
       VALUES ('p107-old', $1, $2, $3, 99, 'free_item', NULL, 'Old reward', 'SUKI-AAAAAA-BBBBBB', NOW() - INTERVAL '1 day')`,
      [reward.card_id, reward.program_id, bobId],
    );
    await expectCode(svc.scan(staffId, 'SUKI-AAAAAA-BBBBBB'), 'REWARD_EXPIRED');
  });

  it('counter scanner confirms Shop vouchers for its own merchant only, once', async () => {
    await fixture.pool.query(
      `INSERT INTO redemptions (id, voucher_id, user_id, code, cost_points, idempotency_key)
       VALUES ('p107-red-1', 'p107-voucher', $1, 'JDQ-ABC123-DEF456', 10, 'p107-red-key-1'),
              ('p107-red-2', 'p107-voucher-2', $1, 'JDQ-111111-222222', 10, 'p107-red-key-2')`,
      [aliceId],
    );
    await expectCode(svc.scan(staffId, 'JDQ-111111-222222'), 'CODE_NOT_FOUND');
    const used = await request(app)
      .post('/api/v1/merchant/suki/scan')
      .set('Authorization', `Bearer ${token(staffId)}`)
      .send({ code: 'jdq-abc123-def456' });
    expect(used.status).toBe(200);
    expect(used.body.data).toMatchObject({ kind: 'voucher', detail: 'Free halo-halo' });
    await expectCode(svc.scan(staffId, 'JDQ-ABC123-DEF456'), 'CODE_ALREADY_USED');
    await expectCode(svc.scan(staffId, 'HELLO-WORLD'), 'CODE_UNKNOWN');

    const mine = await request(app)
      .get('/api/v1/me/redemptions')
      .set('Authorization', `Bearer ${token(aliceId)}`);
    const row = mine.body.data.items.find((item: any) => item.code === 'JDQ-ABC123-DEF456');
    expect(row.used_at).toBeTruthy();
    expect(row.merchant.name).toBe('Aling Nena Cafe');
  });

  it('merchant stats are aggregates with pseudonyms only', async () => {
    const stats = await svc.stats(ownerId, 30, day(8));
    expect(stats.unique_customers).toBe(2);
    expect(stats.repeat_customers).toBeGreaterThanOrEqual(1);
    expect(stats.rewards_issued).toBeGreaterThanOrEqual(1);
    expect(stats.rewards_claimed).toBe(1);
    expect(stats.vouchers_confirmed).toBe(1);
    expect(stats.new_to_app).toBe(0);
    const text = JSON.stringify(stats);
    expect(text).not.toContain(aliceId);
    expect(text).not.toContain(bobId);
    expect(stats.top_regulars[0].label).toMatch(/^Suki #/);
  });

  it('area admins see and pause cards in their town only; an admin pause blocks reactivation', async () => {
    const p = await program();
    const outsider = await request(app)
      .get('/api/v1/admin/suki/programs')
      .set('Authorization', `Bearer ${token(outsiderAdminId, 'area_admin')}`);
    expect(outsider.status).toBe(200);
    expect(outsider.body.data.items).toEqual([]);
    const outsiderPause = await request(app)
      .post(`/api/v1/admin/suki/programs/${p.id}/pause`)
      .set('Authorization', `Bearer ${token(outsiderAdminId, 'area_admin')}`)
      .send({ reason: 'Not my town' });
    expect(outsiderPause.status).toBe(404);

    const inside = await request(app)
      .get('/api/v1/admin/suki/programs')
      .set('Authorization', `Bearer ${token(areaAdminId, 'area_admin')}`);
    expect(inside.body.data.items.map((i: any) => i.merchant_id).sort()).toEqual([merchantId, otherMerchantId]);

    const paused = await request(app)
      .post(`/api/v1/admin/suki/programs/${p.id}/pause`)
      .set('Authorization', `Bearer ${token(areaAdminId, 'area_admin')}`)
      .send({ reason: 'Reported fake visits' });
    expect(paused.status).toBe(200);
    expect(paused.body.data).toMatchObject({ status: 'paused', paused_by: 'admin' });
    const audit = await fixture.pool.query(`SELECT action FROM admin_audit_log WHERE subject_id = $1`, [p.id]);
    expect(audit.rows.map((r) => r.action)).toContain('suki.pause');

    await expectCode(svc.activate(ownerId), 'SUKI_ADMIN_PAUSED');
    await svc.pause(ownerId);
    expect((await program()).paused_by).toBe('admin');

    const towns = await request(app)
      .get('/api/v1/admin/suki/towns')
      .set('Authorization', `Bearer ${token(platformId, 'admin')}`);
    expect(towns.status).toBe(200);
    expect(towns.body.data.items.length).toBeGreaterThan(0);

    const resumed = await request(app)
      .post(`/api/v1/admin/suki/programs/${p.id}/resume`)
      .set('Authorization', `Bearer ${token(areaAdminId, 'area_admin')}`);
    expect(resumed.body.data).toMatchObject({ status: 'active', paused_by: null });
  });

  it('public program read and the customer card list', async () => {
    const p = await program(otherMerchantId);
    const pub = await request(app).get(`/api/v1/suki/programs/${p.id}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.program).toMatchObject({ title: 'Bakery Suki', reward_tag: 'PROMO', visits_required: 10 });
    expect(pub.body.data.my_card).toBeNull();
    const near = await request(app)
      .get(`/api/v1/suki/programs?lat=${shop.lat}&lng=${shop.lng}`)
      .set('Authorization', `Bearer ${token(aliceId)}`);
    expect(near.body.data.programs[0].merchant.name).toBe('Aling Nena Cafe');
    expect(near.body.data.programs[0].distance_m).toBeLessThan(5);
    const cards = await request(app)
      .get('/api/v1/me/suki-cards')
      .set('Authorization', `Bearer ${token(aliceId)}`);
    expect(cards.body.data.cards.length).toBe(2);
  });

  it('a visit completes the check_in mission after commit; a hook failure does not undo the visit', async () => {
    const carolId = 'p107-carol';
    const daveId = 'p107-dave';
    for (const [id, created] of [
      [carolId, new Date(day(10).getTime() - 3 * 86_400_000)],
      [daveId, new Date(day(10).getTime() - 30 * 86_400_000)],
    ] as Array<[string, Date]>) {
      await fixture.pool.query(
        `INSERT INTO users(id, seed_id, display_name, email, handle, role, is_public, is_test, created_at)
         VALUES ($1,$2,$6,$3,$4,'user',TRUE,FALSE,$5)`,
        [id, `${id}-seed`, `${id}@test.local`, id.replace(/-/g, ''), created.toISOString(), id],
      );
    }
    const date = manilaDateString(day(10));
    const mission = await fixture.pool.query(`SELECT id FROM daily_missions WHERE kind = 'check_in'`);
    await fixture.pool.query(
      `INSERT INTO user_daily_missions(user_id, manila_date, mission_id, progress, target) VALUES ($1,$2,$3,0,1)`,
      [carolId, date, mission.rows[0].id],
    );
    const p = await program(otherMerchantId);
    const url = standeeUrl(p.id, p.standee_version);
    const body = { standee: url, lat: otherShop.lat, lng: otherShop.lng, accuracy_m: 10 };
    const done = await svc.recordStandeeVisit(carolId, { ...body, idempotency_key: randomUUID() }, day(10));
    expect(done.mission_completed).toBe(true);
    const row = await fixture.pool.query(
      'SELECT completed_at FROM user_daily_missions WHERE user_id = $1 AND manila_date = $2',
      [carolId, date],
    );
    expect(row.rows[0].completed_at).toBeTruthy();

    // The mission hook reads through the pool; make that read fail. The visit (its own transaction) stays.
    const brokenPool = {
      query: (text: any, ...rest: any[]) =>
        typeof text === 'string' && text.includes('user_daily_missions')
          ? Promise.reject(new Error('mission store down'))
          : (fixture.pool.query as any)(text, ...rest),
      connect: () => fixture.pool.connect(),
    } as any;
    const broken = new SukiService(brokenPool);
    const kept = await broken.recordStandeeVisit(daveId, { ...body, idempotency_key: randomUUID() }, day(10));
    expect(kept.mission_completed).toBe(false);
    const stored = await fixture.pool.query('SELECT 1 FROM suki_visits WHERE id = $1', [kept.visit_id]);
    expect(stored.rows).toHaveLength(1);

    // new_to_app: Carol joined 3 days before her first visit here, Dave 30 days before.
    const stats = await svc.stats(otherOwnerId, 30, day(10));
    expect(stats.new_to_app).toBe(1);
  });

  it('each badge is awarded once', async () => {
    const awards = await fixture.pool.query(
      `SELECT achievement_id, COUNT(*)::int AS n FROM achievement_awards WHERE user_id = $1 GROUP BY achievement_id`,
      [bobId],
    );
    expect(awards.rows).toEqual([{ achievement_id: 'suki_first_card', n: 1 }]);
  });
});
