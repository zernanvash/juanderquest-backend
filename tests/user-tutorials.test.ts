import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { resetRateLimits } from '../src/middleware/rateLimit.js';

// Owner 2026-11-04: the first-run tutorial shows once per account, even after
// clearing app data, so "seen" lives on the account.
describe('first-run tutorials seen (migration 079)', () => {
  let testDb: TestDbInstance;
  let token: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    await db.hydrateFromPg(testDb.pool);
    resetRateLimits();
    const email = 'tutorial.once@example.com';
    const password = 'TutorialOnce123!';
    const reg = await request(app).post('/api/v1/auth/register').send({
      email,
      password,
      display_name: 'Tutorial Tester',
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

  it('a new account has seen nothing', async () => {
    const res = await request(app).get('/api/v1/me/tutorials').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.seen).toEqual({});
  });

  it('marking one seen is stored, and marking it again keeps the first time', async () => {
    const first = await request(app).post('/api/v1/me/tutorials/home_first_run/seen').set(auth());
    expect(first.status).toBe(200);
    const at = first.body.data.seen.home_first_run;
    expect(typeof at).toBe('string');

    const again = await request(app).post('/api/v1/me/tutorials/home_first_run/seen').set(auth());
    expect(again.body.data.seen.home_first_run).toBe(at);

    const read = await request(app).get('/api/v1/me/tutorials').set(auth());
    expect(read.body.data.seen).toEqual({ home_first_run: at });
  });

  it('rejects odd keys and anonymous calls', async () => {
    const bad = await request(app).post('/api/v1/me/tutorials/Bad-Key!/seen').set(auth());
    expect(bad.status).toBe(400);
    const anon = await request(app).get('/api/v1/me/tutorials');
    expect(anon.status).toBe(401);
  });
});
