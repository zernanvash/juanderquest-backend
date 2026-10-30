import type { Pool } from 'pg';
import { randomUUID } from 'crypto';

export interface AuthMailJob {
  id: string;
  recipientEmail: string;
  templateType: 'signup_otp' | 'password_reset_otp' | 'password_changed_alert';
  code?: string;
}

export interface RenderedAuthEmail {
  subject: string;
  text: string;
  html: string;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const RESEND_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'JuanDerQuest <noreply@juanderquest.app>';

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Subject and body for each auth email. Codes are valid for 10 minutes (see routes/auth.ts). */
export function renderAuthEmail(job: Pick<AuthMailJob, 'templateType' | 'code'>): RenderedAuthEmail {
  const code = job.code ?? '';
  const codeBlock = `<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0">${escapeHtml(code)}</p>`;
  const footer = '<p style="color:#666;font-size:12px">If you did not ask for this, you can ignore this email.</p>';
  const wrap = (body: string) =>
    `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#222">`
    + `<h2 style="color:#582F0E">JuanDerQuest</h2>${body}${footer}</div>`;

  switch (job.templateType) {
    case 'signup_otp':
      return {
        subject: `${code} is your JuanDerQuest verification code`,
        text: `Welcome to JuanDerQuest!\n\nYour verification code is ${code}. It expires in 10 minutes.\n\nIf you did not create an account, you can ignore this email.`,
        html: wrap(`<p>Welcome to JuanDerQuest! Enter this code to verify your email:</p>${codeBlock}<p>It expires in 10 minutes.</p>`),
      };
    case 'password_reset_otp':
      return {
        subject: `${code} is your JuanDerQuest password reset code`,
        text: `Your password reset code is ${code}. It expires in 10 minutes.\n\nIf you did not ask to reset your password, you can ignore this email.`,
        html: wrap(`<p>Enter this code to reset your password:</p>${codeBlock}<p>It expires in 10 minutes.</p>`),
      };
    case 'password_changed_alert':
      return {
        subject: 'Your JuanDerQuest password was changed',
        text: 'The password on your JuanDerQuest account was just changed. If this was not you, reset your password now.',
        html: wrap('<p>The password on your JuanDerQuest account was just changed. If this was not you, reset your password now.</p>'),
      };
  }
}

export class AuthMailerService {
  private inMemoryOutbox: any[] = [];

  constructor(
    private pool: Pool | null,
    private fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {}

  setPool(pool: Pool | null) {
    this.pool = pool;
  }

  /**
   * Sends an authentication email through Resend when RESEND_API_KEY is set; otherwise only logs
   * it (dev/test). A failed send is recorded as 'failed' and never throws, so the account stays
   * created and the traveler can ask for a new code.
   */
  async queueAuthEmail(job: AuthMailJob): Promise<{ jobId: string; delivered: boolean; simulatedDevCode?: string }> {
    const jobId = randomUUID();
    const cleanEmail = job.recipientEmail.trim().toLowerCase();
    const isProduction = process.env.NODE_ENV === 'production';

    // Dev/test log output: never leak in production
    if (!isProduction) {
      console.log(`[AUTH-EMAIL] To: ${cleanEmail} | Template: ${job.templateType} | OTP Code: ${job.code ?? 'N/A'}`);
    }

    let status: 'sent' | 'failed' = 'sent';
    let lastError: string | null = null;
    const apiKey = process.env.RESEND_API_KEY?.trim();
    if (apiKey) {
      lastError = await this.sendWithResend(apiKey, cleanEmail, renderAuthEmail(job));
      if (lastError) status = 'failed';
    } else if (isProduction) {
      status = 'failed';
      lastError = 'RESEND_API_KEY is not set';
    }
    if (lastError) console.error(`[AUTH-EMAIL] ${job.templateType} not delivered: ${lastError}`);

    if (this.pool) {
      await this.pool.query(
        `INSERT INTO auth_mail_outbox (
          id, recipient_email, template_type, status, retry_count, last_error, sent_at
        ) VALUES ($1, $2, $3, $4, 0, $5, CASE WHEN $6::boolean THEN NOW() END)`,
        [jobId, cleanEmail, job.templateType, status, lastError, status === 'sent']
      );
    } else {
      this.inMemoryOutbox.push({
        id: jobId,
        recipient_email: cleanEmail,
        template_type: job.templateType,
        status,
        last_error: lastError,
        sent_at: status === 'sent' ? new Date().toISOString() : null,
      });
    }

    return {
      jobId,
      delivered: status === 'sent',
      simulatedDevCode: !isProduction ? job.code : undefined,
    };
  }

  /** Returns null on success, or a short error (never the code or the key). */
  private async sendWithResend(apiKey: string, to: string, email: RenderedAuthEmail): Promise<string | null> {
    try {
      const res = await this.fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.MAIL_FROM?.trim() || DEFAULT_FROM,
          to: [to],
          subject: email.subject,
          text: email.text,
          html: email.html,
        }),
      });
      if (res.ok) return null;
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      return `Resend HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
    } catch (err) {
      return `Resend request failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
