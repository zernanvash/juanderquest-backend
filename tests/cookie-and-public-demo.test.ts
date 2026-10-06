import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';

describe('wallet cookie session and laptop-alpha simulation boundary', () => {
  let testDb: TestDbInstance;
  let userId: string;
  const oldAlphaFlag = env.ALPHA_WALLET_SIMULATION_ENABLED;

  beforeAll(async () => {
    testDb = await createTestDb();
    await db.hydrateFromPg(testDb.pool);
    const user = await db.findOrCreateUserDurable({
      seed_id: 'wallet:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      display_name: 'Cookie Traveler',
      email: 'cookie-traveler@simulation.invalid',
    });
    userId = user.id;
  }, 30000);

  afterAll(async () => {
    Reflect.set(env, 'ALPHA_WALLET_SIMULATION_ENABLED', oldAlphaFlag);
    await testDb.close();
  });

  it('upgrades a legacy bearer into an HttpOnly cookie and restores a session', async () => {
    const agent = request.agent(app);
    const token = jwt.sign({ id: userId, role: 'user', seed_id: 'wallet:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, env.JWT_SECRET, { expiresIn: '1h' });
    const upgraded = await agent.post('/api/v1/auth/session/upgrade')
      .set('Authorization', `Bearer ${token}`)
      .send({ remember_me: true });
    expect(upgraded.status).toBe(200);
    expect(upgraded.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(upgraded.headers['set-cookie'][0]).toContain('SameSite=Lax');
    expect(upgraded.headers['set-cookie'][0]).toContain('Max-Age=604800');
    const restored = await agent.get('/api/v1/auth/me');
    expect(restored.status).toBe(200);
    expect(restored.body.data.id).toBe(userId);
    const loggedOut = await agent.post('/api/v1/auth/logout').set('Origin', 'http://localhost:3000');
    expect(loggedOut.status).toBe(200);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('rejects a cookie-authenticated mutation without an approved origin', async () => {
    const response = await request(app).post('/api/v1/auth/logout').set('Cookie', 'jdq_session=fake');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('INVALID_ORIGIN');
  });

  it('does not expose synthetic data to anonymous readers', async () => {
    Reflect.set(env, 'ALPHA_WALLET_SIMULATION_ENABLED', true);
    const response = await request(app).get('/api/v1/feed');
    expect(response.status).toBe(200);
    expect(response.headers['x-robots-tag']).toBeUndefined();
  });

  it('grants the seeded read scope to a durable wallet session without preview headers', async () => {
    Reflect.set(env, 'ALPHA_WALLET_SIMULATION_ENABLED', true);
    const durableScope = await db.usersRepo.findAlphaSessionScopesByIds([userId]);
    expect(durableScope.get(userId)).toMatchObject({
      id: userId,
      seed_id: 'wallet:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      is_test: false,
    });
    const token = jwt.sign({ id: userId, role: 'user', seed_id: 'wallet:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, env.JWT_SECRET, { expiresIn: '1h' });
    const response = await request(app).get('/api/v1/feed').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.headers['x-robots-tag']).toContain('noindex');
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('keeps wallet simulation off by default outside the alpha flag', async () => {
    Reflect.set(env, 'ALPHA_WALLET_SIMULATION_ENABLED', false);
    const token = jwt.sign({ id: userId, role: 'user', seed_id: 'wallet:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, env.JWT_SECRET, { expiresIn: '1h' });
    const response = await request(app).get('/api/v1/feed').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.headers['x-robots-tag']).toBeUndefined();
  });
});
