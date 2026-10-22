import request from 'supertest';
import { randomUUID } from 'crypto';
import { app } from '../src/app.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db } from '../src/db/index.js';
import { signSessionToken } from '../src/auth/tokens.js';
import { badgeEntitlement, badgeTokenId, badgeTokenUri, isBadgeTokenId } from '../src/chain/badgeIdentity.js';
import { runBadgeMintTick, type BadgeChain, type BadgeReceipt } from '../src/chain/badgeMinter.js';
import { badgeState } from '../src/routes/chainBadges.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
const CHAIN = 80002;
const WALLET = '0x1111111111111111111111111111111111111111';
const OPTIONS = { chainId: CHAIN, confirmations: 3, maxAttempts: 2 };
const randomWallet = () => `0x${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '').slice(0, 8)}`;

/** In-memory badge contract + mempool. */
class FakeChain implements BadgeChain {
  readonly issuer = '0xcf36b1cd5677788deef68ae0f3879af7755cf2e8';
  head = 1000;
  balance = 10n ** 19n;
  nonce = 0;
  mined = 0;
  used = new Set<string>();
  receipts = new Map<string, BadgeReceipt>();
  sent: { recipient: string; tokenId: string; entitlement: string; uri: string; nonce: number }[] = [];
  failSend: Error | null = null;
  revertNext = false;
  autoMine = true;

  async latestBlock() { return this.head; }
  async balanceWei() { return this.balance; }
  async pendingNonce() { return this.nonce; }
  async minedNonce() { return this.mined; }
  async isEntitlementUsed(e: string) { return this.used.has(e); }
  async receipt(hash: string) { return this.receipts.get(hash) ?? null; }
  async sendIssue(args: FakeChain['sent'][number]) {
    if (this.failSend) throw this.failSend;
    this.sent.push(args);
    const hash = `0x${(this.sent.length).toString(16).padStart(64, '0')}`;
    this.nonce += 1;
    if (this.autoMine) {
      this.mined += 1;
      const success = !this.revertNext;
      this.revertNext = false;
      if (success) this.used.add(args.entitlement);
      this.receipts.set(hash, { success, blockNumber: this.head + 1, blockHash: `0x${'b'.repeat(63)}${this.sent.length}` });
    }
    return hash;
  }
}

describe('badge identity', () => {
  it('is deterministic per award and valid for the contract', () => {
    const award = '7f0c7c55-2d52-4a8e-9a3f-3f3b8a1f2a10';
    expect(badgeEntitlement(award)).toBe(badgeEntitlement(award));
    expect(badgeEntitlement(award)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(badgeEntitlement(award)).not.toBe(badgeEntitlement(randomUUID()));
    expect(isBadgeTokenId(badgeTokenId(award))).toBe(true);
    expect(BigInt(badgeTokenId(award)) < 2n ** 256n).toBe(true);
    expect(badgeTokenUri('42')).toMatch(/\/api\/v1\/chain\/badges\/42$/);
  });

  it('maps award + command to a traveler-facing state', () => {
    const base = { is_test: false, revoked_at: null, wallet: WALLET, status: null as string | null };
    expect(badgeState({ ...base, wallet: null })).toBe('pending_wallet');
    expect(badgeState({ ...base, wallet: 'local-dev-wallet' })).toBe('pending_wallet');
    expect(badgeState(base)).toBe('queued');
    expect(badgeState({ ...base, status: 'submitted' })).toBe('minting');
    expect(badgeState({ ...base, status: 'finalized' })).toBe('on_chain');
    expect(badgeState({ ...base, status: 'failed' })).toBe('failed');
    expect(badgeState({ ...base, is_test: true })).toBe('test_only');
    expect(badgeState({ ...base, revoked_at: new Date() })).toBe('revoked');
  });
});

realPg('badge minter on disposable PostgreSQL (Plan 50)', () => {
  let fixture: TestDbInstance;
  let chain: FakeChain;

  const addUser = async (opts: { wallet?: string | null; isTest?: boolean; role?: string } = {}) => {
    const id = `u-badge-${randomUUID().slice(0, 8)}`;
    await fixture.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, role, wallet_address, is_test) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, `seed-${id}`, 'Badge Traveler', `${id}@test.local`, opts.role ?? 'user', opts.wallet === undefined ? randomWallet() : opts.wallet, opts.isTest ?? false]);
    db.users.push({ id, seed_id: `seed-${id}`, display_name: id, email: `${id}@test.local`, role: opts.role ?? 'user' } as any);
    return id;
  };
  const award = async (userId: string, achievement = 'first_footstep', isTest = false) => {
    const id = randomUUID();
    await fixture.pool.query(
      `INSERT INTO achievement_awards (id, user_id, achievement_id, season, is_test) VALUES ($1,$2,$3,'all_time',$4)`,
      [id, userId, achievement, isTest]);
    return id;
  };
  const command = async (awardId: string) =>
    (await fixture.pool.query(`SELECT * FROM chain_commands WHERE source_award_id = $1`, [awardId])).rows[0];

  beforeEach(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    chain = new FakeChain();
  }, 120_000);
  afterEach(async () => { await fixture?.close(); }, 120_000);

  it('queues only eligible awards: live, non-test, with a hex wallet', async () => {
    const ok = await award(await addUser({ wallet: WALLET }));
    const noWallet = await award(await addUser({ wallet: null }));
    const testUser = await award(await addUser({ isTest: true }));
    const testAward = await award(await addUser(), 'first_footstep', true);
    const revoked = await award(await addUser());
    await fixture.pool.query(`UPDATE achievement_awards SET revoked_at = now(), revocation_reason = 'test' WHERE id = $1`, [revoked]);

    const r = await runBadgeMintTick(fixture.pool, chain, OPTIONS);
    expect(r.enqueued).toBe(1);
    const cmd = await command(ok);
    expect(cmd).toMatchObject({ operation: 'badge_claim', recipient_address: WALLET, entitlement_id: badgeEntitlement(ok) });
    expect(String(cmd.expected_token_id)).toBe(badgeTokenId(ok));
    for (const id of [noWallet, testUser, testAward, revoked]) expect(await command(id)).toBeUndefined();
  });

  it('mints once, then confirms after enough blocks, and never re-sends', async () => {
    const id = await award(await addUser({ wallet: WALLET }));
    const first = await runBadgeMintTick(fixture.pool, chain, OPTIONS);
    expect(first.sent).toBeTruthy();
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]).toMatchObject({ recipient: WALLET, entitlement: badgeEntitlement(id), tokenId: badgeTokenId(id), nonce: 0 });
    expect((await command(id)).status).toBe('submitted');

    await runBadgeMintTick(fixture.pool, chain, OPTIONS);
    expect((await command(id)).status).toBe('included');

    chain.head += 5;
    await runBadgeMintTick(fixture.pool, chain, OPTIONS);
    expect((await command(id)).status).toBe('finalized');
    await runBadgeMintTick(fixture.pool, chain, OPTIONS);
    expect(chain.sent).toHaveLength(1);
  });

  it('keeps a badge pending until the traveler links a wallet', async () => {
    const user = await addUser({ wallet: null });
    const id = await award(user);
    await runBadgeMintTick(fixture.pool, chain, OPTIONS);
    expect(await command(id)).toBeUndefined();
    await fixture.pool.query(`UPDATE users SET wallet_address = $2 WHERE id = $1`, [user, '0x2222222222222222222222222222222222222222']);
    await runBadgeMintTick(fixture.pool, chain, OPTIONS);
    expect(chain.sent[0].recipient).toBe('0x2222222222222222222222222222222222222222');
  });

  it('skips sending when the entitlement is already on-chain', async () => {
    const id = await award(await addUser());
    chain.used.add(badgeEntitlement(id));
    await runBadgeMintTick(fixture.pool, chain, OPTIONS);
    expect(chain.sent).toHaveLength(0);
    expect((await command(id)).status).toBe('finalized');
  });

  it('backs off after a revert and gives up after the attempt limit', async () => {
    const id = await award(await addUser());
    const t0 = new Date('2026-10-22T10:00:00Z');
    chain.revertNext = true;
    await runBadgeMintTick(fixture.pool, chain, { ...OPTIONS, now: t0 });
    await runBadgeMintTick(fixture.pool, chain, { ...OPTIONS, now: t0 });
    let cmd = await command(id);
    expect(cmd.status).toBe('queued');
    expect(cmd.last_error).toMatch(/reverted/);
    expect(new Date(cmd.next_attempt_at).getTime()).toBeGreaterThan(t0.getTime());

    // Not due yet: nothing is sent.
    await runBadgeMintTick(fixture.pool, chain, { ...OPTIONS, now: t0 });
    expect(chain.sent).toHaveLength(1);

    const later = new Date(t0.getTime() + 3 * 60_000);
    chain.revertNext = true;
    await runBadgeMintTick(fixture.pool, chain, { ...OPTIONS, now: later });
    await runBadgeMintTick(fixture.pool, chain, { ...OPTIONS, now: later });
    cmd = await command(id);
    expect(chain.sent).toHaveLength(2);
    expect(cmd.status).toBe('failed');
  });

  it('records a send error without leaking long hex data', async () => {
    const id = await award(await addUser());
    chain.failSend = new Error(`insufficient funds 0x${'a'.repeat(130)}`);
    await runBadgeMintTick(fixture.pool, chain, OPTIONS);
    const cmd = await command(id);
    expect(cmd.status).toBe('queued');
    expect(cmd.attempt_count).toBe(1);
    expect(cmd.last_error).toContain('insufficient funds');
    expect(cmd.last_error).not.toMatch(/a{64}/);
  });

  it('does not send below the minimum issuer balance', async () => {
    await award(await addUser());
    chain.balance = 10n ** 15n;
    const r = await runBadgeMintTick(fixture.pool, chain, OPTIONS);
    expect(r.skipped).toBe('low_balance');
    expect(chain.sent).toHaveLength(0);
  });

  it('fails a queued badge whose award was revoked before minting', async () => {
    const id = await award(await addUser());
    chain.failSend = new Error('rpc down');
    await runBadgeMintTick(fixture.pool, chain, OPTIONS);
    await fixture.pool.query(`UPDATE achievement_awards SET revoked_at = now(), revocation_reason = 'fraud' WHERE id = $1`, [id]);
    chain.failSend = null;
    await runBadgeMintTick(fixture.pool, chain, { ...OPTIONS, now: new Date(Date.now() + 10 * 60_000) });
    expect(chain.sent).toHaveLength(0);
    expect((await command(id)).status).toBe('failed');
  });

  it('waits for a slow transaction and requeues one the network dropped', async () => {
    const id = await award(await addUser());
    chain.autoMine = false;
    const t0 = new Date();
    await runBadgeMintTick(fixture.pool, chain, { ...OPTIONS, now: t0 });
    expect((await command(id)).status).toBe('submitted');
    const late = new Date(t0.getTime() + 20 * 60_000);
    await runBadgeMintTick(fixture.pool, chain, { ...OPTIONS, now: late });
    expect((await command(id)).last_error).toMatch(/Waiting/);
    chain.mined = 1; // nonce consumed by something else; badge still missing
    await runBadgeMintTick(fixture.pool, chain, { ...OPTIONS, now: late });
    const cmd = await command(id);
    expect(cmd.status).toBe('queued');
    expect(cmd.last_error).toMatch(/dropped/);
  });

  it('lists every earned badge with its traveler in the admin ledger', async () => {
    const minted = await addUser({ wallet: WALLET });
    const waiting = await addUser({ wallet: null });
    const tester = await addUser({ isTest: true });
    const adminId = await addUser({ role: 'admin', wallet: null });
    await fixture.pool.query(`UPDATE users SET display_name = 'Maria Waiting', handle = 'maria' WHERE id = $1`, [waiting]);
    const mintedAward = await award(minted);
    const waitingAward = await award(waiting, 'pangasinan_pioneer');
    await award(tester);
    await runBadgeMintTick(fixture.pool, chain, OPTIONS);
    await runBadgeMintTick(fixture.pool, chain, OPTIONS);
    chain.head += 5;
    await runBadgeMintTick(fixture.pool, chain, OPTIONS);

    const adminAuth = { Authorization: `Bearer ${signSessionToken({ id: adminId, seed_id: `seed-${adminId}`, role: 'admin' })}` };
    const all = await request(app).get('/api/v1/admin/chain/badges/ledger').set(adminAuth);
    expect(all.status).toBe(200);
    expect(all.body.data.total).toBe(2); // the test user's award is excluded
    expect(all.body.data.totals).toMatchObject({ on_chain: 1, pending_wallet: 1 });
    const byAward = Object.fromEntries(all.body.data.entries.map((e: any) => [e.awardId, e]));
    expect(byAward[mintedAward]).toMatchObject({ state: 'on_chain', wallet: WALLET, tokenId: badgeTokenId(mintedAward) });
    expect(byAward[waitingAward]).toMatchObject({ state: 'pending_wallet', wallet: null, title: 'Pangasinan Pioneer',
      traveler: { id: waiting, name: 'Maria Waiting', handle: 'maria' } });

    const pendingOnly = await request(app).get('/api/v1/admin/chain/badges/ledger?state=pending_wallet').set(adminAuth);
    expect(pendingOnly.body.data.entries.map((e: any) => e.awardId)).toEqual([waitingAward]);
    expect(pendingOnly.body.data.total).toBe(2);
    const search = await request(app).get('/api/v1/admin/chain/badges/ledger?q=MARIA').set(adminAuth);
    expect(search.body.data.entries.map((e: any) => e.awardId)).toEqual([waitingAward]);

    expect((await request(app).get('/api/v1/admin/chain/badges/ledger')
      .set('Authorization', `Bearer ${signSessionToken({ id: minted, seed_id: `seed-${minted}`, role: 'user' })}`)).status).toBe(403);
  });

  it('serves badge status, public metadata, an image and the admin queue', async () => {
    const userId = await addUser({ wallet: WALLET });
    const adminId = await addUser({ role: 'admin', wallet: null });
    const id = await award(userId);
    const noWalletUser = await addUser({ wallet: null });
    await award(noWalletUser);
    await runBadgeMintTick(fixture.pool, chain, OPTIONS);
    await runBadgeMintTick(fixture.pool, chain, OPTIONS);
    chain.head += 5;
    await runBadgeMintTick(fixture.pool, chain, OPTIONS);
    const tokenId = badgeTokenId(id);

    const me = await request(app).get('/api/v1/me/chain/badges')
      .set('Authorization', `Bearer ${signSessionToken({ id: userId, seed_id: `seed-${userId}`, role: 'user' })}`);
    expect(me.status).toBe(200);
    expect(me.body.data.badges[0]).toMatchObject({ awardId: id, state: 'on_chain', tokenId, title: 'First Footstep' });
    expect(me.body.data.badges[0].tokenUrl).toContain(`/nft/0xc9b1cc4f980edf71daca182944ecb67e494b3e9b/${tokenId}`);

    const pending = await request(app).get('/api/v1/me/chain/badges')
      .set('Authorization', `Bearer ${signSessionToken({ id: noWalletUser, seed_id: `seed-${noWalletUser}`, role: 'user' })}`);
    expect(pending.body.data.badges[0].state).toBe('pending_wallet');

    const meta = await request(app).get(`/api/v1/chain/badges/${tokenId}`);
    expect(meta.status).toBe(200);
    expect(meta.body).toMatchObject({ name: 'JuanDerQuest · First Footstep' });
    expect(meta.body.image).toMatch(new RegExp(`/api/v1/chain/badges/${tokenId}/image\\.svg$`));
    expect(JSON.stringify(meta.body)).not.toContain(userId);
    expect(JSON.stringify(meta.body)).not.toContain(WALLET);
    const svg = await request(app).get(`/api/v1/chain/badges/${tokenId}/image.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    expect((await request(app).get('/api/v1/chain/badges/123')).status).toBe(404);
    expect((await request(app).get('/api/v1/chain/badges/abc')).status).toBe(404);

    const adminAuth = { Authorization: `Bearer ${signSessionToken({ id: adminId, seed_id: `seed-${adminId}`, role: 'admin' })}` };
    expect((await request(app).get('/api/v1/admin/chain/badges')
      .set('Authorization', `Bearer ${signSessionToken({ id: userId, seed_id: `seed-${userId}`, role: 'user' })}`)).status).toBe(403);
    const admin = await request(app).get('/api/v1/admin/chain/badges').set(adminAuth);
    expect(admin.status).toBe(200);
    expect(admin.body.data.counts).toMatchObject({ onChain: 1, waitingForWallet: 1, failed: 0 });

    const cmd = await command(id);
    expect((await request(app).post(`/api/v1/admin/chain/badges/${cmd.id}/retry`).set(adminAuth)).status).toBe(409);
    await fixture.pool.query(`UPDATE chain_commands SET status = 'failed' WHERE id = $1`, [cmd.id]);
    const retry = await request(app).post(`/api/v1/admin/chain/badges/${cmd.id}/retry`).set(adminAuth);
    expect(retry.status).toBe(200);
    expect((await command(id)).status).toBe('queued');
  });
});
