import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { ANCHOR_TAG, grantFingerprint, GRANT_DAILY_CAP, PointGrantService } from '../src/admin/pointGrants.js';
import { runBadgeMintTick, type BadgeChain, type BadgeReceipt } from '../src/chain/badgeMinter.js';

// Owner 2026-11-18: "build the give mjdq feature in dashboard (for beta testing, simulated points for now)
// but still reflects as transactions so its on the blockchain".

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

class FakeChain implements BadgeChain {
  constructor(readonly issuer: string) {}
  head = 1000;
  nonce = 0;
  mined = 0;
  receipts = new Map<string, BadgeReceipt>();
  anchors: { data: string; nonce: number }[] = [];
  async latestBlock() {
    return this.head;
  }
  async balanceWei() {
    return 10n ** 19n;
  }
  async pendingNonce() {
    return this.nonce;
  }
  async minedNonce() {
    return this.mined;
  }
  async isEntitlementUsed() {
    return false;
  }
  async receipt(hash: string) {
    return this.receipts.get(hash) ?? null;
  }
  async sendIssue(): Promise<string> {
    throw new Error('no badges in this test');
  }
  async sendAnchor(args: { data: string; nonce: number }) {
    this.anchors.push(args);
    const hash = `0x${'a'.repeat(60)}${this.anchors.length.toString(16).padStart(4, '0')}`;
    this.nonce += 1;
    this.mined += 1;
    this.receipts.set(hash, { success: true, blockNumber: this.head + 1, blockHash: `0x${'b'.repeat(64)}` });
    return hash;
  }
}

realPg('admin Give mJDQ (isolated real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const suffix = randomUUID().slice(0, 8);
  const adminId = `grant-admin-${suffix}`;
  const userId = `grant-user-${suffix}`;
  const areaAdminId = `grant-area-${suffix}`;
  const issuer = `0x${'c'.repeat(40)}`;
  const bearer = (id: string, role: string) =>
    `Bearer ${jwt.sign({ id, seed_id: id, role, typ: 'session' }, env.JWT_SECRET)}`;
  const give = (body: Record<string, unknown>, who = adminId, role = 'admin') =>
    request(app).post('/api/v1/admin/point-grants').set('Authorization', bearer(who, role)).send(body);

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    await fixture.pool.query(
      `INSERT INTO users(id, seed_id, display_name, email, handle, role, demo_points) VALUES
       ($1,$2,'Grant Admin',$3,NULL,'admin',0),
       ($4,$5,'Grant Traveler',$6,$7,'user',100),
       ($8,$9,'Area Admin',$10,NULL,'area_admin',0)`,
      [
        adminId,
        adminId,
        `${adminId}@test.invalid`,
        userId,
        userId,
        `${userId}@test.invalid`,
        `traveler${suffix}`,
        areaAdminId,
        areaAdminId,
        `${areaAdminId}@test.invalid`,
      ],
    );
    await fixture.pool.query(`UPDATE chain_wallets SET active = FALSE WHERE chain_id = $1 AND role = 'badge_issuer'`, [
      env.CHAIN_ID,
    ]);
    await fixture.pool.query(
      `INSERT INTO chain_wallets (id, chain_id, address, label, role, custody)
       VALUES ($1, $2, $3, 'Test issuer', 'badge_issuer', 'server')`,
      [randomUUID(), env.CHAIN_ID, issuer],
    );
  });

  afterAll(async () => {
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  });

  it('only platform admins can look up or give', async () => {
    const asUser = await give({ user_id: userId, points: 5, reason: 'nope', idempotency_key: randomUUID() }, userId, 'user');
    expect(asUser.status).toBe(403);
    const asArea = await give(
      { user_id: userId, points: 5, reason: 'nope', idempotency_key: randomUUID() },
      areaAdminId,
      'area_admin',
    );
    expect(asArea.status).toBe(403);
    const lookup = await request(app)
      .get(`/api/v1/admin/point-grants/lookup?q=${userId}@test.invalid`)
      .set('Authorization', bearer(adminId, 'admin'));
    expect(lookup.status).toBe(200);
    expect(lookup.body.data.users).toEqual([expect.objectContaining({ id: userId, balance: 100 })]);
    const byHandle = await request(app)
      .get(`/api/v1/admin/point-grants/lookup?q=@traveler${suffix}`)
      .set('Authorization', bearer(adminId, 'admin'));
    expect(byHandle.body.data.users[0].id).toBe(userId);
  });

  it('credits the traveler through a balanced ledger group, audits it and queues an Amoy anchor', async () => {
    const key = randomUUID();
    const res = await give({ user_id: userId, points: 250, reason: 'Beta tester thank-you', idempotency_key: key });
    expect(res.status).toBe(201);
    const grant = res.body.data.grant;
    expect(grant).toEqual(
      expect.objectContaining({ points: 250, balance_after: 350, reason: 'Beta tester thank-you' }),
    );
    expect(grant.anchor.status).toBe('queued');
    expect(grant.anchor.fingerprint).toMatch(/^0x[0-9a-f]{64}$/);

    const user = await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1', [userId]);
    expect(Number(user.rows[0].demo_points)).toBe(350);

    const row = (await fixture.pool.query('SELECT * FROM admin_point_grants WHERE id=$1', [grant.id])).rows[0];
    const ledger = await fixture.pool.query(
      'SELECT account, amount_mjdq FROM governance_ledger WHERE transaction_group_id=$1',
      [row.ledger_group_id],
    );
    expect(ledger.rows.length).toBeGreaterThanOrEqual(2);
    expect(ledger.rows.reduce((sum: number, r: any) => sum + Number(r.amount_mjdq), 0)).toBe(0);
    expect(
      grantFingerprint({
        id: row.id,
        userId,
        points: 250,
        ledgerGroupId: row.ledger_group_id,
        createdAt: new Date(row.created_at).toISOString(),
      }),
    ).toBe(row.anchor_hash);

    const audit = await fixture.pool.query(
      `SELECT after FROM admin_audit_log WHERE action='points.grant' AND subject_id=$1`,
      [userId],
    );
    expect(audit.rows[0].after).toEqual(expect.objectContaining({ points: 250, grant_id: grant.id }));

    // Same key again: the same grant, no second credit.
    const replay = await give({ user_id: userId, points: 250, reason: 'Beta tester thank-you', idempotency_key: key });
    expect(replay.status).toBe(200);
    expect(replay.body.data.grant.id).toBe(grant.id);
    const after = await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1', [userId]);
    expect(Number(after.rows[0].demo_points)).toBe(350);
  });

  it('sends the anchor as a 0-value self transaction and links it on the explorer', async () => {
    const chain = new FakeChain(issuer);
    const options = { chainId: env.CHAIN_ID, confirmations: 5, maxAttempts: 3 };
    const tick = await runBadgeMintTick(fixture.pool, chain, options);
    expect(tick.sent).toBeTruthy();
    expect(chain.anchors).toHaveLength(1);
    const row = (
      await fixture.pool.query(`SELECT anchor_hash FROM admin_point_grants WHERE user_id=$1`, [userId])
    ).rows[0];
    expect(chain.anchors[0].data).toBe(ANCHOR_TAG + row.anchor_hash.slice(2));

    await runBadgeMintTick(fixture.pool, chain, options);
    chain.head += 10;
    await runBadgeMintTick(fixture.pool, chain, options);
    const list = await request(app).get('/api/v1/admin/point-grants').set('Authorization', bearer(adminId, 'admin'));
    expect(list.status).toBe(200);
    const anchor = list.body.data.items[0].anchor;
    expect(anchor.status).toBe('finalized');
    expect(anchor.explorer_url).toMatch(/\/tx\/0x[0-9a-f]{64}$/);
  });

  it('rejects bad amounts and enforces the daily cap per admin', async () => {
    expect((await give({ user_id: userId, points: 0, reason: 'zero', idempotency_key: randomUUID() })).status).toBe(400);
    expect((await give({ user_id: userId, points: 1001, reason: 'big', idempotency_key: randomUUID() })).status).toBe(
      400,
    );
    expect((await give({ user_id: 'missing', points: 5, reason: 'ghost', idempotency_key: randomUUID() })).status).toBe(
      404,
    );
    // 250 already given today; fill up to the cap (service directly: the route is rate limited),
    // then one more is refused.
    const service = new PointGrantService(fixture.pool);
    let left = GRANT_DAILY_CAP - 250;
    while (left > 0) {
      const chunk = Math.min(1000, left);
      await service.grant({ adminId, userId, points: chunk, reason: 'fill', idempotencyKey: randomUUID() });
      left -= chunk;
    }
    await expect(
      service.grant({ adminId, userId, points: 1, reason: 'one more', idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'DAILY_CAP_REACHED', status: 429 });
  });
});
