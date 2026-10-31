import request from 'supertest';
import { Wallet } from 'ethers';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { resetRateLimits } from '../src/middleware/rateLimit.js';
import { invalidateSessionScopeCache } from '../src/middleware/auth.js';

// Plan 72 review: after "sign out everywhere" the epoch is 1. Every sign-in path must put the
// current epoch in the new token, including users served from the in-memory cache and after a
// restart (re-hydration); otherwise a fresh login is born revoked.
describe('Plan 72 review: signing in again after revoke-all', () => {
  let testDb: TestDbInstance;
  const originalMode = env.WALLET_AUTH_MODE;

  beforeAll(async () => {
    Reflect.set(env, 'WALLET_AUTH_MODE', 'signature');
    testDb = await createTestDb();
    await db.hydrateFromPg(testDb.pool);
  }, 90000);

  afterAll(async () => {
    Reflect.set(env, 'WALLET_AUTH_MODE', originalMode);
    if (testDb) await testDb.close();
  }, 90000);

  beforeEach(() => {
    resetRateLimits();
    invalidateSessionScopeCache();
  });

  const walletLogin = async (wallet: ReturnType<typeof Wallet.createRandom>) => {
    const challenge = await request(app).post('/api/v1/auth/wallet/challenge').send({ address: wallet.address });
    expect(challenge.status).toBe(200);
    const signature = await wallet.signMessage(challenge.body.data.message);
    return request(app).post('/api/v1/auth/wallet/login').send({ address: wallet.address, signature });
  };

  const me = (token: string) => request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);

  it('issues working tokens by email and by wallet after revoke-all, also after a restart', async () => {
    const wallet = Wallet.createRandom();
    const email = 'relogin.wallet@example.com';
    const password = 'WalletPass123';

    const first = await walletLogin(wallet);
    expect(first.body.data.status).toBe('requires_account_completion');
    const done = await request(app).post('/api/v1/auth/wallet/complete-registration').send({
      age_eligibility_declared: true, terms_accepted: true,
      wallet_onboarding_grant: first.body.data.wallet_onboarding_grant, wallet_address: wallet.address,
      email, password, display_name: 'Relogin Scout',
    });
    expect(done.status).toBe(200);
    const oldToken = done.body.data.token as string;
    expect((await me(oldToken)).status).toBe(200);

    const revoke = await request(app).post('/api/v1/auth/sessions/revoke-all').set('Authorization', `Bearer ${oldToken}`);
    expect(revoke.status).toBe(200);
    expect((await me(oldToken)).status).toBe(401);

    const byEmail = await request(app).post('/api/v1/auth/login').send({ email, password });
    expect(byEmail.status).toBe(200);
    expect((await me(byEmail.body.data.token)).status).toBe(200);

    const byWallet = await walletLogin(wallet);
    expect(byWallet.status).toBe(200);
    expect((await me(byWallet.body.data.token)).status).toBe(200);

    // Simulate a restart: the cache is rebuilt from PostgreSQL.
    await db.hydrateFromPg(testDb.pool);
    invalidateSessionScopeCache();
    const afterRestartEmail = await request(app).post('/api/v1/auth/login').send({ email, password });
    expect((await me(afterRestartEmail.body.data.token)).status).toBe(200);
    const afterRestartWallet = await walletLogin(wallet);
    expect((await me(afterRestartWallet.body.data.token)).status).toBe(200);
    expect((await me(oldToken)).status).toBe(401);
  }, 60000);
});
