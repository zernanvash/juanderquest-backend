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
