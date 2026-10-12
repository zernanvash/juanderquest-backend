import { createTestDb, type TestDbInstance } from '../src/db/testHarness';
import { EconomicOutboxService } from '../src/economy/outbox';
import { drainEconomicOutbox } from '../src/jobs/economy-outbox';
import { setPool } from '../src/db/pool';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('durable economic outbox leases and idempotent local consumer receipts', () => {
  let fixture: TestDbInstance;
  let outbox: EconomicOutboxService;

  beforeEach(async () => {
    fixture = await createTestDb({ poolMax: 12 });
    setPool(fixture.pool);
    outbox = new EconomicOutboxService(fixture.pool);
  }, 120_000);
  afterEach(async () => { setPool(null); await fixture?.close(); }, 120_000);

  async function seed(count: number) {
    for (let i = 1; i <= count; i++) {
      await fixture.pool.query(
        `INSERT INTO economic_transactions
         (id,asset_code,business_event,operation,actor_id,policy_version)
         VALUES ($1,'EXPLORER_COIN_SIM',$2,'transfer','test','outbox-test-v1')`,
        [`outbox-tx-${i}`, `outbox-event-${i}`]
      );
      await fixture.pool.query(
        `INSERT INTO economic_outbox(id,transaction_id,event_type,payload)
         VALUES ($1,$2,'test',$3::jsonb)`,
        [`outbox-${i}`, `outbox-tx-${i}`, JSON.stringify({ sequence: i })]
      );
    }
  }

  it('claims each event once across five concurrent workers', async () => {
    await seed(20);
    const batches = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      outbox.claimBatch(`worker-${i}`, 4)));
    const claims = batches.flat();
    expect(claims).toHaveLength(20);
    expect(new Set(claims.map((claim) => claim.id)).size).toBe(20);
    expect(new Set(claims.map((claim) => claim.claimToken)).size).toBe(20);
    expect(claims.every((claim) => claim.attempts === 1)).toBe(true);
  });

  it('fences an expired owner and records only one local consumer effect', async () => {
    await seed(1);
    const first = (await outbox.claimBatch('same-name', 1))[0];
    await fixture.pool.query(
      `UPDATE economic_outbox SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [first.id]
    );
    const reclaimed = (await outbox.claimBatch('same-name', 1))[0];
    expect(reclaimed.claimToken).not.toBe(first.claimToken);
    expect(await outbox.complete(first, 'internal-audit')).toBe(false);
    expect(await outbox.fail(first, 'stale')).toBe(false);
    expect(await outbox.complete(reclaimed, 'internal-audit')).toBe(true);
    expect(await outbox.complete(reclaimed, 'internal-audit')).toBe(false);
    expect((await fixture.pool.query(
      `SELECT id FROM economic_outbox_receipts WHERE outbox_id = $1 AND consumer_key = 'internal-audit'`, [first.id]
    )).rowCount).toBe(1);
    expect((await fixture.pool.query(
      `SELECT status FROM economic_outbox WHERE id = $1`, [first.id]
    )).rows[0].status).toBe('completed');
  });

  it('retries a failed lease and dead-letters an exhausted crashed worker', async () => {
    await seed(2);
    const claims = await outbox.claimBatch('worker-one', 2);
    const failed = claims.find((claim) => claim.id === 'outbox-1')!;
    const crashed = claims.find((claim) => claim.id === 'outbox-2')!;
    expect(await outbox.fail(failed, 'temporary consumer failure')).toBe(true);
    await fixture.pool.query(`UPDATE economic_outbox SET next_attempt_at = now() - interval '1 second'
      WHERE id = 'outbox-1'`);
    await fixture.pool.query(`UPDATE economic_outbox SET attempts = 5,
      lease_expires_at = now() - interval '1 second' WHERE id = 'outbox-2'`);
    const retry = await outbox.claimBatch('worker-two', 2);
    expect(retry.map((claim) => claim.id)).toEqual(['outbox-1']);
    expect(retry[0].claimToken).not.toBe(failed.claimToken);
    expect(await outbox.complete(retry[0], 'internal-audit')).toBe(true);
    expect(await outbox.complete(crashed, 'internal-audit')).toBe(false);
    expect((await fixture.pool.query(
      `SELECT status,last_error FROM economic_outbox WHERE id = 'outbox-2'`
    )).rows[0]).toMatchObject({ status: 'dead_letter', last_error: 'MAX_ATTEMPTS_EXCEEDED' });
  });

  it('keeps event identity and consumer receipts immutable', async () => {
    await seed(1);
    await expect(fixture.pool.query(
      `UPDATE economic_outbox SET payload = '{"forged":true}'::jsonb WHERE id = 'outbox-1'`
    )).rejects.toThrow(/ECONOMIC_OUTBOX_IDENTITY_IMMUTABLE/);
    const claim = (await outbox.claimBatch('immutable-test', 1))[0];
    await outbox.complete(claim, 'internal-audit');
    await expect(fixture.pool.query(
      `DELETE FROM economic_outbox_receipts WHERE outbox_id = 'outbox-1'`
    )).rejects.toThrow(/ECONOMIC_OUTBOX_RECEIPT_IMMUTABLE/);
  });

  it('drains the local audit consumer and remains a no-op outside dev profile', async () => {
    await seed(2);
    const priorProfile = process.env.JDQ_ENV;
    try {
      process.env.JDQ_ENV = 'production';
      expect(await drainEconomicOutbox()).toBe(0);
      process.env.JDQ_ENV = 'dev';
      expect(await drainEconomicOutbox()).toBe(2);
      expect(await drainEconomicOutbox()).toBe(0);
      const receipts = await fixture.pool.query(
        `SELECT consumer_key FROM economic_outbox_receipts ORDER BY outbox_id`
      );
      expect(receipts.rows.map((row) => row.consumer_key))
        .toEqual(['internal-audit-v1', 'internal-audit-v1']);
    } finally {
      if (priorProfile === undefined) delete process.env.JDQ_ENV;
      else process.env.JDQ_ENV = priorProfile;
    }
  });
});
