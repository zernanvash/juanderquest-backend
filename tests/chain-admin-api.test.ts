import request from 'supertest';
import { randomUUID } from 'crypto';
import { app } from '../src/app.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db } from '../src/db/index.js';
import { signSessionToken } from '../src/auth/tokens.js';
import { ROLE_HASHES, setChainStateReaderForTests, type ChainStateReader } from '../src/chain/stateReader.js';
import { clearChainOverviewCache, expectedRoles } from '../src/routes/chainAdmin.js';
import { runBalanceWatch } from '../src/chain/balanceWatch.js';
import { setFcmDryRun } from '../src/push/fcm.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

// Seeded by migration 060 (lowercase).
const TOKEN = '0x575c4b5b2e046accb003ba852df185126d6197b9';
const DISTRIBUTOR = '0x3542402bcb93e142437779eeea9e16d7163854ce';
const BADGE = '0xc9b1cc4f980edf71daca182944ecb67e494b3e9b';
const ADMIN = '0xccb1462779dc6ccfb2b4e6f9276dacd654d58c34';
const SIGNER = '0x40a479c7de6adadfb2ffdd331890f1e4c01e2e72';
const ISSUER = '0xcf36b1cd5677788deef68ae0f3879af7755cf2e8';
const OWNER = '0xfadd476c10b6a93bc26a226f9b7d8e8c556f9671';

/** A chain matching the 2026-10-22 deployment, with knobs to break it. */
class StubChain implements ChainStateReader {
  down = false;
  balances: Record<string, string> = { [ADMIN]: '9.8637', [ISSUER]: '10', [SIGNER]: '0', [OWNER]: '1538.6' };
  missing = new Set<string>(); // `${contract}|${role}|${account}` treated as not granted
  unknown = new Set<string>(); // ... treated as RPC failure (null)
  calls = 0;

  async latestBlock() { this.calls++; return this.down ? null : 50_800_000; }
  async wallet(a: string) { return { balancePol: this.down ? null : (this.balances[a] ?? '0'), nonce: this.down ? null : 1 }; }
  async paused(c: string) { return c === DISTRIBUTOR ? false : null; }
  async hasRole(c: string, role: string, account: string) {
    const key = `${c}|${role}|${account}`;
    if (this.unknown.has(key)) return null;
    if (this.missing.has(key)) return false;
    const admins = [ADMIN, OWNER, '0x8da921c89b3ff5b2b3a4628dec447785490b8a97', '0x426ad29d7e73d8a8d694bb5ec7e018d14f2032e9'];
    if (role === ROLE_HASHES.DEFAULT_ADMIN_ROLE) return admins.includes(account);
    if (role === ROLE_HASHES.MINTER_ROLE) return c === TOKEN && account === DISTRIBUTOR;
    if (role === ROLE_HASHES.SIGNER_ROLE) return c === DISTRIBUTOR && account === SIGNER;
    if (role === ROLE_HASHES.ISSUER_ROLE) return c === BADGE && account === ISSUER;
    return false;
  }
}

describe('expectedRoles', () => {
  it('derives the deployment rules from the registry', () => {
    const w = (role: string, address: string) => ({ id: role, chain_id: 80002, address, label: role, role, custody: 'server',
      owner_name: null, low_balance_pol: null, needs_gas: true, active: true, notes: null });
    const rules = expectedRoles(
      [w('admin', ADMIN), w('signer', SIGNER), w('badge_issuer', ISSUER), w('recovery_admin', OWNER), w('treasury', OWNER)],
      [{ name: 'token', address: TOKEN }, { name: 'distributor', address: DISTRIBUTOR }, { name: 'badge', address: BADGE }]);
    const fmt = rules.map((r) => `${r.contract.name}:${r.role}:${r.account === DISTRIBUTOR ? 'distributor' : r.label}:${r.expected}`);
    expect(fmt).toEqual(expect.arrayContaining([
      'token:DEFAULT_ADMIN_ROLE:admin:true', 'token:DEFAULT_ADMIN_ROLE:recovery_admin:true',
      'token:MINTER_ROLE:admin:false', 'token:MINTER_ROLE:distributor:true',
      'distributor:SIGNER_ROLE:signer:true', 'badge:ISSUER_ROLE:badge_issuer:true',
    ]));
    expect(fmt.some((f) => f.includes(':treasury:'))).toBe(false);
    expect(rules).toHaveLength(3 * 2 + 2 + 1 + 1);
  });
});

realPg('Admin chain API (Plan 49 WP4/WP5)', () => {
  let fixture: TestDbInstance;
  let chain: StubChain;
  let adminToken: string;
  let userToken: string;
  let adminId: string;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeEach(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    setFcmDryRun(true);
    chain = new StubChain();
    setChainStateReaderForTests(chain);
    clearChainOverviewCache();
    adminId = `u-chain-admin-${randomUUID().slice(0, 8)}`;
    const userId = `u-chain-user-${randomUUID().slice(0, 8)}`;
    for (const [id, role] of [[adminId, 'admin'], [userId, 'user']]) {
      await fixture.pool.query(
        `INSERT INTO users (id, seed_id, display_name, email, role) VALUES ($1, $2, $3, $4, $5)`,
        [id, `seed-${id}`, role === 'admin' ? 'Chain Admin' : 'Traveler', `${id}@test.local`, role]);
      db.users.push({ id, seed_id: `seed-${id}`, display_name: id, email: `${id}@test.local`, role } as any);
    }
    adminToken = signSessionToken({ id: adminId, seed_id: `seed-${adminId}`, role: 'admin' });
    userToken = signSessionToken({ id: userId, seed_id: `seed-${userId}`, role: 'user' });
  }, 120_000);

  afterEach(async () => {
    setChainStateReaderForTests(null);
    await fixture?.close();
  }, 120_000);

  it('requires an admin', async () => {
    expect((await request(app).get('/api/v1/admin/chain/overview')).status).toBe(401);
    expect((await request(app).get('/api/v1/admin/chain/overview').set(auth(userToken))).status).toBe(403);
  });

  it('shows the seeded wallets and contracts with live balances and no drift', async () => {
    const res = await request(app).get('/api/v1/admin/chain/overview').set(auth(adminToken));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.chain).toMatchObject({ id: 80002, name: 'Polygon Amoy', rpcHealthy: true, latestBlock: 50_800_000 });
    expect(d.wallets).toHaveLength(7);
    expect(d.wallets.find((w: any) => w.address === ADMIN)).toMatchObject({ balancePol: '9.8637', low: false, custody: 'server' });
    expect(d.contracts.map((c: any) => c.name).sort()).toEqual(['badge', 'distributor', 'token']);
    expect(d.contracts.find((c: any) => c.name === 'distributor').paused).toBe(false);
    const roles = d.contracts.flatMap((c: any) => c.roles);
    expect(roles.filter((r: any) => r.drift)).toEqual([]);
    expect(roles.find((r: any) => r.role === 'MINTER_ROLE' && r.account === ADMIN)).toMatchObject({ expected: false, onChain: false });
    // Nothing secret-looking ever comes back.
    expect(JSON.stringify(d)).not.toMatch(/private|mnemonic|secret/i);
  });

  it('flags drift for a missing role, but not for an RPC failure', async () => {
    chain.missing.add(`${BADGE}|${ROLE_HASHES.ISSUER_ROLE}|${ISSUER}`);
    chain.unknown.add(`${DISTRIBUTOR}|${ROLE_HASHES.SIGNER_ROLE}|${SIGNER}`);
    const res = await request(app).get('/api/v1/admin/chain/overview?refresh=1').set(auth(adminToken));
    const roles = res.body.data.contracts.flatMap((c: any) => c.roles);
    expect(roles.find((r: any) => r.role === 'ISSUER_ROLE')).toMatchObject({ onChain: false, drift: true });
    expect(roles.find((r: any) => r.role === 'SIGNER_ROLE')).toMatchObject({ onChain: null, drift: false });
  });

  it('still answers when every RPC is down', async () => {
    chain.down = true;
    const res = await request(app).get('/api/v1/admin/chain/overview?refresh=1').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.chain.rpcHealthy).toBe(false);
    expect(res.body.data.wallets.every((w: any) => w.balancePol === null && w.low === false)).toBe(true);
    expect(res.body.data.contracts.flatMap((c: any) => c.roles).some((r: any) => r.drift)).toBe(false);
  });

  it('caches the overview unless refresh=1', async () => {
    await request(app).get('/api/v1/admin/chain/overview').set(auth(adminToken));
    await request(app).get('/api/v1/admin/chain/overview').set(auth(adminToken));
    expect(chain.calls).toBe(1);
    await request(app).get('/api/v1/admin/chain/overview?refresh=1').set(auth(adminToken));
    expect(chain.calls).toBe(2);
  });

  it('refuses key-like fields, immutable fields and duplicates; audits create/update', async () => {
    const base = { chain_id: 80002, address: '0x9999999999999999999999999999999999999999', label: 'Evaluator wallet',
      role: 'recovery_admin', custody: 'personal' };
    const withKey = await request(app).post('/api/v1/admin/chain/wallets').set(auth(adminToken))
      .send({ ...base, private_key: '0xabc' });
    expect(withKey.status).toBe(400);
    expect(withKey.body.error.code).toBe('INVALID_FIELD');

    const created = await request(app).post('/api/v1/admin/chain/wallets').set(auth(adminToken)).send(base);
    expect(created.status).toBe(201);
    const dup = await request(app).post('/api/v1/admin/chain/wallets').set(auth(adminToken)).send(base);
    expect(dup.status).toBe(409);

    const id = created.body.data.id;
    const immutable = await request(app).patch(`/api/v1/admin/chain/wallets/${id}`).set(auth(adminToken))
      .send({ address: '0x1111111111111111111111111111111111111111' });
    expect(immutable.status).toBe(400);
    const patched = await request(app).patch(`/api/v1/admin/chain/wallets/${id}`).set(auth(adminToken))
      .send({ label: 'Evaluator (old)', active: false });
    expect(patched.status).toBe(200);

    const audit = await request(app).get('/api/v1/admin/chain/audit').set(auth(adminToken));
    expect(audit.status).toBe(200);
    const mine = audit.body.data.filter((r: any) => r.walletAddress === base.address);
    expect(mine.map((r: any) => r.action).sort()).toEqual(['wallet_created', 'wallet_updated']);
    expect(mine.every((r: any) => r.actorName === 'Chain Admin')).toBe(true);
  });

  it('low balance: one notification + one queued push per admin per day; signer never alerts', async () => {
    chain.balances[ADMIN] = '1.5'; // below the seeded 2 POL threshold
    chain.balances[SIGNER] = '0';  // needs_gas = false
    const now = new Date('2026-10-22T04:00:00Z');
    const first = await runBalanceWatch(fixture.pool, chain, 80002, now);
    expect(first).toMatchObject({ low: 1, notified: 1 });
    const again = await runBalanceWatch(fixture.pool, chain, 80002, now);
    expect(again.notified).toBe(0);

    const n = await fixture.pool.query(
      `SELECT kind, title FROM user_notifications WHERE user_id = $1 AND kind = 'chain_alert'`, [adminId]);
    expect(n.rows).toEqual([{ kind: 'chain_alert', title: 'Low POL: Server admin / deployer' }]);
    const p = await fixture.pool.query(
      `SELECT category, status FROM push_deliveries WHERE user_id = $1`, [adminId]);
    expect(p.rows).toEqual([{ category: 'account', status: 'queued' }]);
  });
});
