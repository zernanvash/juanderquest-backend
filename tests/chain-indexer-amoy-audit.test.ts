import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { ChainIndexer, type ChainSource, type ObservedBlock } from '../src/chain/indexer.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
const h = (char: string) => `0x${char.repeat(64)}`;
const a = (char: string) => `0x${char.repeat(40)}`;
const token = a('1');
const distributor = a('2');
const badge = a('3');

class AmoyFixtureSource implements ChainSource {
  chainId = 80002;
  latest = 50776902;
  blocks = new Map<number, ObservedBlock>();

  constructor() {
    this.blocks.set(50776900, {
      number: 50776900,
      hash: h('a'),
      parentHash: h('0'),
      logs: [
        {
          txHash: h('1'),
          logIndex: 0,
          address: distributor,
          eventName: 'RoleGranted',
          roleHash: h('d'),
          account: a('4'),
          sender: a('5'),
        },
        {
          txHash: h('2'),
          logIndex: 1,
          address: distributor,
          eventName: 'Paused',
          account: a('5'),
        },
      ],
    });
    this.blocks.set(50776901, {
      number: 50776901,
      hash: h('b'),
      parentHash: h('a'),
      logs: [
        {
          txHash: h('3'),
          logIndex: 0,
          address: distributor,
          eventName: 'Unpaused',
          account: a('5'),
        },
        {
          txHash: h('4'),
          logIndex: 1,
          address: badge,
          eventName: 'RoleRevoked',
          roleHash: h('e'),
          account: a('6'),
          sender: a('5'),
        },
      ],
    });
  }

  async getChainId() { return this.chainId; }
  async getLatestBlockNumber() { return this.latest; }
  async getBlock(number: number) {
    const b = this.blocks.get(number);
    if (!b) throw new Error('BLOCK_NOT_FOUND');
    return b;
  }
}

realPg('ChainIndexer — Polygon Amoy Role & Pause Projections (WP3)', () => {
  let fixture: TestDbInstance;

  beforeEach(async () => {
    fixture = await createTestDb();
  }, 120_000);

  afterEach(async () => {
    await fixture?.close();
  }, 120_000);

  it('projects canonical RoleGranted, RoleRevoked, Paused, and Unpaused events into chain_wallet_audit', async () => {
    const source = new AmoyFixtureSource();
    const indexer = new ChainIndexer(fixture.pool, source, {
      chainId: 80002,
      tokenDistributor: distributor,
      badge,
      token,
      confirmations: 1,
      startBlock: 50776900,
    });

    const res = await indexer.sync(10);
    expect(res.processed).toBe(2);

    const auditRows = await fixture.pool.query(
      'SELECT action, wallet_address, contract_address, tx_hash, block_number FROM chain_wallet_audit WHERE chain_id = 80002 ORDER BY block_number ASC, action ASC'
    );
    expect(auditRows.rows.length).toBe(4);
    const actions = auditRows.rows.map(r => r.action);
    expect(actions).toContain('RoleGranted');
    expect(actions).toContain('Paused');
    expect(actions).toContain('Unpaused');
    expect(actions).toContain('RoleRevoked');
  });

  it('removes onchain audit projections on reorg rewind', async () => {
    const source = new AmoyFixtureSource();
    const indexer = new ChainIndexer(fixture.pool, source, {
      chainId: 80002,
      tokenDistributor: distributor,
      badge,
      token,
      confirmations: 1,
      startBlock: 50776900,
    });

    await indexer.sync(10);

    // Reorg block 50776901 with a new branch
    source.blocks.set(50776901, {
      number: 50776901,
      hash: h('c'),
      parentHash: h('a'),
      logs: [],
    });

    await indexer.sync(10);

    const auditRows = await fixture.pool.query(
      'SELECT action FROM chain_wallet_audit WHERE chain_id = 80002 AND block_number = 50776901'
    );
    // Events from old block 50776901 must be purged
    expect(auditRows.rows.length).toBe(0);
  });
});
