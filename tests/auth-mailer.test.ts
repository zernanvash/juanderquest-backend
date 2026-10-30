import { AuthMailerService, renderAuthEmail } from '../src/auth/mailerService.js';

describe('AuthMailerService (Resend)', () => {
  const saved = { key: process.env.RESEND_API_KEY, from: process.env.MAIL_FROM, env: process.env.NODE_ENV };
  afterEach(() => {
    process.env.RESEND_API_KEY = saved.key;
    process.env.MAIL_FROM = saved.from;
    process.env.NODE_ENV = saved.env;
    if (saved.key === undefined) delete process.env.RESEND_API_KEY;
    if (saved.from === undefined) delete process.env.MAIL_FROM;
  });

  const job = { id: 'j1', recipientEmail: ' Juan@Example.com ', templateType: 'signup_otp' as const, code: '123456' };

  it('sends the code through Resend when a key is set', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    delete process.env.MAIL_FROM;
    const calls: any[] = [];
    const mailer = new AuthMailerService(null, async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '{"id":"x"}' };
    });
    const result = await mailer.queueAuthEmail(job);
    expect(result.delivered).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(calls[0].init.body);
    expect(body.to).toEqual(['juan@example.com']);
    expect(body.from).toBe('JuanDerQuest <noreply@juanderquest.app>');
    expect(body.subject).toContain('123456');
    expect(body.text).toContain('123456');
    expect(body.html).toContain('123456');
  });

  it('records a failure without throwing when Resend refuses', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    const mailer = new AuthMailerService(null, async () => ({ ok: false, status: 403, text: async () => 'domain not verified' }));
    const result = await mailer.queueAuthEmail(job);
    expect(result.delivered).toBe(false);
  });

  it('records a failure without throwing when the request errors', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    const mailer = new AuthMailerService(null, async () => { throw new Error('offline'); });
    await expect(mailer.queueAuthEmail(job)).resolves.toMatchObject({ delivered: false });
  });

  it('without a key: development only logs, production reports not delivered', async () => {
    delete process.env.RESEND_API_KEY;
    const fetchImpl = jest.fn();
    const mailer = new AuthMailerService(null, fetchImpl as any);
    process.env.NODE_ENV = 'test';
    await expect(mailer.queueAuthEmail(job)).resolves.toMatchObject({ delivered: true, simulatedDevCode: '123456' });
    process.env.NODE_ENV = 'production';
    const prod = await mailer.queueAuthEmail(job);
    expect(prod.delivered).toBe(false);
    expect(prod.simulatedDevCode).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('escapes the code in the HTML body and names each template', () => {
    expect(renderAuthEmail({ templateType: 'signup_otp', code: '<b>' }).html).toContain('&lt;b&gt;');
    expect(renderAuthEmail({ templateType: 'password_reset_otp', code: '654321' }).subject).toContain('password reset');
    expect(renderAuthEmail({ templateType: 'password_changed_alert' }).subject).toContain('password was changed');
  });
});

describe('AuthMailerService send limits', () => {
  const saved = { key: process.env.RESEND_API_KEY, cap: process.env.AUTH_MAIL_DAILY_CAP };
  afterEach(() => {
    if (saved.key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved.key;
    if (saved.cap === undefined) delete process.env.AUTH_MAIL_DAILY_CAP; else process.env.AUTH_MAIL_DAILY_CAP = saved.cap;
  });

  const setup = () => {
    let clock = Date.parse('2026-10-30T10:00:00Z');
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }));
    const mailer = new AuthMailerService(null, fetchImpl as any, () => clock);
    const send = (email: string) => mailer.queueAuthEmail({ id: 'x', recipientEmail: email, templateType: 'signup_otp', code: '111111' });
    return { mailer, fetchImpl, send, advance: (seconds: number) => { clock += seconds * 1000; } };
  };

  it('allows one email per recipient per minute', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    const { mailer, fetchImpl, send, advance } = setup();
    expect((await send('a@example.com')).delivered).toBe(true);
    advance(30);
    expect(await mailer.checkSendAllowance('A@example.com ')).toEqual({ allowed: false, reason: 'RECIPIENT_COOLDOWN', retryAfterSeconds: 60 });
    expect((await send('a@example.com')).delivered).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await send('b@example.com')).delivered).toBe(true);
    advance(31);
    expect((await send('a@example.com')).delivered).toBe(true);
  });

  it('allows at most five emails per recipient per hour', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    const { mailer, send, advance } = setup();
    for (let i = 0; i < 5; i += 1) {
      expect((await send('a@example.com')).delivered).toBe(true);
      advance(61);
    }
    expect(await mailer.checkSendAllowance('a@example.com')).toMatchObject({ allowed: false, reason: 'RECIPIENT_HOURLY_LIMIT' });
    advance(3600);
    expect((await send('a@example.com')).delivered).toBe(true);
  });

  it('stops every send once the daily cap is reached', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    process.env.AUTH_MAIL_DAILY_CAP = '2';
    const { mailer, fetchImpl, send } = setup();
    expect((await send('a@example.com')).delivered).toBe(true);
    expect((await send('b@example.com')).delivered).toBe(true);
    const refused = await mailer.checkSendAllowance('c@example.com');
    expect(refused).toMatchObject({ allowed: false, reason: 'DAILY_CAP' });
    expect((refused as any).retryAfterSeconds).toBe(14 * 3600);
    expect((await send('c@example.com')).delivered).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not limit when delivery is off (development without a key)', async () => {
    delete process.env.RESEND_API_KEY;
    const { mailer, send } = setup();
    await send('a@example.com');
    expect(await mailer.checkSendAllowance('a@example.com')).toEqual({ allowed: true });
  });
});
