import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { db } from '../src/db/index.js';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { Wallet } from 'ethers';

describe('Progressive Web3 Onboarding & Wallet Binding', () => {
  let testDb: TestDbInstance;
  const originalWalletMode = env.WALLET_AUTH_MODE;

  beforeAll(async () => {
    env.WALLET_AUTH_MODE = 'signature';
    testDb = await createTestDb();
    await db.hydrateFromPg(testDb.pool);
  }, 30000);

  afterAll(async () => {
    env.WALLET_AUTH_MODE = originalWalletMode;
    if (testDb) await testDb.close();
  }, 30000);

  it('allows an existing traveler to bind an EVM wallet with SIWE signature and preserves identity upon direct wallet login', async () => {
    // 1. Create traveler
    const traveler = await db.findOrCreateUserDurable({
      seed_id: 'user-wallet-test-1',
      display_name: 'Traveler One',
      email: 'traveler-one@test.local',
      role: 'user',
    });

    const travelerLogin = await request(app)
      .post('/api/v1/auth/demo-login')
      .send({ seed_id: 'user-wallet-test-1' });

    expect(travelerLogin.status).toBe(200);
    const token = travelerLogin.body.data.token;
    const originalUserId = traveler.id;
    expect(originalUserId).toBeDefined();

    // 2. Generate a random EVM wallet
    const wallet = Wallet.createRandom();
    const address = wallet.address;

    // 3. Request challenge for this address
    const challengeRes = await request(app)
      .post('/api/v1/auth/wallet/challenge')
      .send({ address });

    expect(challengeRes.status).toBe(200);
    const challengeMessage = challengeRes.body.data.message;
    expect(challengeMessage).toContain(address);

    // 4. Sign message with wallet
    const signature = await wallet.signMessage(challengeMessage);

    // 5. Bind wallet to the authenticated traveler
    const bindRes = await request(app)
      .post('/api/v1/auth/wallet/bind')
      .set('Authorization', `Bearer ${token}`)
      .send({ address, signature });

    expect(bindRes.status).toBe(200);
    expect(bindRes.body.success).toBe(true);
    expect(bindRes.body.data.wallet_address).toBe(address);
    expect(bindRes.body.data.user.wallet_address).toBe(address);

    // 6. Verify row in PostgreSQL directly
    const pgRes = await testDb.pool.query('SELECT wallet_address FROM users WHERE id = $1', [originalUserId]);
    expect(pgRes.rows[0].wallet_address).toBe(address);

    // 7. Verify profile endpoint reflects the bound wallet
    const meRes = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.data.wallet_address).toBe(address);

    // 8. Prevent another user from binding the same wallet (409 Conflict)
    await db.findOrCreateUserDurable({
      seed_id: 'user-wallet-test-2',
      display_name: 'Traveler Two',
      email: 'traveler-two@test.local',
      role: 'user',
    });

    const traveler2Login = await request(app)
      .post('/api/v1/auth/demo-login')
      .send({ seed_id: 'user-wallet-test-2' });
    const token2 = traveler2Login.body.data.token;

    // Challenge and sign for user 2
    const challenge2Res = await request(app)
      .post('/api/v1/auth/wallet/challenge')
      .send({ address });
    const sig2 = await wallet.signMessage(challenge2Res.body.data.message);

    const conflictRes = await request(app)
      .post('/api/v1/auth/wallet/bind')
      .set('Authorization', `Bearer ${token2}`)
      .send({ address, signature: sig2 });

    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.error.code).toBe('WALLET_ALREADY_BOUND');

    // 9. DIRECT LOGIN WITH WALLET: User returns and logs in directly with wallet
    // Should resolve to originalUserId (user-1) without creating a duplicate account!
    const returnChallengeRes = await request(app)
      .post('/api/v1/auth/wallet/challenge')
      .send({ address });
    const returnSig = await wallet.signMessage(returnChallengeRes.body.data.message);

    const directLoginRes = await request(app)
      .post('/api/v1/auth/wallet/login')
      .send({ address, signature: returnSig });

    expect(directLoginRes.status).toBe(200);
    expect(directLoginRes.body.data.user.id).toBe(originalUserId);
    expect(directLoginRes.body.data.user.seed_id).toBe('user-wallet-test-1');

    // 10. UNBIND WALLET
    const unbindRes = await request(app)
      .delete('/api/v1/auth/wallet/unbind')
      .set('Authorization', `Bearer ${token}`);

    expect(unbindRes.status).toBe(200);
    expect(unbindRes.body.success).toBe(true);
    expect(unbindRes.body.data.user.wallet_address).toBeNull();

    // 11. Repeated unbind returns 400 WALLET_NOT_BOUND
    const repeatedUnbind = await request(app)
      .delete('/api/v1/auth/wallet/unbind')
      .set('Authorization', `Bearer ${token}`);

    expect(repeatedUnbind.status).toBe(400);
    expect(repeatedUnbind.body.error.code).toBe('WALLET_NOT_BOUND');
  });
});
