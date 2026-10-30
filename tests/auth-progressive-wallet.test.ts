import request from 'supertest';
import { Wallet } from 'ethers';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setGoogleFetch } from '../src/auth/google.js';

// Plan 67: account-first sign-in. Wallets never create a session on their own until
// the account has an email + password; shop purchases need a bound wallet.
describe('Plan 67 progressive auth and wallet onboarding', () => {
  let testDb: TestDbInstance;
  const original = { mode: env.WALLET_AUTH_MODE, google: env.GOOGLE_CLIENT_ID };

  beforeAll(async () => {
    Reflect.set(env, 'WALLET_AUTH_MODE', 'signature');
    testDb = await createTestDb();
    await db.hydrateFromPg(testDb.pool);
  }, 30000);

  afterAll(async () => {
    Reflect.set(env, 'WALLET_AUTH_MODE', original.mode);
    Reflect.set(env, 'GOOGLE_CLIENT_ID', original.google);
    setGoogleFetch((...args) => fetch(...args));
    if (testDb) await testDb.close();
  }, 30000);

  const walletLogin = async (wallet: ReturnType<typeof Wallet.createRandom>) => {
    const challenge = await request(app).post('/api/v1/auth/wallet/challenge').send({ address: wallet.address });
    expect(challenge.status).toBe(200);
    const signature = await wallet.signMessage(challenge.body.data.message);
    return request(app).post('/api/v1/auth/wallet/login').send({ address: wallet.address, signature });
  };

  const registerEmailUser = async (email: string, password = 'Password123!') => {
    const reg = await request(app).post('/api/v1/auth/register').send({
      email, password, display_name: 'Email Traveler', age_eligibility_declared: true, terms_accepted: true,
    });
    expect(reg.status).toBe(201);
    const verify = await request(app).post('/api/v1/auth/email/verify').send({ email, code: reg.body.data.dev_code });
    expect(verify.status).toBe(200);
    return verify.body.data as { token: string; user: { id: string; wallet_address: string | null } };
  };

  const complete = (body: Record<string, unknown>) =>
    request(app).post('/api/v1/auth/wallet/complete-registration').send({ age_eligibility_declared: true, terms_accepted: true, ...body });

  it('asks a brand-new wallet for email + password before any session exists', async () => {
    const wallet = Wallet.createRandom();
    const res = await walletLogin(wallet);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'requires_account_completion', account_completion_required: true, wallet_address: wallet.address });
    expect(res.body.data.token).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await db.findUserByWalletAddressDurable(wallet.address)).toBeUndefined();

    const done = await complete({
      wallet_onboarding_grant: res.body.data.wallet_onboarding_grant, wallet_address: wallet.address,
      email: 'first.wallet@example.com', password: 'WalletPass123', display_name: 'Wallet First',
    });
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe('authenticated');
    expect(done.body.data.user).toMatchObject({ email: 'first.wallet@example.com', display_name: 'Wallet First', wallet_address: wallet.address });
    expect(done.headers['set-cookie']).toBeDefined();

    // The grant is single use.
    const replay = await complete({
      wallet_onboarding_grant: res.body.data.wallet_onboarding_grant, wallet_address: wallet.address,
      email: 'other@example.com', password: 'WalletPass123',
    });
    expect(replay.status).toBe(401);

    // Both doors open the same account afterwards.
    const again = await walletLogin(wallet);
    expect(again.body.data.status).toBe('authenticated');
    expect(again.body.data.user.id).toBe(done.body.data.user.id);
    const byEmail = await request(app).post('/api/v1/auth/login').send({ email: 'first.wallet@example.com', password: 'WalletPass123' });
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.data.user.id).toBe(done.body.data.user.id);
  });

  it('rejects a grant presented for a different wallet', async () => {
    const wallet = Wallet.createRandom();
    const res = await walletLogin(wallet);
    const wrong = await complete({
      wallet_onboarding_grant: res.body.data.wallet_onboarding_grant, wallet_address: Wallet.createRandom().address,
      email: 'mismatch@example.com', password: 'WalletPass123',
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_ONBOARDING_GRANT');
  });

  it('keeps a legacy wallet-only account and its progress while adding the email', async () => {
    const wallet = Wallet.createRandom();
    const legacy = await db.findOrCreateUserDurable({
      seed_id: `wallet:${wallet.address.toLowerCase()}`, display_name: 'Old Wallet Scout',
      email: `${wallet.address.toLowerCase().slice(2)}@wallet.juanderquest.local`, role: 'user', wallet_address: wallet.address,
    });
    const res = await walletLogin(wallet);
    expect(res.body.data.status).toBe('requires_account_completion');
    expect(res.body.data.existing_display_name).toBe('Old Wallet Scout');

    const done = await complete({
      wallet_onboarding_grant: res.body.data.wallet_onboarding_grant, wallet_address: wallet.address,
      email: 'legacy.scout@example.com', password: 'LegacyPass123',
    });
    expect(done.status).toBe(200);
    expect(done.body.data.user.id).toBe(legacy.id);
    expect(done.body.data.user.email).toBe('legacy.scout@example.com');
    expect((await walletLogin(wallet)).body.data.status).toBe('authenticated');
  });

  it('links a wallet to an existing email account only with that account password', async () => {
    const owner = await registerEmailUser('has.account@example.com', 'OwnerPass123');
    const wallet = Wallet.createRandom();
    const res = await walletLogin(wallet);
    const wrong = await complete({
      wallet_onboarding_grant: res.body.data.wallet_onboarding_grant, wallet_address: wallet.address,
      email: 'has.account@example.com', password: 'NotTheirPass1',
    });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('EMAIL_ALREADY_EXISTS');

    const retry = await walletLogin(wallet);
    const right = await complete({
      wallet_onboarding_grant: retry.body.data.wallet_onboarding_grant, wallet_address: wallet.address,
      email: 'has.account@example.com', password: 'OwnerPass123',
    });
    expect(right.status).toBe(200);
    expect(right.body.data.user.id).toBe(owner.user.id);
    expect(right.body.data.user.wallet_address).toBe(wallet.address);
  });

  it('lets an email account browse but asks for a wallet before shop purchases', async () => {
    const { token, user } = await registerEmailUser('no.wallet@example.com');
    expect(user.wallet_address).toBeNull();
    const auth = { Authorization: `Bearer ${token}` };

    expect((await request(app).get('/api/v1/vouchers')).status).toBe(200);
    expect((await request(app).get('/api/v1/wallet').set(auth)).status).toBe(200);
    expect((await request(app).get('/api/v1/auth/me').set(auth)).status).toBe(200);

    const purchase = await request(app).post('/api/v1/wallet/cosmetics/frame-coast/purchase').set(auth).set('x-idempotency-key', 'k-1234567890');
    expect(purchase.status).toBe(403);
    expect(purchase.body.error).toMatchObject({ code: 'WALLET_REQUIRED', connect_url: '/wallet/connect' });
    const shopBuy = await request(app).post('/api/v1/shop/cosmetics/frame-coast/purchase').set(auth).send({ idempotency_key: 'shop-k-123456' });
    expect(shopBuy.status).toBe(403);
    expect(shopBuy.body.error.code).toBe('WALLET_REQUIRED');
    const redeem = await request(app).post('/api/v1/vouchers/v1/redeem').set(auth).send({});
    expect(redeem.status).toBe(403);
    expect(redeem.body.error.code).toBe('WALLET_REQUIRED');

    const wallet = Wallet.createRandom();
    const challenge = await request(app).post('/api/v1/auth/wallet/challenge').send({ address: wallet.address });
    const bind = await request(app).post('/api/v1/auth/wallet/bind').set(auth)
      .send({ address: wallet.address, signature: await wallet.signMessage(challenge.body.data.message) });
    expect(bind.status).toBe(200);
    const after = await request(app).post('/api/v1/wallet/cosmetics/frame-coast/purchase').set(auth).set('x-idempotency-key', 'k-1234567891');
    expect(after.body.error?.code).not.toBe('WALLET_REQUIRED');
    // An email + password account with a bound wallet signs straight in with the wallet.
    expect((await walletLogin(wallet)).body.data.status).toBe('authenticated');
  });

  it('signs in with a dev Google credential: first time needs terms, then the same account', async () => {
    const credential = 'dev_google:google.traveler@example.com:Google Traveler';
    const noTerms = await request(app).post('/api/v1/auth/google').send({ credential });
    expect(noTerms.status).toBe(400);
    expect(noTerms.body.error.code).toBe('TERMS_REQUIRED');

    const first = await request(app).post('/api/v1/auth/google').send({ credential, terms_accepted: true, age_eligibility_declared: true });
    expect(first.status).toBe(201);
    expect(first.body.data.user).toMatchObject({ email: 'google.traveler@example.com', display_name: 'Google Traveler', wallet_address: null });
    const second = await request(app).post('/api/v1/auth/google').send({ credential });
    expect(second.status).toBe(200);
    expect(second.body.data.user.id).toBe(first.body.data.user.id);

    // Google proves the email, so it joins the email account that already owns it.
    const existing = await registerEmailUser('both.ways@example.com');
    const linked = await request(app).post('/api/v1/auth/google').send({ credential: 'dev_google:both.ways@example.com:Both' });
    expect(linked.status).toBe(200);
    expect(linked.body.data.user.id).toBe(existing.user.id);
  });

  it('checks issuer, audience, expiry and email verification on real Google tokens', async () => {
    Reflect.set(env, 'GOOGLE_CLIENT_ID', 'client-123.apps.googleusercontent.com');
    const claims = {
      iss: 'https://accounts.google.com', aud: 'client-123.apps.googleusercontent.com', sub: 'google-sub-9',
      email: 'real.google@example.com', email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 600), name: 'Real G',
    };
    const respond = (body: object, status = 200) => setGoogleFetch(async () => new Response(JSON.stringify(body), { status }));
    const signIn = () => request(app).post('/api/v1/auth/google').send({ credential: 'header.payload.sig', terms_accepted: true, age_eligibility_declared: true });

    for (const bad of [{ aud: 'someone-else' }, { iss: 'evil.example' }, { email_verified: 'false' }, { exp: '1' }]) {
      respond({ ...claims, ...bad });
      const res = await signIn();
      expect(res.status).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    respond({ error: 'invalid_token' }, 400);
    expect((await signIn()).status).toBe(401);
    respond(claims);
    const ok = await signIn();
    expect(ok.status).toBe(201);
    expect(ok.body.data.user.email).toBe('real.google@example.com');
  });
});
