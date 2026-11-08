import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { resetRateLimits } from '../src/middleware/rateLimit.js';

// Owner 2026-11-08: travelers do most quests away from home, so the home town
// (My Town) is chosen by the traveler and stored on the account (migration 081).
describe('home town chosen by the traveler (migration 081)', () => {
  let testDb: TestDbInstance;
  let token: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    await db.hydrateFromPg(testDb.pool);
    resetRateLimits();
    const email = 'home.town@example.com';
    const password = 'HomeTown123!';
    const reg = await request(app).post('/api/v1/auth/register').send({
      email,
      password,
      display_name: 'Home Town Tester',
      age_eligibility_declared: true,
      terms_accepted: true,
    });
    expect(reg.status).toBe(201);
    await request(app).post('/api/v1/auth/email/verify').send({ email, code: reg.body.data.dev_code });
    const login = await request(app).post('/api/v1/auth/login').send({ email, password });
    expect(login.status).toBe(200);
    token = login.body.data.token;
  }, 90000);

  afterAll(async () => {
    if (testDb) await testDb.close();
  }, 90000);

  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('a new account has no home town and gets the town list', async () => {
    const res = await request(app).get('/api/v1/me/home-town').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.home_municipality).toBeNull();
    expect(res.body.data.options).toContain('Dagupan City');
    expect(res.body.data.options.length).toBe(48);
  });

  it('stores the canonical spelling and shows it on /auth/me', async () => {
    const put = await request(app).put('/api/v1/me/home-town').set(auth()).send({ municipality: '  dagupan city ' });
    expect(put.status).toBe(200);
    expect(put.body.data.home_municipality).toBe('Dagupan City');

    const me = await request(app).get('/api/v1/auth/me').set(auth());
    expect(me.body.data.home_municipality).toBe('Dagupan City');
    const { rows } = await testDb.pool.query('SELECT home_municipality FROM users WHERE email = $1', ['home.town@example.com']);
    expect(rows[0].home_municipality).toBe('Dagupan City');
  });

  it('can be cleared ("I\'m visiting")', async () => {
    const put = await request(app).put('/api/v1/me/home-town').set(auth()).send({ municipality: null });
    expect(put.status).toBe(200);
    expect(put.body.data.home_municipality).toBeNull();
    const read = await request(app).get('/api/v1/me/home-town').set(auth());
    expect(read.body.data.home_municipality).toBeNull();
  });

  it('rejects towns outside Pangasinan, bad bodies and anonymous calls', async () => {
    const unknown = await request(app).put('/api/v1/me/home-town').set(auth()).send({ municipality: 'Quezon City' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('UNKNOWN_TOWN');
    const bad = await request(app).put('/api/v1/me/home-town').set(auth()).send({ municipality: 5 });
    expect(bad.status).toBe(400);
    const anon = await request(app).put('/api/v1/me/home-town').send({ municipality: 'Bolinao' });
    expect(anon.status).toBe(401);
  });
});
