import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';

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

  it('rejects unsigned local wallet login in production even when the insecure flag is enabled', async () => {
    Reflect.set(env, 'NODE_ENV', 'production');
    Reflect.set(env, 'WALLET_AUTH_MODE', 'local');
    Reflect.set(env, 'ALLOW_INSECURE_LOCAL_WALLET_AUTH', true);
    const response = await request(app).post('/api/v1/auth/wallet/local-login').send({ address: 'dev-wallet-1' });
    expect(response.status).toBe(403);
  });
});
