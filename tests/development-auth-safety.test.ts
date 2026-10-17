import request from 'supertest';
import { app } from '../src/app.js';
import { env, insecureLocalWalletAuthForbidden } from '../src/config/env.js';

describe('development authentication safety', () => {
  const original = {
    NODE_ENV: env.NODE_ENV,
    WALLET_AUTH_MODE: env.WALLET_AUTH_MODE,
    ALLOW_INSECURE_LOCAL_WALLET_AUTH: env.ALLOW_INSECURE_LOCAL_WALLET_AUTH,
    ALLOW_DEMO_LOGIN: env.ALLOW_DEMO_LOGIN,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) Reflect.set(env, key, value);
  });

  it('fails boot closed for an insecure wallet bypass in production and prod profile', () => {
    expect(insecureLocalWalletAuthForbidden('prod', 'development', true)).toBe(true);
    expect(insecureLocalWalletAuthForbidden(undefined, 'production', true)).toBe(true);
    expect(insecureLocalWalletAuthForbidden('dev', 'development', true)).toBe(false);
    expect(insecureLocalWalletAuthForbidden('prod', 'development', false)).toBe(false);
  });

  it('rejects demo admin login when explicitly disabled in development', async () => {
    Reflect.set(env, 'NODE_ENV', 'development');
    Reflect.set(env, 'ALLOW_DEMO_LOGIN', false);
    const response = await request(app).post('/api/v1/auth/demo-login').send({ seed_id: 'admin-1' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('DEMO_LOGIN_DISABLED');
  });

  it('does not allow a production demo login even if its flag is mistakenly enabled', async () => {
    Reflect.set(env, 'NODE_ENV', 'production');
    Reflect.set(env, 'ALLOW_DEMO_LOGIN', true);
    const response = await request(app).post('/api/v1/auth/demo-login').send({ seed_id: 'admin-1' });
    expect(response.status).toBe(403);
  });

  it('rejects unsigned local and simulated wallet bypasses by default in development', async () => {
    Reflect.set(env, 'NODE_ENV', 'development');
    Reflect.set(env, 'WALLET_AUTH_MODE', 'local');
    Reflect.set(env, 'ALLOW_INSECURE_LOCAL_WALLET_AUTH', false);
    const local = await request(app).post('/api/v1/auth/wallet/local-login').send({ address: 'dev-wallet-1' });
    const simulated = await request(app).post('/api/v1/auth/simulated-wallet-login').send({ username: 'Traveler', password: 'anything' });
    expect(local.status).toBe(403);
    expect(simulated.status).toBe(403);
  });

  it('never resolves the simulated username to a reserved admin or demo seed', async () => {
    Reflect.set(env, 'NODE_ENV', 'development');
    Reflect.set(env, 'ALLOW_INSECURE_LOCAL_WALLET_AUTH', true);
    for (const username of ['admin-1', 'user-1', 'user-2', 'user-3', 'coastal', 'maya', 'pao']) {
      const response = await request(app).post('/api/v1/auth/simulated-wallet-login')
        .send({ username, password: 'ignored-password' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('SIMULATED_LOGIN_RESERVED');
    }
  });

  it('rejects unsigned local wallet login in production even when the insecure flag is enabled', async () => {
    Reflect.set(env, 'NODE_ENV', 'production');
    Reflect.set(env, 'WALLET_AUTH_MODE', 'local');
    Reflect.set(env, 'ALLOW_INSECURE_LOCAL_WALLET_AUTH', true);
    const response = await request(app).post('/api/v1/auth/wallet/local-login').send({ address: 'dev-wallet-1' });
    expect(response.status).toBe(403);
  });
});

// 2026-10-17 incident: production ran with ALLOW_DEMO_LOGIN=true and
// ALPHA_WALLET_SIMULATION_ENABLED=true, so POST {seed_id:'admin-1'} auto-created
// and returned an admin session. These tests pin the live configuration.
describe('production demo login hardening', () => {
  const { db } = jest.requireActual('../src/db/index.js') as typeof import('../src/db/index.js');
  const original = {
    NODE_ENV: env.NODE_ENV,
    ALLOW_DEMO_LOGIN: env.ALLOW_DEMO_LOGIN,
    ALPHA_WALLET_SIMULATION_ENABLED: env.ALPHA_WALLET_SIMULATION_ENABLED,
  };
  const liveConfig = () => {
    Reflect.set(env, 'NODE_ENV', 'production');
    Reflect.set(env, 'ALLOW_DEMO_LOGIN', true);
    Reflect.set(env, 'ALPHA_WALLET_SIMULATION_ENABLED', true);
  };
  const stamp = Date.now();
  const adminSeed = `rel-admin-${stamp}`;
  const travelerSeed = `rel-traveler-${stamp}`;

  beforeAll(() => {
    db.users.push({ id: `${adminSeed}-id`, seed_id: adminSeed, display_name: 'Rel Admin', email: `${adminSeed}@x.test`,
      role: 'admin', demo_points: 0, is_test: false } as any);
    db.users.push({ id: `${travelerSeed}-id`, seed_id: travelerSeed, display_name: 'Rel Traveler', email: `${travelerSeed}@x.test`,
      role: 'user', demo_points: 0, is_test: false } as any);
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(original)) Reflect.set(env, key, value);
  });
  afterAll(() => {
    db.users = db.users.filter((u) => u.seed_id !== adminSeed && u.seed_id !== travelerSeed);
  });

  it('refuses an existing admin account even when demo login is switched on', async () => {
    liveConfig();
    const res = await request(app).post('/api/v1/auth/demo-login').send({ seed_id: adminSeed });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DEMO_LOGIN_RESERVED');
    expect(res.body.data?.token).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('never auto-provisions the canonical admin-1 or user-1 in production', async () => {
    liveConfig();
    const before = db.users.filter((u) => u.seed_id === 'admin-1' || u.seed_id === 'user-1').length;
    const admin = await request(app).post('/api/v1/auth/demo-login').send({ seed_id: 'admin-1' });
    expect(admin.status).not.toBe(200);
    expect(admin.body.data?.token).toBeUndefined();
    // user-1 may already exist as a traveler fixture (then it is allowed); it must never be created.
    const traveler = await request(app).post('/api/v1/auth/demo-login').send({ seed_id: 'user-1' });
    if (traveler.status === 200) expect(traveler.body.data.user.role).toBe('user');
    const after = db.users.filter((u) => u.seed_id === 'admin-1' || u.seed_id === 'user-1').length;
    expect(after).toBe(before);
  });

  it('still allows an existing traveler account when demo login is deliberately enabled', async () => {
    liveConfig();
    const res = await request(app).post('/api/v1/auth/demo-login').send({ seed_id: travelerSeed });
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe('user');
  });
});
