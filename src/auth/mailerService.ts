import type { Pool } from 'pg';
import { randomUUID } from 'crypto';

export interface AuthMailJob {
  id: string;
  recipientEmail: string;
  templateType: 'signup_otp' | 'password_reset_otp' | 'password_changed_alert';
  code?: string;
}

export class AuthMailerService {
  private inMemoryOutbox: any[] = [];

  constructor(private pool: Pool | null) {}

  setPool(pool: Pool | null) {
    this.pool = pool;
  }

  /**
   * Enqueues or dispatches an authentication email (with local dev logger fallback).
   */
  async queueAuthEmail(job: AuthMailJob): Promise<{ jobId: string; simulatedDevCode?: string }> {
    const jobId = randomUUID();
    const cleanEmail = job.recipientEmail.trim().toLowerCase();

    // Dev/test log output: never leak in production
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[AUTH-EMAIL] To: ${cleanEmail} | Template: ${job.templateType} | OTP Code: ${job.code ?? 'N/A'}`);
    }

    if (this.pool) {
      await this.pool.query(
        `INSERT INTO auth_mail_outbox (
          id, recipient_email, template_type, status, retry_count, sent_at
        ) VALUES ($1, $2, $3, 'sent', 0, NOW())`,
        [jobId, cleanEmail, job.templateType]
      );
    } else {
      this.inMemoryOutbox.push({
        id: jobId,
        recipient_email: cleanEmail,
        template_type: job.templateType,
        status: 'sent',
        sent_at: new Date().toISOString(),
      });
    }

    return {
      jobId,
      simulatedDevCode: process.env.NODE_ENV !== 'production' ? job.code : undefined,
    };
  }
}
