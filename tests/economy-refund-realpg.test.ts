import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app';
import { env } from '../src/config/env';
import { db } from '../src/db/index';
import { setPool } from '../src/db/pool';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness';
import { EconomyService } from '../src/economy/service';
import { reconcileEconomy } from '../src/economy/reconcile';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('admin-only full inverse simulated cosmetic correction', () => {
  let fixture: TestDbInstance;
  const token = (id: string, role: 'admin' | 'user') =>
    `Bearer ${jwt.sign({ id, seed_id: id, role }, env.JWT_SECRET)}`;

  beforeEach(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    const client = await fixture.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO users(id,seed_id,display_name,email,role) VALUES
        ('refund-admin','refund-admin','Admin','refund-admin@test.invalid','admin'),
        ('refund-traveler','refund-traveler','Traveler','refund-traveler@test.invalid','user')
      `);
      await client.query(`
        INSERT INTO economic_accounts(id,asset_code,kind,user_id)
        VALUES ('sim:traveler:refund-traveler','EXPLORER_COIN_SIM','traveler','refund-traveler')
      `);
      await client.query(`
        INSERT INTO economic_cosmetics(id,asset_code,cost_minor,active)
        VALUES ('refund-frame','EXPLORER_COIN_SIM',40,true)
      `);
      await client.query(`
        INSERT INTO economic_transactions
        (id,asset_code,business_event,operation,actor_id,policy_version) VALUES
        ('fixture-reward','EXPLORER_COIN_SIM','fixture-reward','reward','refund-admin','fixture-v1'),
        ('fixture-spend','EXPLORER_COIN_SIM','cosmetic:refund-traveler:refund-frame',
         'spend','refund-traveler','cosmetic-pilot-v1')
      `);
      await client.query(`
        INSERT INTO economic_transfers
        (transaction_id,sequence,asset_code,from_account_id,to_account_id,amount_minor) VALUES
        ('fixture-reward',1,'EXPLORER_COIN_SIM','sim:issuance','sim:traveler:refund-traveler',100),
        ('fixture-spend',1,'EXPLORER_COIN_SIM','sim:traveler:refund-traveler','sim:retired',40)
      `);
      await client.query(`UPDATE economic_accounts SET balance_minor = -100 WHERE id = 'sim:issuance'`);
      await client.query(`UPDATE economic_accounts SET balance_minor = 60 WHERE id = 'sim:traveler:refund-traveler'`);
      await client.query(`UPDATE economic_accounts SET balance_minor = 40 WHERE id = 'sim:retired'`);
      await client.query(`
        INSERT INTO economic_entitlements(id,user_id,cosmetic_id,transaction_id)
        VALUES ('fixture-entitlement','refund-traveler','refund-frame','fixture-spend')
      `);
      await client.query('COMMIT');
      await db.hydrateFromPg(fixture.pool);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }, 120_000);

  afterEach(async () => {
    setPool(null);
    await fixture?.close();
  }, 120_000);

  it('refunds once, preserves linked history and replays the same durable receipt', async () => {
    const body = { original_transaction_id: 'fixture-spend',
      reason: 'The optional profile frame was not delivered as described.' };
    expect((await request(app).post('/api/v1/admin/economy/refunds').send(body)).status).toBe(401);
    expect((await request(app).post('/api/v1/admin/economy/refunds')
      .set('Authorization', token('refund-traveler', 'user'))
      .set('x-idempotency-key', 'refund-key').send(body)).status).toBe(403);
    const approved = await request(app).post('/api/v1/admin/economy/refunds')
      .set('Authorization', token('refund-admin', 'admin'))
      .set('x-idempotency-key', 'refund-key').send(body);
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({ amountMinor: '40', businessEvent: 'refund:fixture-spend' });
    const replay = await request(app).post('/api/v1/admin/economy/refunds')
      .set('Authorization', token('refund-admin', 'admin'))
      .set('x-idempotency-key', 'refund-key').send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.data.transactionId).toBe(approved.body.data.transactionId);
    const conflict = await request(app).post('/api/v1/admin/economy/refunds')
      .set('Authorization', token('refund-admin', 'admin'))
      .set('x-idempotency-key', 'refund-key')
      .send({ ...body, reason: 'A different correction rationale must not reuse the same key.' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const duplicate = await request(app).post('/api/v1/admin/economy/refunds')
      .set('Authorization', token('refund-admin', 'admin'))
      .set('x-idempotency-key', 'different-key').send(body);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('ALREADY_REFUNDED_OR_INELIGIBLE');
    const balances = await fixture.pool.query(
      `SELECT id,balance_minor FROM economic_accounts
       WHERE id IN ('sim:retired','sim:traveler:refund-traveler') ORDER BY id`
    );
    expect(balances.rows.map((row) => [row.id, Number(row.balance_minor)]))
      .toEqual([['sim:retired', 0], ['sim:traveler:refund-traveler', 100]]);
    expect((await fixture.pool.query(
      `SELECT id FROM economic_corrections WHERE original_transaction_id = 'fixture-spend'`
    )).rowCount).toBe(1);
    expect((await fixture.pool.query(
      `SELECT refunded_at,refund_transaction_id FROM economic_entitlements WHERE id = 'fixture-entitlement'`
    )).rows[0].refund_transaction_id).toBe(approved.body.data.transactionId);
    expect((await fixture.pool.query(
      `SELECT id FROM economic_outbox WHERE transaction_id = $1 AND event_type = 'refund'`,
      [approved.body.data.transactionId]
    )).rowCount).toBe(1);
    expect((await reconcileEconomy(fixture.pool)).pilotAccountDrift).toEqual([]);
  }, 120_000);

  it('rolls back balances and transfer when correction audit insertion fails', async () => {
    await fixture.pool.query(`CREATE FUNCTION reject_refund_fixture() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INJECTED_REFUND_AUDIT_FAILURE'; END $$`);
    await fixture.pool.query(`CREATE TRIGGER reject_refund_fixture_trigger BEFORE INSERT ON economic_corrections
      FOR EACH ROW EXECUTE FUNCTION reject_refund_fixture()`);
    const economy = new EconomyService(fixture.pool);
    await expect(economy.refundSimulatedCosmetic(
      'fixture-spend', 'refund-admin', 'Valid operational correction reason.', 'fault-key'
    )).rejects.toThrow(/INJECTED_REFUND_AUDIT_FAILURE/);
    expect((await fixture.pool.query(
      `SELECT balance_minor FROM economic_accounts WHERE id = 'sim:traveler:refund-traveler'`
    )).rows[0].balance_minor).toBe('60');
    expect((await fixture.pool.query(
      `SELECT id FROM economic_transactions WHERE business_event = 'refund:fixture-spend'`
    )).rowCount).toBe(0);
    await fixture.pool.query('DROP TRIGGER reject_refund_fixture_trigger ON economic_corrections');
    await fixture.pool.query('DROP FUNCTION reject_refund_fixture()');
    const receipt = await economy.refundSimulatedCosmetic(
      'fixture-spend', 'refund-admin', 'Valid operational correction reason.', 'fault-key'
    );
    expect(receipt.amountMinor).toBe('40');
  }, 120_000);

  it('resolves a lost commit acknowledgement from the durable idempotency command', async () => {
    const economy = new EconomyService(fixture.pool);
    const originalConnect = fixture.pool.connect.bind(fixture.pool);
    let intercepted = false;
    const restoreBorrowedQueries: Array<() => void> = [];
    (fixture.pool as any).connect = async () => {
      const client = await originalConnect();
      const originalQuery = client.query.bind(client);
      restoreBorrowedQueries.push(() => { (client as any).query = originalQuery; });
      (client as any).query = async (...args: unknown[]) => {
        const result = await (originalQuery as any)(...args);
        if (!intercepted && args[0] === 'COMMIT') {
          intercepted = true;
          throw new Error('SIMULATED_LOST_COMMIT_ACK');
        }
        return result;
      };
      return client;
    };
    try {
      await expect(economy.refundSimulatedCosmetic(
        'fixture-spend', 'refund-admin', 'Lost acknowledgment is safe to replay.', 'lost-ack-key'
      )).rejects.toThrow('SIMULATED_LOST_COMMIT_ACK');
    } finally {
      (fixture.pool as any).connect = originalConnect;
      for (const restore of restoreBorrowedQueries) restore();
    }
    expect(intercepted).toBe(true);
    const retry = await economy.refundSimulatedCosmetic(
      'fixture-spend', 'refund-admin', 'Lost acknowledgment is safe to replay.', 'lost-ack-key'
    );
    expect(retry.amountMinor).toBe('40');
    expect((await fixture.pool.query(
      `SELECT count(*)::int AS n FROM economic_transactions WHERE business_event = 'refund:fixture-spend'`
    )).rows[0].n).toBe(1);
    expect((await reconcileEconomy(fixture.pool)).pilotAccountDrift).toEqual([]);
  }, 120_000);

  it('allows exactly one inverse transfer under two competing administrators', async () => {
    const economy = new EconomyService(fixture.pool);
    const competing = await Promise.allSettled([
      economy.refundSimulatedCosmetic('fixture-spend', 'refund-admin',
        'Parallel operational correction for the optional frame.', 'parallel-a'),
      economy.refundSimulatedCosmetic('fixture-spend', 'refund-admin',
        'Parallel operational correction for the optional frame.', 'parallel-b'),
    ]);
    expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(competing.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await fixture.pool.query(
      `SELECT count(*)::int AS n FROM economic_corrections WHERE original_transaction_id = 'fixture-spend'`
    )).rows[0].n).toBe(1);
    expect((await reconcileEconomy(fixture.pool)).pilotAccountDrift).toEqual([]);
  }, 120_000);
});
