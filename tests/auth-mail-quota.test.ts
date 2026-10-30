import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { resetRateLimits } from '../src/middleware/rateLimit.js';

// The email budget on the auth routes. Real delivery is simulated: a key is set and fetch is stubbed.
describe('auth email limits on the routes', () => {
  let testDb: TestDbInstance;
  const saved = { key: process.env.RESEND_API_KEY, cap: process.env.AUTH_MAIL_DAILY_CAP };
  const fetchSpy = jest.spyOn(global, 'fetch');

  beforeAll(async () => {
    testDb = await createTestDb();
    await db.hydrateFromPg(testDb.pool);
    process.env.RESEND_API_KEY = 'test-key';
    fetchSpy.mockImplementation(async () => new Response('{"id":"x"}', { status: 200 }));
  }, 90000);

  beforeEach(() => {
    resetRateLimits();
    fetchSpy.mockClear();
    delete process.env.AUTH_MAIL_DAILY_CAP;
  });

  afterAll(async () => {
    fetchSpy.mockRestore();
    if (saved.key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved.key;
    if (saved.cap === undefined) delete process.env.AUTH_MAIL_DAILY_CAP; else process.env.AUTH_MAIL_DAILY_CAP = saved.cap;
    if (testDb) await testDb.close();
  }, 90000);

  const resendCalls = () => fetchSpy.mock.calls.filter(([url]) => String(url).includes('api.resend.com'));

  const register = (email: string) => request(app).post('/api/v1/auth/register').send({
    email, password: 'Password123!Safe', display_name: 'Quota Tester', age_eligibility_declared: true, terms_accepted: true,
  });

  it('a quick resend or reset request sends nothing, keeps the first code, and looks like an unknown address', async () => {
    const email = 'quota.one@example.com';
    const reg = await register(email);
    expect(reg.status).toBe(201);
    expect(resendCalls()).toHaveLength(1);

    const resend = await request(app).post('/api/v1/auth/email/resend').send({ email });
    const resendUnknown = await request(app).post('/api/v1/auth/email/resend').send({ email: 'nobody.here@example.com' });
    expect(resend.status).toBe(200);
    expect(resend.body).toEqual(resendUnknown.body);

    const forgot = await request(app).post('/api/v1/auth/password/forgot').send({ email });
    const forgotUnknown = await request(app).post('/api/v1/auth/password/forgot').send({ email: 'nobody.here@example.com' });
    expect(forgot.status).toBe(200);
    expect(forgot.body).toEqual(forgotUnknown.body);

    expect(resendCalls()).toHaveLength(1);
    const verify = await request(app).post('/api/v1/auth/email/verify').send({ email, code: reg.body.data.dev_code });
    expect(verify.status).toBe(200);
  });

  it('once the daily cap is reached, sign-up, resend and reset answer 503 and create nothing', async () => {
    process.env.AUTH_MAIL_DAILY_CAP = '1';
    const email = 'quota.two@example.com';
    const reg = await register(email);
    expect(reg.status).toBe(503);
    expect(reg.body.error.code).toBe('EMAIL_TEMPORARILY_UNAVAILABLE');
    expect(Number(reg.headers['retry-after'])).toBeGreaterThan(0);
    expect(await db.identityService.findIdentity('email', email)).toBeNull();

    for (const path of ['/api/v1/auth/email/resend', '/api/v1/auth/password/forgot']) {
      const res = await request(app).post(path).send({ email: 'quota.one@example.com' });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('EMAIL_TEMPORARILY_UNAVAILABLE');
    }
    expect(resendCalls()).toHaveLength(0);

    delete process.env.AUTH_MAIL_DAILY_CAP;
    expect((await register(email)).status).toBe(201);
  });
});
