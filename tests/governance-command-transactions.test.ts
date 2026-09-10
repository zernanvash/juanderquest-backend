import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import { MemoryDb } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { GovernanceStore } from '../src/governance/store.js';
import { vouchersService } from '../src/services/vouchers.js';

const realIt = process.env.JDQ_REAL_PG_URL ? it : it.skip;

describe('Authoritative governance commands (V3 regression)', () => {
  let database: TestDbInstance;
  let memory: MemoryDb;
  let a: GovernanceStore;
  let b: GovernanceStore;
  let initial: ReturnType<GovernanceStore['snapshot']>;

  beforeAll(async () => { database = await createTestDb(); setPool(database.pool); });
  afterAll(async () => { setPool(null); await database?.close(); });
  beforeEach(async () => {
    // Only this harness's isolated disposable schema is modified.
    await database.pool.query('DELETE FROM governance_ledger');
    await database.pool.query('DELETE FROM governance_audit');
    await database.pool.query('DELETE FROM redemptions');
    await database.pool.query(`INSERT INTO users (id,seed_id,display_name,email,role,demo_points)
      VALUES ('cmd-a','cmd-a','A','cmd-a@test.local','user',100),('cmd-b','cmd-b','B','cmd-b@test.local','user',100)
      ON CONFLICT (id) DO UPDATE SET demo_points = 100`);
    await database.pool.query(`INSERT INTO merchants (id,name,location,description)
      VALUES ('cmd-m','Merchant','Test','Test') ON CONFLICT (id) DO NOTHING`);
    await database.pool.query(`INSERT INTO vouchers (id,merchant_id,title,description,cost_points,is_active)
      VALUES ('cmd-v','cmd-m','Test voucher','Test',98,true) ON CONFLICT (id) DO NOTHING`);
    memory = new MemoryDb();
    memory.users = (await database.pool.query("SELECT * FROM users WHERE id IN ('cmd-a','cmd-b')")).rows;
    memory.quests = []; memory.submissions = [];
    a = new GovernanceStore(memory);
    initial = a.snapshot();
    initial.proposals = initial.proposals.slice(0, 1);
    Object.assign(initial.proposals[0], { id: 'cmd-p', state: 'voting', eligible_voter_ids: ['cmd-a', 'cmd-b'],
      voting_closes_at: new Date(Date.now() + 86_400_000).toISOString(), quorum_required: 1 });
    initial.issuedMjdq = 200_000;
    await database.pool.query('INSERT INTO governance_snapshot (id,data) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data', [JSON.stringify(initial)]);
    a.restore(initial); a.attachPg(database.pool);
    b = new GovernanceStore(memory); b.restore(initial); b.attachPg(database.pool);
  });

  async function durable() {
    return (await database.pool.query('SELECT data FROM governance_snapshot WHERE id=1')).rows[0].data as typeof initial;
  }

  async function assertTwoVotes() {
    const state = await durable();
    expect(state.votes).toHaveLength(2);
    expect(state.proposals[0]).toMatchObject({ votes: 2, yes_votes: 2, escrow_mjdq: 8000 });
    expect(state.burnedMjdq).toBe(2000);
    const { rows } = await database.pool.query("SELECT demo_points FROM users WHERE id IN ('cmd-a','cmd-b') ORDER BY id");
    expect(rows.map((row) => row.demo_points)).toEqual([95, 95]);
    expect(state.balances['cmd-a']).toBe(95000);
    expect(state.balances['cmd-b']).toBe(95000);
    const ledger = (await database.pool.query('SELECT amount_mjdq FROM governance_ledger')).rows;
    expect(ledger).toHaveLength(12);
    expect(ledger.reduce((sum, row) => sum + Number(row.amount_mjdq), 0)).toBe(0);
    const restarted = new GovernanceStore(memory);
    await restarted.hydrateFromPg(database.pool);
    expect(restarted.getTokenomics().reconciliation_difference_mjdq).toBe(0);
    expect(restarted.getTokenomics().total_issued_mjdq).toBe(200000);
  }

  it('uses current state for two stale workers: balances, tallies, escrow and burns reconcile after restart', async () => {
    await a.castProposalVote('cmd-p', 'cmd-a', 'yes', 'vote-a');
    await b.castProposalVote('cmd-p', 'cmd-b', 'yes', 'vote-b');
    await assertTwoVotes();
  });

  it('does not resurrect a stale balance when another worker updates controls', async () => {
    const result = await vouchersService.redeemVoucher('cmd-v', 'cmd-a', randomUUID());
    expect(result.success).toBe(true);
    await b.updateControls('admin', { pause_votes: true }, 'test');
    expect((await durable()).balances['cmd-a']).toBe(2000);
    expect((await durable()).burnedMjdq).toBe(0);
    expect(memory.findUserById('cmd-a')?.demo_points).toBe(2);
    const restarted = new GovernanceStore(memory); await restarted.hydrateFromPg(database.pool);
    expect(restarted.getTokenomics().merchant_held_mjdq).toBe(98000);
    expect(restarted.getTokenomics().reconciliation_difference_mjdq).toBe(0);
  });

  it('rejects duplicate voting and replays the original durable response without another fee', async () => {
    const first = await a.castProposalVote('cmd-p', 'cmd-a', 'yes', 'same-key');
    expect(await b.castProposalVote('cmd-p', 'cmd-a', 'yes', 'same-key')).toEqual(first);
    await expect(b.castProposalVote('cmd-p', 'cmd-a', 'no', 'other-key')).rejects.toThrow('ALREADY_VOTED');
    await expect(b.castProposalVote('cmd-p', 'cmd-a', 'no', 'same-key')).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect((await durable()).votes).toHaveLength(1);
    expect((await durable()).balances['cmd-a']).toBe(95000);
  });

  it('validates pause controls from PostgreSQL, not an old worker snapshot', async () => {
    await a.updateControls('admin', { pause_votes: true }, 'test');
    await expect(b.castProposalVote('cmd-p', 'cmd-b', 'yes', 'blocked')).rejects.toThrow('VOTES_PAUSED');
    expect((await durable()).votes).toHaveLength(0);
  });

  it('initializes a fresh migration baseline before a voucher debit, without inventing reward issuance', async () => {
    await database.pool.query('UPDATE governance_snapshot SET data=$1 WHERE id=1', [JSON.stringify({ledger:[],audit:[],balances:{},issuedMjdq:0,controls:{}})]);
    expect((await vouchersService.redeemVoucher('cmd-v','cmd-a',randomUUID())).success).toBe(true);
    const snapshot = await durable();
    expect(snapshot.issuedMjdq).toBe(200000);
    expect(snapshot.balances['cmd-a']).toBe(2000);
    const restarted = new GovernanceStore(memory); await restarted.hydrateFromPg(database.pool);
    expect(restarted.getTokenomics().reconciliation_difference_mjdq).toBe(0);
  });

  it('preserves fractional mJDQ payout shares through SQL projection and restart', async () => {
    initial.balances['cmd-a'] = 90000;
    Object.assign(initial.proposals[0], {state:'payout_pending',escrow_mjdq:10000,
      recipients:[{user_id:'cmd-a',display_name:'A',role:'organizer',duty:'test',share_bps:6667},
        {user_id:'cmd-b',display_name:'B',role:'merchant',duty:'test',share_bps:3333}]});
    await database.pool.query("UPDATE users SET demo_points=90 WHERE id='cmd-a'");
    await database.pool.query('UPDATE governance_snapshot SET data=$1 WHERE id=1',[JSON.stringify(initial)]);
    await a.finalizePayout('cmd-p','admin');
    let snapshot = await durable();
    expect(snapshot.balances['cmd-a']).toBe(96667);
    expect(snapshot.balances['cmd-b']).toBe(103333);
    expect(snapshot.proposals[0].state).toBe('completed');
    await b.updateControls('admin',{pause_votes:false},'preserve remainders');
    snapshot = await durable();
    expect(snapshot.balances['cmd-a']).toBe(96667);
    expect(snapshot.balances['cmd-b']).toBe(103333);
    expect((await database.pool.query("SELECT demo_points FROM users WHERE id='cmd-a'")).rows[0].demo_points).toBe(96);
    const restarted = new GovernanceStore(memory); await restarted.hydrateFromPg(database.pool);
    expect(restarted.balanceOf('cmd-a')).toBe(96667);
    expect(restarted.getTokenomics().reconciliation_difference_mjdq).toBe(0);
  });

  it('fails closed when the governance migration singleton is missing', async () => {
    await database.pool.query('DELETE FROM governance_snapshot WHERE id=1');
    await expect(a.castProposalVote('cmd-p','cmd-a','yes','missing')).rejects.toThrow('GOVERNANCE_SNAPSHOT_MISSING');
    expect(memory.findUserById('cmd-a')?.demo_points).toBe(100);
  });

  async function faultAt(needle: string, mode: 'error' | 'rollback' | 'lost-ack') {
    const connect = database.pool.connect.bind(database.pool);
    return jest.spyOn(database.pool, 'connect').mockImplementation(async () => {
      const client = await connect();
      const query = client.query.bind(client), release = client.release.bind(client);
      client.query = (async (sql: any, params: any) => {
        if (typeof sql === 'string' && sql.includes(needle)) {
          if (mode === 'rollback') { await query('ROLLBACK'); return { command: 'ROLLBACK', rows: [] }; }
          if (mode === 'lost-ack') { await query('COMMIT'); throw new Error('LOST_COMMIT_ACK'); }
          throw new Error('INJECTED_WRITE_FAILURE');
        }
        return query(sql, params);
      }) as any;
      client.release = ((error?: any) => { client.query = query; client.release = release; release(error); }) as any;
      return client;
    });
  }

  it('does not publish failed transaction state or mutate shared users', async () => {
    const before = a.snapshot(); const spy = await faultAt('INSERT INTO governance_ledger', 'error');
    try { await expect(a.castProposalVote('cmd-p', 'cmd-a', 'yes', 'fail')).rejects.toThrow('INJECTED_WRITE_FAILURE'); }
    finally { spy.mockRestore(); }
    expect(a.snapshot()).toEqual(before);
    expect(memory.findUserById('cmd-a')?.demo_points).toBe(100);
    if (process.env.JDQ_REAL_PG_URL) {
      expect(await durable()).toEqual(initial);
      expect((await database.pool.query("SELECT demo_points FROM users WHERE id='cmd-a'")).rows[0].demo_points).toBe(100);
      expect((await database.pool.query('SELECT * FROM governance_ledger')).rows).toHaveLength(0);
    }
  });

  it('rejects aborted COMMIT without publishing memory changes', async () => {
    const before = a.snapshot(); const spy = await faultAt('COMMIT', 'rollback');
    try { await expect(a.castProposalVote('cmd-p', 'cmd-a', 'yes', 'abort')).rejects.toThrow('TRANSACTION_ABORTED'); }
    finally { spy.mockRestore(); }
    expect(a.snapshot()).toEqual(before);
    expect(memory.findUserById('cmd-a')?.demo_points).toBe(100);
    if (process.env.JDQ_REAL_PG_URL) expect(await durable()).toEqual(initial);
  });

  realIt('recovers a real committed transaction after lost acknowledgement using durable idempotency', async () => {
    const spy = await faultAt('COMMIT', 'lost-ack');
    try { await expect(a.castProposalVote('cmd-p', 'cmd-a', 'yes', 'uncertain')).rejects.toThrow('LOST_COMMIT_ACK'); }
    finally { spy.mockRestore(); }
    expect(a.snapshot().votes).toHaveLength(0);
    await b.castProposalVote('cmd-p', 'cmd-a', 'yes', 'uncertain');
    expect((await durable()).votes).toHaveLength(1);
    expect((await durable()).balances['cmd-a']).toBe(95000);
    expect((await database.pool.query('SELECT * FROM governance_ledger')).rows).toHaveLength(6);
  });

  realIt('serializes two live connections voting on the same proposal', async () => {
    await Promise.all([a.castProposalVote('cmd-p','cmd-a','yes','parallel-a'), b.castProposalVote('cmd-p','cmd-b','yes','parallel-b')]);
    await assertTwoVotes();
  });

  realIt('rejects concurrent duplicate voters with different keys without charging twice', async () => {
    const outcomes = await Promise.allSettled([a.castProposalVote('cmd-p','cmd-a','yes','dup-a'),b.castProposalVote('cmd-p','cmd-a','yes','dup-b')]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await durable()).votes).toHaveLength(1);
    expect((await durable()).balances['cmd-a']).toBe(95000);
    expect((await database.pool.query('SELECT * FROM governance_ledger')).rows).toHaveLength(6);
  });

  realIt.each(['INSERT INTO governance_audit','UPDATE governance_snapshot'])('rolls back all accounting when %s fails', async (sql) => {
    const before = a.snapshot(); const spy = await faultAt(sql,'error');
    try { await expect(a.castProposalVote('cmd-p','cmd-a','yes','fault')).rejects.toThrow('INJECTED_WRITE_FAILURE'); }
    finally { spy.mockRestore(); }
    expect(a.snapshot()).toEqual(before);
    expect(await durable()).toEqual(initial);
    expect((await database.pool.query("SELECT demo_points FROM users WHERE id='cmd-a'")).rows[0].demo_points).toBe(100);
    expect((await database.pool.query('SELECT * FROM governance_ledger')).rows).toHaveLength(0);
    expect((await database.pool.query('SELECT * FROM governance_audit')).rows).toHaveLength(0);
  });

  realIt('prevents mixed voucher/vote double spending', async () => {
    const outcomes = await Promise.allSettled([
      a.castProposalVote('cmd-p','cmd-a','yes','mixed'),
      vouchersService.redeemVoucher('cmd-v','cmd-a',randomUUID()),
    ]);
    const points = (await database.pool.query("SELECT demo_points FROM users WHERE id='cmd-a'")).rows[0].demo_points;
    expect([2, 95]).toContain(points);
    const state = await durable();
    const redemptions = (await database.pool.query('SELECT * FROM redemptions')).rows;
    expect(state.votes.length + redemptions.length).toBe(1);
    expect(state.balances['cmd-a']).toBe(points * 1000);
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
  });

  realIt('serializes distinct votes across independent OS processes', async () => {
    const schema = (await database.pool.query('SELECT current_schema() AS name')).rows[0].name;
    const worker = (user: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve(__dirname,'helpers/governance-command-worker.cjs'),
        process.env.JDQ_REAL_PG_URL!, schema, user]);
      let stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Worker timeout')); }, 20000);
      child.stderr.on('data', (data) => { stderr += data.toString(); });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr)); });
    });
    await Promise.all([worker('cmd-a'),worker('cmd-b')]);
    await assertTwoVotes();
  }, 30000);
});
