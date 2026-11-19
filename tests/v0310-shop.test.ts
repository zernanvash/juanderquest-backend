import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { env } from '../src/config/env.js';
import { SukiService } from '../src/suki/service.js';
import { SponsorshipService } from '../src/funding/sponsorships.js';

const realPgDescribe = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

/** v0.3.10 team review, Shop track: voucher counter, specialty pins, merchant page, own shop hidden. */
realPgDescribe('v0.3.10 shop (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const ownerId = 'v310-owner';
  const staffId = 'v310-staff';
  const otherOwnerId = 'v310-other-owner';
  const aliceId = 'v310-alice';
  const merchantId = 'v310-merchant';
  const otherMerchantId = 'v310-merchant-2';
  const draftMerchantId = 'v310-merchant-draft';

  const token = (id: string) => jwt.sign({ id, seed_id: `${id}-seed`, role: 'user', typ: 'session' }, env.JWT_SECRET);
  const auth = (id: string) => `Bearer ${token(id)}`;
  const setSettings = (values: Record<string, unknown>) =>
    fixture.pool.query(`UPDATE system_settings_document SET values = values || $1::jsonb WHERE id = 1`, [
      JSON.stringify(values),
    ]);

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    const created = new Date('2026-01-01T00:00:00Z').toISOString();
    for (const id of [ownerId, staffId, otherOwnerId, aliceId]) {
      await fixture.pool.query(
        `INSERT INTO users(id, seed_id, display_name, email, handle, role, is_public, is_test, created_at)
         VALUES ($1,$2,$6,$3,$4,'user',TRUE,FALSE,$5) ON CONFLICT (id) DO NOTHING`,
        [id, `${id}-seed`, `${id}@test.local`, id.replace(/-/g, ''), created, id],
      );
      db.users.push({
        id,
        seed_id: `${id}-seed`,
        display_name: id,
        email: `${id}@test.local`,
        handle: id.replace(/-/g, ''),
        avatar_url: '',
        role: 'user',
        is_public: true,
        is_test: false,
        created_at: created,
        updated_at: created,
      } as any);
    }
    await fixture.pool.query(
      `INSERT INTO merchants(id, name, location, description, status, is_published, municipality, gps_lat, gps_lng,
                             contact_phone, banner_url)
       VALUES ($1, 'Aling Nena Cafe', 'Dagupan', 'Fixture shop', 'active', TRUE, 'Dagupan City', 16.043, 120.333,
               '09170000000', 'https://cdn.example/cover.jpg'),
              ($2, 'Bonuan Bakery', 'Dagupan', 'Second shop', 'active', TRUE, 'Dagupan City', 16.044, 120.335, NULL, NULL),
              ($3, 'Draft Diner', 'Dagupan', 'Not published', 'active', FALSE, 'Dagupan City', NULL, NULL, NULL, NULL)`,
      [merchantId, otherMerchantId, draftMerchantId],
    );
    await fixture.pool.query(
      `INSERT INTO merchant_memberships(id, merchant_id, user_id, role, status)
       VALUES ('v310-mm-1',$1,$2,'owner','active'), ('v310-mm-2',$1,$3,'staff','active'),
              ('v310-mm-3',$4,$5,'owner','active'), ('v310-mm-4',$6,$5,'staff','active')`,
      [merchantId, ownerId, staffId, otherMerchantId, otherOwnerId, draftMerchantId],
    );
    await fixture.pool.query(
      `INSERT INTO vouchers(id, merchant_id, title, description, cost_points, is_active)
       VALUES ('v310-voucher', $1, 'Free halo-halo', 'Fixture voucher', 10, TRUE),
              ('v310-voucher-2', $2, 'Pandesal pack', 'Other shop voucher', 10, TRUE)`,
      [merchantId, otherMerchantId],
    );
    await fixture.pool.query(
      `INSERT INTO merchant_products(id, merchant_id, name, description, price, is_published, is_archived, display_order)
       VALUES ('v310-p1',$1,'Bangus sisig','',150,TRUE,FALSE,1), ('v310-p2',$1,'Halo-halo','',90,TRUE,FALSE,2),
              ('v310-p3',$1,'Kapeng barako','',60,TRUE,FALSE,3), ('v310-p4',$1,'Puto','',40,TRUE,FALSE,4),
              ('v310-p5',$1,'Hidden draft','',10,FALSE,FALSE,5), ('v310-p6',$2,'Pandesal','',5,TRUE,FALSE,1)`,
      [merchantId, otherMerchantId],
    );
    db.usersRepo.setPool(fixture.pool);
    await setSettings({ suki_enabled: false });
  });

  afterAll(async () => {
    setPool(null);
    db.usersRepo.setPool(null);
    await fixture?.close();
  });

  it('places migration 104 after 103 and adds merchant_products.specialty_at', async () => {
    expect(MIGRATIONS.indexOf('104_merchant_specialty_pins.sql')).toBeGreaterThan(
      MIGRATIONS.indexOf('103_suki_cards.sql'),
    );
    const col = await fixture.pool.query(
      `SELECT data_type FROM information_schema.columns WHERE table_name = 'merchant_products' AND column_name = 'specialty_at'`,
    );
    expect(col.rows[0]?.data_type).toBe('timestamp with time zone');
  });

  describe('voucher counter with Suki Cards switched off', () => {
    beforeAll(async () => {
      await fixture.pool.query(
        `INSERT INTO redemptions (id, voucher_id, user_id, code, cost_points, idempotency_key)
         VALUES ('v310-red-1', 'v310-voucher', $1, 'JDQ-AAA111-BBB222', 10, 'v310-red-key-1'),
                ('v310-red-2', 'v310-voucher-2', $1, 'JDQ-CCC333-DDD444', 10, 'v310-red-key-2')`,
        [aliceId],
      );
    });

    it('confirms a JDQ voucher code once, for that shop only, and the traveler sees Used', async () => {
      const scan = (who: string, code: string) =>
        request(app).post('/api/v1/merchant/suki/scan').set('Authorization', auth(who)).send({ code });
      const other = await scan(staffId, 'JDQ-CCC333-DDD444');
      expect([other.status, other.body.error?.code]).toEqual([404, 'CODE_NOT_FOUND']);
      const ok = await scan(staffId, ' jdq-aaa111-bbb222 ');
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ kind: 'voucher', title: 'Voucher confirmed', detail: 'Free halo-halo' });
      const again = await scan(ownerId, 'JDQ-AAA111-BBB222');
      expect([again.status, again.body.error?.code]).toEqual([409, 'CODE_ALREADY_USED']);
      const mine = await request(app).get('/api/v1/me/redemptions').set('Authorization', auth(aliceId));
      const used = mine.body.data.items.find((r: any) => r.code === 'JDQ-AAA111-BBB222');
      expect(used.used_at).not.toBeNull();
      expect(mine.body.data.items.find((r: any) => r.code === 'JDQ-CCC333-DDD444').used_at).toBeNull();
    });

    it('still refuses Suki codes and non-members while Suki is off', async () => {
      const suki = await request(app)
        .post('/api/v1/merchant/suki/scan')
        .set('Authorization', auth(ownerId))
        .send({ code: 'SUKI-AAAAAA-BBBBBB' });
      expect([suki.status, suki.body.error?.code]).toEqual([503, 'SUKI_DISABLED']);
      const outsider = await request(app)
        .post('/api/v1/merchant/suki/scan')
        .set('Authorization', auth(aliceId))
        .send({ code: 'JDQ-CCC333-DDD444' });
      expect([outsider.status, outsider.body.error?.code]).toEqual([403, 'MERCHANT_MEMBERSHIP_REQUIRED']);
    });
  });

  describe('specialty pins', () => {
    const pin = (who: string, id: string, pinned = true) =>
      request(app).put(`/api/v1/merchant/products/${id}/specialty`).set('Authorization', auth(who)).send({ pinned });

    it('lets the owner pin up to 3 published products', async () => {
      for (const id of ['v310-p2', 'v310-p1', 'v310-p3']) {
        const r = await pin(ownerId, id);
        expect([id, r.status, r.body.data?.is_specialty]).toEqual([id, 200, true]);
      }
      const replay = await pin(ownerId, 'v310-p1');
      expect(replay.status).toBe(200);
      const fourth = await pin(ownerId, 'v310-p4');
      expect([fourth.status, fourth.body.error?.code]).toEqual([409, 'SPECIALTY_LIMIT']);
    });

    it('refuses staff, other shops, drafts and bad bodies', async () => {
      const staff = await pin(staffId, 'v310-p4');
      expect([staff.status, staff.body.error?.code]).toEqual([403, 'MERCHANT_OWNER_REQUIRED']);
      const foreign = await pin(ownerId, 'v310-p6');
      expect([foreign.status, foreign.body.error?.code]).toEqual([404, 'PRODUCT_NOT_FOUND']);
      const outsider = await pin(aliceId, 'v310-p4');
      expect(outsider.status).toBe(403);
      const unpinFirst = await pin(ownerId, 'v310-p3', false);
      expect(unpinFirst.body.data.is_specialty).toBe(false);
      const draft = await pin(ownerId, 'v310-p5');
      expect([draft.status, draft.body.error?.code]).toEqual([409, 'PRODUCT_NOT_PUBLISHED']);
      const bad = await request(app)
        .put('/api/v1/merchant/products/v310-p4/specialty')
        .set('Authorization', auth(ownerId))
        .send({ pinned: 'yes' });
      expect(bad.status).toBe(400);
    });
  });

  describe('public merchant page', () => {
    it('shows details, specialties first, vouchers and Suki coming soon', async () => {
      const r = await request(app).get(`/api/v1/merchants/${merchantId}`).set('Authorization', auth(aliceId));
      expect(r.status).toBe(200);
      const d = r.body.data;
      expect(d.merchant).toMatchObject({
        id: merchantId,
        name: 'Aling Nena Cafe',
        banner_url: 'https://cdn.example/cover.jpg',
        contact_phone: '09170000000',
        contact_email: null,
        gps_lat: 16.043,
      });
      expect(d.specialties.map((p: any) => p.id)).toEqual(['v310-p2', 'v310-p1']);
      expect(d.products.map((p: any) => p.id)).toEqual(['v310-p3', 'v310-p4']);
      expect(d.vouchers.map((v: any) => v.id)).toEqual(['v310-voucher']);
      expect(d.suki).toEqual({ enabled: false, program: null, my_card: null });
      expect(d.viewer.is_member).toBe(false);
      const anon = await request(app).get(`/api/v1/merchants/${merchantId}`);
      expect(anon.status).toBe(200);
    });

    it('shows the viewer their Suki card when Suki is on', async () => {
      await fixture.pool.query(
        `INSERT INTO suki_programs(id, merchant_id, title, reward_kind, reward_text, visits_required, status)
         VALUES ('v310-suki', $1, 'Kape Suki', 'free_item', 'Free iced coffee', 5, 'active'),
                ('v310-suki-2', $2, 'Pan Suki', 'free_item', 'Free pandesal', 5, 'active')`,
        [merchantId, otherMerchantId],
      );
      await fixture.pool.query(
        `INSERT INTO suki_cards(id, program_id, user_id, cycle, cycle_required, visits, total_visits)
         VALUES ('v310-card', 'v310-suki', $1, 1, 5, 2, 2)`,
        [aliceId],
      );
      await setSettings({ suki_enabled: true });
      try {
        const r = await request(app).get(`/api/v1/merchants/${merchantId}`).set('Authorization', auth(aliceId));
        expect(r.body.data.suki).toMatchObject({
          enabled: true,
          program: { id: 'v310-suki', reward_tag: 'FREE', visits_required: 5 },
          my_card: { visits: 2, required: 5 },
        });
        // Nearby Suki shops never include the viewer's own shop.
        const svc = new SukiService(fixture.pool);
        const forOwner = await svc.listPrograms({ userId: ownerId });
        expect(forOwner.programs.map((p) => p.id)).toEqual(['v310-suki-2']);
        const forAlice = await svc.listPrograms({ userId: aliceId });
        expect(forAlice.programs.map((p) => p.id).sort()).toEqual(['v310-suki', 'v310-suki-2']);
      } finally {
        await setSettings({ suki_enabled: false });
      }
    });

    it('hides a draft page from travelers but previews it for its members; unknown is 404', async () => {
      const outsider = await request(app)
        .get(`/api/v1/merchants/${draftMerchantId}`)
        .set('Authorization', auth(aliceId));
      expect([outsider.status, outsider.body.error?.code]).toEqual([404, 'MERCHANT_NOT_FOUND']);
      const member = await request(app)
        .get(`/api/v1/merchants/${draftMerchantId}`)
        .set('Authorization', auth(otherOwnerId));
      expect(member.status).toBe(200);
      expect(member.body.data.merchant.is_published).toBe(false);
      expect(member.body.data.viewer.is_member).toBe(true);
      const unknown = await request(app).get('/api/v1/merchants/nope');
      expect(unknown.status).toBe(404);
    });
  });

  it('accepts an uploaded cover photo path on the merchant profile', async () => {
    const created = new Date().toISOString();
    db.merchants.push({
      id: merchantId,
      name: 'Aling Nena Cafe',
      location: 'Dagupan',
      description: 'Fixture shop',
      status: 'active',
      is_published: true,
      created_at: created,
    } as any);
    db.merchant_memberships.push({
      id: 'v310-mm-1',
      merchant_id: merchantId,
      user_id: ownerId,
      role: 'owner',
      status: 'active',
      created_at: created,
      updated_at: created,
    } as any);
    const path = '/api/v1/uploads/spot-photos/spot_photo_0b6f.jpg';
    const ok = await request(app)
      .patch('/api/v1/merchant/profile')
      .set('Authorization', auth(ownerId))
      .send({ banner_url: path });
    expect(ok.status).toBe(200);
    expect(ok.body.data.banner_url).toBe(path);
    const bad = await request(app)
      .patch('/api/v1/merchant/profile')
      .set('Authorization', auth(ownerId))
      .send({ banner_url: 'javascript:alert(1)' });
    expect(bad.status).toBe(400);
    const traversal = await request(app)
      .patch('/api/v1/merchant/profile')
      .set('Authorization', auth(ownerId))
      .send({ banner_url: '/api/v1/uploads/spot-photos/../secret' });
    expect(traversal.status).toBe(400);
  });

  it('leaves the creator own shop out of the sponsor directory', async () => {
    await fixture.pool.query(
      `INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, marker_code, marker_image_url, author_id)
       VALUES ('v310-quest', 'Dagupan walk', 'Test quest', 'eco', 'Dagupan', 16.043, 120.333, 'v310-marker', '', $1)`,
      [ownerId],
    );
    const svc = new SponsorshipService(fixture.pool);
    const list = await svc.directory('v310-quest', ownerId, {});
    const ids = list.items.map((m: any) => m.id);
    expect(ids).toContain(otherMerchantId);
    expect(ids).not.toContain(merchantId);
  });
});
