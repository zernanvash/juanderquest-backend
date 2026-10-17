import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { movePoints } from '../src/funding/ledger.js';
import { lockGovernanceSnapshot, commitGovernanceTransaction } from '../src/governance/transaction.js';
import { governanceStore } from '../src/routes/proposals.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('funded-quest merchant points (isolated real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const suffix = randomUUID();
  const ownerId = `points-owner-${suffix}`;
  const staffId = `points-staff-${suffix}`;
  const adminId = `points-admin-${suffix}`;
  const merchantId = `points-merchant-${suffix}`;
  const bearer = (id: string, role: 'user' | 'admin') => `Bearer ${jwt.sign({ id, seed_id: id, role }, env.JWT_SECRET)}`;
  const originalFundingFlag = env.QUEST_FUNDING_ENABLED;

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    env.QUEST_FUNDING_ENABLED = true;
    await fixture.pool.query(
      `INSERT INTO users(id, seed_id, display_name, email, role) VALUES
       ($1,$2,'Points Owner',$3,'user'), ($4,$5,'Points Staff',$6,'user'), ($7,$8,'Points Admin',$9,'admin')`,
      [ownerId, ownerId, `${ownerId}@test.invalid`, staffId, staffId, `${staffId}@test.invalid`, adminId, adminId, `${adminId}@test.invalid`]
    );
    await fixture.pool.query(
      `INSERT INTO merchants(id,name,location,description,status,is_published,is_test)
       VALUES($1,'Disposable Points Merchant','Test location','Fixture merchant', 'active', true, true)`,
      [merchantId]
    );
    await fixture.pool.query('UPDATE users SET is_test=TRUE WHERE id IN ($1,$2)', [ownerId, staffId]);
    await fixture.pool.query(
      `INSERT INTO merchant_memberships(id,merchant_id,user_id,role,status)
       VALUES($1,$2,$3,'owner','active'), ($4,$2,$5,'staff','active')`,
      [randomUUID(), merchantId, ownerId, randomUUID(), staffId]
    );
    await fixture.pool.query(
      `INSERT INTO vouchers(id,merchant_id,title,description,cost_points,is_active)
       VALUES($1,$2,'Demo snack','A voucher for the sponsorship picker',20,true)`,
      [`points-voucher-${suffix}`, merchantId]
    );
  });

  afterAll(async () => {
    env.QUEST_FUNDING_ENABLED = originalFundingFlag;
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  });

  it('requires owner membership and settles idempotent simulated purchases in balanced ledger groups', async () => {
    const key = randomUUID();
    const staff = await request(app).post('/api/v1/merchant/points/purchase')
      .set('Authorization', bearer(staffId, 'user')).send({ package: 500, idempotency_key: randomUUID() });
    expect(staff.status).toBe(403);
    const staffRead = await request(app).get('/api/v1/merchant/points').set('Authorization', bearer(staffId,'user'));
    expect(staffRead.status).toBe(200);
    const staffVouchers = await request(app).get('/api/v1/merchant/vouchers').set('Authorization', bearer(staffId,'user'));
    expect(staffVouchers.status).toBe(200);
    expect(staffVouchers.body.data.items).toEqual([expect.objectContaining({ title: 'Demo snack', cost_points: 20 })]);

    const first = await request(app).post('/api/v1/merchant/points/purchase')
      .set('Authorization', bearer(ownerId, 'user')).send({ package: 500, idempotency_key: key });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ credited_points: 500, balance_points: 500, simulated: true, replayed: false });

    const replay = await request(app).post('/api/v1/merchant/points/purchase')
      .set('Authorization', bearer(ownerId, 'user')).send({ package: 500, idempotency_key: key });
    expect(replay.status).toBe(200);
    expect(replay.body.data).toMatchObject({ credited_points: 500, balance_points: 500, replayed: true });

    const mismatch = await request(app).post('/api/v1/merchant/points/purchase')
      .set('Authorization', bearer(ownerId, 'user')).send({ package: 1000, idempotency_key: key });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    const group = await fixture.pool.query(
      `SELECT COUNT(*)::int AS postings, SUM(amount_mjdq)::bigint AS total
       FROM governance_ledger WHERE reference_type='merchant_point_credit' AND reference_id=$1 GROUP BY transaction_group_id`,
      [first.body.data.receipt_id]
    );
    expect(group.rows).toHaveLength(1);
    expect(group.rows[0]).toMatchObject({ postings: 2, total: '0' });
    const linked = await fixture.pool.query(
      `SELECT 1 FROM merchant_point_credits c JOIN governance_ledger l ON l.transaction_group_id=c.ledger_group_id
       WHERE c.id=$1 AND l.reference_id=c.id LIMIT 1`,[first.body.data.receipt_id]);
    expect(linked.rows).toHaveLength(1);
    const account = await request(app).get('/api/v1/merchant/points').set('Authorization', bearer(ownerId, 'user'));
    expect(account.status).toBe(200);
    expect(account.body.data.balance_points).toBe(500);
  });

  it('enforces purchase caps and records only the allowed simulated issuance', async () => {
    await fixture.pool.query(
      `UPDATE system_settings_document SET values = values || '{"merchant_purchase_daily_cap":1000,"merchant_purchase_monthly_cap":5000}'::jsonb WHERE id=1`
    );
    const first = await request(app).post('/api/v1/merchant/points/purchase')
      .set('Authorization', bearer(ownerId, 'user')).send({ package: 500, idempotency_key: randomUUID() });
    expect(first.status).toBe(200);
    const over = await request(app).post('/api/v1/merchant/points/purchase')
      .set('Authorization', bearer(ownerId, 'user')).send({ package: 500, idempotency_key: randomUUID() });
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('PURCHASE_LIMIT_REACHED');

    await fixture.pool.query(
      `UPDATE system_settings_document SET values = values || '{"merchant_purchase_daily_cap":5000,"merchant_purchase_monthly_cap":1500}'::jsonb WHERE id=1`
    );
    const monthlyLast = await request(app).post('/api/v1/merchant/points/purchase')
      .set('Authorization', bearer(ownerId, 'user')).send({ package: 500, idempotency_key: randomUUID() });
    expect(monthlyLast.status).toBe(200);
    const monthlyOver = await request(app).post('/api/v1/merchant/points/purchase')
      .set('Authorization', bearer(ownerId, 'user')).send({ package: 500, idempotency_key: randomUUID() });
    expect(monthlyOver.status).toBe(429);
    expect(monthlyOver.body.error.code).toBe('PURCHASE_LIMIT_REACHED');
    const count = await fixture.pool.query(
      `SELECT COALESCE(SUM(points),0)::int AS total FROM merchant_point_credits
       WHERE merchant_id=$1 AND source='simulated_purchase'`, [merchantId]
    );
    expect(count.rows[0].total).toBe(1500);
  });

  it('allows reasoned admin grants and bounded idempotent reversals only', async () => {
    const grant = await request(app).post(`/api/v1/admin/merchants/${merchantId}/points`)
      .set('Authorization', bearer(adminId, 'admin'))
      .send({ points: 100, reason: 'Presentation merchant support', idempotency_key: randomUUID() });
    expect(grant.status).toBe(200);
    expect(grant.body.data.balance_points).toBe(1600);

    const original = await fixture.pool.query(
      `SELECT id FROM merchant_point_credits WHERE merchant_id=$1 AND source='admin_grant' ORDER BY created_at DESC LIMIT 1`,
      [merchantId]
    );
    const correction = await request(app).post(`/api/v1/admin/merchants/${merchantId}/points`)
      .set('Authorization', bearer(adminId, 'admin'))
      .send({ points: -30, reason: 'Reverse mistaken grant', reverses_credit_id: original.rows[0].id, idempotency_key: randomUUID() });
    expect(correction.status).toBe(200);
    expect(correction.body.data.balance_points).toBe(1570);

    const auditRows = await request(app).get(`/api/v1/admin/merchant-point-credits?merchant_id=${merchantId}&limit=200`)
      .set('Authorization', bearer(adminId, 'admin'));
    expect(auditRows.status).toBe(200);
    const originalCredit = auditRows.body.data.items.find((row: { id: string }) => row.id === original.rows[0].id);
    expect(Number(originalCredit.reversible_points)).toBe(70);

    const excessive = await request(app).post(`/api/v1/admin/merchants/${merchantId}/points`)
      .set('Authorization', bearer(adminId, 'admin'))
      .send({ points: -80, reason: 'Reverse remaining grant', reverses_credit_id: original.rows[0].id, idempotency_key: randomUUID() });
    expect(excessive.status).toBe(409);
    expect(excessive.body.error.code).toBe('INVALID_REVERSAL');
  });

  it('moves author points through the shared ledger and preserves fractional mJDQ snapshot remainder', async () => {
    await fixture.pool.query('UPDATE users SET demo_points = 100 WHERE id = $1', [ownerId]);
    const client = await fixture.pool.connect();
    let group;
    try {
      await client.query('BEGIN');
      await lockGovernanceSnapshot(client);
      await client.query(
        `UPDATE governance_snapshot SET data = jsonb_set(
           data, '{balances}', COALESCE(data->'balances', '{}'::jsonb) || jsonb_build_object($1::text, 100250), true
         ), updated_at = NOW() WHERE id = 1`,
        [ownerId],
      );
      group = await movePoints(client, {
        from: { id: ownerId, kind: 'traveler', userId: ownerId },
        to: { id: 'treasury:test', kind: 'treasury' },
        points: 40,
        type: 'quest_fund_lock',
        referenceType: 'quest_funding_plan',
        referenceId: `plan-${suffix}`,
        actorId: ownerId,
        idempotencyKey: randomUUID(),
      });
      await commitGovernanceTransaction(client);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    governanceStore.publishCommittedTransaction(group!);
    expect(group!.entries.reduce((sum, entry) => sum + entry.amount_mjdq, 0)).toBe(0);
    expect(group!.userBalanceUpdate).toMatchObject({ demoPoints: 60, balanceMjdq: 60_250 });
    expect(governanceStore.balanceOf(ownerId)).toBe(60_250);
    const user = await fixture.pool.query('SELECT demo_points FROM users WHERE id = $1', [ownerId]);
    const snapshot = await fixture.pool.query('SELECT data FROM governance_snapshot WHERE id = 1');
    expect(Number(user.rows[0].demo_points)).toBe(60);
    expect(snapshot.rows[0].data.balances[ownerId]).toBe(60_250);
    const transfer = await fixture.pool.query(
      `SELECT SUM(amount_mjdq)::bigint AS total, COUNT(*)::int AS postings FROM governance_ledger
       WHERE reference_type='quest_funding_plan' AND reference_id=$1`, [`plan-${suffix}`]
    );
    expect(transfer.rows[0]).toMatchObject({ total: '0', postings: 2 });
  });
});
