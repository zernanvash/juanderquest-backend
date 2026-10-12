import { createTestDb, type TestDbInstance } from '../src/db/testHarness';
import { BaseSepoliaIndexer, type ChainSource, type ObservedBlock } from '../src/chain/indexer';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
const h = (char: string) => `0x${char.repeat(64)}`;
const a = (char: string) => `0x${char.repeat(40)}`;
const entitlement = h('e');
const recipient = a('a');
const distributor = a('b');
const badge = a('c');
const block = (number: number, hash: string, parentHash: string, logs: ObservedBlock['logs'] = []): ObservedBlock =>
  ({ number, hash, parentHash, logs });
const claim = (txHash: string) => ({ txHash, logIndex: 0, address: distributor,
  eventName: 'Claimed' as const, entitlement, recipient, amountWei: '2500000000000000000' });

class FixtureSource implements ChainSource {
  chainId = 84532;
  latest = 12;
  offline = false;
  blocks = new Map<number, ObservedBlock>([
    [10, block(10, h('1'), h('0'))],
    [11, block(11, h('2'), h('1'), [claim(h('a'))])],
    [12, block(12, h('3'), h('2'))],
    [13, block(13, h('4'), h('3'))],
  ]);
  async getChainId() { if (this.offline) throw new Error('RPC_OFFLINE'); return this.chainId; }
  async getLatestBlockNumber() { if (this.offline) throw new Error('RPC_OFFLINE'); return this.latest; }
  async getBlock(number: number) {
    if (this.offline) throw new Error('RPC_OFFLINE');
    const result = this.blocks.get(number);
    if (!result) throw new Error('BLOCK_MISSING');
    return result;
  }
}

realPg('dormant Base Sepolia indexer on disposable PostgreSQL', () => {
  let fixture: TestDbInstance;
  let source: FixtureSource;
  let indexer: BaseSepoliaIndexer;

  beforeEach(async () => {
    fixture = await createTestDb();
    source = new FixtureSource();
    indexer = new BaseSepoliaIndexer(fixture.pool, source,
      { tokenDistributor: distributor, badge, confirmations: 1, startBlock: 10 });
    await fixture.pool.query(`INSERT INTO chain_commands
      (id,chain_id,entitlement_id,operation,recipient_address,status,expected_amount_wei)
      VALUES ('command-1',84532,$1,'test_token_claim',$2,'submitted',2500000000000000000)`, [entitlement, recipient]);
  }, 120_000);
  afterEach(async () => { await fixture?.close(); }, 120_000);

  const snapshot = async () => {
    const [cp, events, commands] = await Promise.all([
      fixture.pool.query('SELECT block_number,block_hash FROM chain_checkpoints'),
      fixture.pool.query('SELECT block_hash,canonical FROM chain_events ORDER BY block_hash'),
      fixture.pool.query("SELECT status FROM chain_commands WHERE id='command-1'"),
    ]);
    return { cp: cp.rows, events: events.rows, command: commands.rows[0].status };
  };

  it('finalizes only after confirmation, deduplicates, and does not cross economic ledgers', async () => {
    source.latest = 11;
    expect(await indexer.sync()).toEqual({ processed: 1, safeHead: 10 });
    expect((await snapshot()).command).toBe('submitted');
    source.latest = 12;
    expect(await indexer.sync()).toEqual({ processed: 1, safeHead: 11 });
    expect((await snapshot()).command).toBe('finalized');
    expect(await indexer.sync()).toEqual({ processed: 0, safeHead: 11 });
    const counts = await fixture.pool.query(`SELECT
      (SELECT count(*) FROM chain_events) AS chain_events,
      (SELECT count(*) FROM economic_transfers) AS coin_transfers,
      (SELECT count(*) FROM governance_ledger) AS legacy_rows`);
    expect(counts.rows[0]).toMatchObject({ chain_events: '1', coin_transfers: '0', legacy_rows: '0' });
  });

  it('keeps checkpoint and projection unchanged on provider outage or wrong chain', async () => {
    await indexer.sync();
    const before = await snapshot();
    source.offline = true;
    await expect(indexer.sync()).rejects.toThrow('RPC_OFFLINE');
    source.offline = false;
    source.chainId = 1;
    await expect(indexer.sync()).rejects.toThrow('WRONG_CHAIN_ID');
    expect(await snapshot()).toEqual(before);
  });

  it('rewinds old canonical logs and replays a replacement branch without duplicate settlement', async () => {
    await indexer.sync();
    expect((await snapshot()).command).toBe('finalized');
    source.blocks.set(11, block(11, h('5'), h('1')));
    source.blocks.set(12, block(12, h('6'), h('5'), [claim(h('f'))]));
    source.blocks.set(13, block(13, h('7'), h('6')));
    source.latest = 12;
    expect(await indexer.sync()).toEqual({ processed: 1, safeHead: 11 });
    expect((await snapshot()).command).toBe('unknown');
    source.latest = 13;
    expect(await indexer.sync()).toEqual({ processed: 1, safeHead: 12 });
    const after = await snapshot();
    expect(after.command).toBe('finalized');
    expect(after.events).toEqual([
      { block_hash: h('2'), canonical: false },
      { block_hash: h('6'), canonical: true },
    ]);
  });

  it('rejects malformed/duplicate logs atomically and does not advance the checkpoint', async () => {
    source.blocks.set(10, block(10, h('1'), h('0'), [claim(h('a')), claim(h('a'))]));
    await expect(indexer.sync()).rejects.toThrow('DUPLICATE_CHAIN_LOG_IN_BLOCK');
    expect((await snapshot()).cp).toEqual([]);
  });

  it('refuses value mismatch and immutable expectation edits instead of finalizing by entitlement alone', async () => {
    source.blocks.set(11, block(11, h('2'), h('1'), [{ ...claim(h('a')), amountWei: '1' }]));
    await indexer.sync();
    expect((await snapshot()).command).toBe('submitted');
    await expect(fixture.pool.query(`UPDATE chain_commands SET expected_amount_wei = 1
      WHERE id = 'command-1'`)).rejects.toThrow('CHAIN_EXPECTATION_IMMUTABLE');
    await expect(fixture.pool.query(`INSERT INTO chain_commands
      (id,chain_id,entitlement_id,operation,recipient_address,status)
      VALUES ('missing-expectation',84532,$1,'test_token_claim',$2,'queued')`,
    [h('b'), recipient])).rejects.toThrow('CHAIN_EXPECTATION_REQUIRED');
  });

  it('ignores untrusted-contract and unanchored historical logs when projecting commands', async () => {
    source.latest = 11;
    await indexer.sync(); // canonical header 10, no claim yet
    await fixture.pool.query(`INSERT INTO chain_events
      (id,chain_id,tx_hash,log_index,block_number,block_hash,event_name,payload,canonical,contract_address)
      VALUES ('untrusted-contract',84532,$1,0,10,$2,'Claimed',$3::jsonb,TRUE,$4),
             ('unanchored-log',84532,$5,0,9,$6,'Claimed',$3::jsonb,TRUE,$7)`,
    [h('8'), h('1'), JSON.stringify({ entitlement, recipient, amountWei: '2500000000000000000' }),
      a('f'), h('9'), h('9'), distributor]);
    source.blocks.set(11, block(11, h('2'), h('1')));
    source.latest = 12;
    await indexer.sync();
    expect((await snapshot()).command).toBe('submitted');
    const events = await fixture.pool.query("SELECT id,canonical FROM chain_events ORDER BY id");
    expect(events.rows).toEqual([
      { id: 'unanchored-log', canonical: true },
      { id: 'untrusted-contract', canonical: true },
    ]); // preserved as audit evidence, not projected
  });

  it('rejects equivocation if a provider changes an old log under the same block hash', async () => {
    await indexer.sync();
    source.blocks.set(11, block(11, h('5'), h('1')));
    await indexer.sync();
    source.blocks.set(11, block(11, h('2'), h('1'), [{ ...claim(h('a')), amountWei: '1' }]));
    await expect(indexer.sync()).rejects.toThrow('CHAIN_LOG_EQUIVOCATION');
    const canonical = await fixture.pool.query('SELECT count(*) AS n FROM chain_events WHERE canonical');
    expect(canonical.rows[0].n).toBe('0');
    expect((await snapshot()).command).toBe('unknown');
  });

  it('keeps replaced/reverted attempts distinct from canonical claim settlement', async () => {
    await fixture.pool.query(`INSERT INTO chain_transaction_attempts
      (id,command_id,chain_id,tx_hash,status) VALUES
      ('attempt-old','command-1',84532,$1,'replaced'),
      ('attempt-new','command-1',84532,$2,'submitted')`, [h('9'), h('a')]);
    await indexer.sync();
    const attempts = await fixture.pool.query(`SELECT id,status FROM chain_transaction_attempts ORDER BY id`);
    expect(attempts.rows).toEqual([
      { id: 'attempt-new', status: 'submitted' },
      { id: 'attempt-old', status: 'replaced' },
    ]);
    expect((await snapshot()).command).toBe('finalized');
  });

  it('recognizes only the allowlisted badge issuance event for badge commands', async () => {
    const badgeEntitlement = h('d');
    await fixture.pool.query(`INSERT INTO chain_commands
      (id,chain_id,entitlement_id,operation,recipient_address,status,expected_token_id)
      VALUES ('badge-command',84532,$1,'badge_claim',$2,'submitted',77)`, [badgeEntitlement, recipient]);
    source.blocks.set(12, block(12, h('3'), h('2'), [{
      txHash: h('8'), logIndex: 1, address: badge,
      eventName: 'BadgeIssued', entitlement: badgeEntitlement, recipient, tokenId: '77',
    }]));
    source.latest = 13;
    await indexer.sync();
    const badgeCommand = await fixture.pool.query("SELECT status FROM chain_commands WHERE id='badge-command'");
    expect(badgeCommand.rows[0].status).toBe('finalized');
    expect((await snapshot()).command).toBe('finalized');
  });

  it('allows one worker to resume a durable checkpoint after restart', async () => {
    source.latest = 11;
    await indexer.sync();
    const restarted = new BaseSepoliaIndexer(fixture.pool, source,
      { tokenDistributor: distributor, badge, confirmations: 1, startBlock: 10 });
    source.latest = 13;
    expect(await restarted.sync()).toEqual({ processed: 2, safeHead: 12 });
    expect((await snapshot()).cp[0]).toMatchObject({ block_number: '12', block_hash: h('3') });
  });

  it('deduplicates competing workers through the real PostgreSQL checkpoint lock', async () => {
    const second = new BaseSepoliaIndexer(fixture.pool, source,
      { tokenDistributor: distributor, badge, confirmations: 1, startBlock: 10 });
    const outcomes = await Promise.allSettled([indexer.sync(), second.sync()]);
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
    // A losing first-block racer may fail a unique constraint; a retry must
    // converge without double canonical logs or settlement.
    await indexer.sync();
    const row = await fixture.pool.query(`SELECT count(*) AS count FROM chain_events WHERE canonical`);
    expect(row.rows[0].count).toBe('1');
    expect((await snapshot()).command).toBe('finalized');
  });
});
