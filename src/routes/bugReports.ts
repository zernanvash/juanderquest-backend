import { randomBytes, randomUUID } from 'node:crypto';
import { Router, type Response } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { authenticateToken, optionalAuthenticateToken, requireAdmin, type AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { log } from '../utils/logger.js';

export const bugReportsRouter = Router();

const CATEGORIES = ['crash', 'auth', 'map', 'ar', 'quests', 'ui', 'other'] as const;
const STATUSES = ['open', 'triaged', 'resolved', 'wont_fix'] as const;

const createBugReportSchema = z.object({
  category: z.enum(CATEGORIES),
  summary: z.string().trim().min(5, 'Summary must be at least 5 characters.').max(120),
  description: z.string().trim().min(10, 'Description must be at least 10 characters.').max(2000),
  appVersion: z.string().trim().max(40).optional(),
  deviceInfo: z.string().trim().max(160).optional(),
  contactEmail: z
    .string()
    .trim()
    .max(160)
    .optional()
    .refine((v) => !v || z.string().email().safeParse(v).success, { message: 'Enter a valid email address.' }),
  pageUrl: z.string().trim().max(300).optional(),
  website: z.string().max(200).optional(), // Honeypot field
});

const patchBugReportSchema = z.object({
  status: z.enum(STATUSES),
});

interface MemoryBugReport {
  id: string;
  reference_code: string;
  user_id: string | null;
  category: (typeof CATEGORIES)[number];
  summary: string;
  description: string;
  app_version: string | null;
  device_info: string | null;
  contact_email: string | null;
  page_url: string | null;
  status: (typeof STATUSES)[number];
  created_at: string;
}

const memoryBugReports: MemoryBugReport[] = [];

function generateReferenceCode(): string {
  return `BUG-${randomBytes(3).toString('hex').toUpperCase()}`;
}

bugReportsRouter.post(
  '/bug-reports',
  optionalAuthenticateToken,
  rateLimit({ policyId: 'bug-reports:create', windowMs: 15 * 60_000, max: 5, keyStrategy: 'ip' }),
  async (req: AuthRequest, res: Response) => {
    const parsed = createBugReportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_BUG_REPORT',
          message: parsed.error.issues[0]?.message ?? 'Please check the bug report fields.',
        },
      });
    }

    const input = parsed.data;
    // Honeypot: pretend success without storing bot submissions.
    if (input.website && input.website.trim().length > 0) {
      return res.status(201).json({
        success: true,
        data: {
          referenceCode: 'BUG-000000',
          status: 'open',
          createdAt: new Date().toISOString(),
        },
      });
    }

    const referenceCode = generateReferenceCode();
    const userId = req.user?.id ?? null;
    const pool = getPool();

    if (!pool) {
      const now = new Date().toISOString();
      memoryBugReports.unshift({
        id: randomUUID(),
        reference_code: referenceCode,
        user_id: userId,
        category: input.category,
        summary: input.summary,
        description: input.description,
        app_version: input.appVersion || null,
        device_info: input.deviceInfo || null,
        contact_email: input.contactEmail || null,
        page_url: input.pageUrl || null,
        status: 'open',
        created_at: now,
      });
      return res.status(201).json({
        success: true,
        data: { referenceCode, status: 'open', createdAt: now },
      });
    }

    try {
      const inserted = await pool.query(
        `INSERT INTO bug_reports (
           reference_code, user_id, category, summary, description,
           app_version, device_info, contact_email, page_url
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING reference_code, status, created_at`,
        [
          referenceCode,
          userId,
          input.category,
          input.summary,
          input.description,
          input.appVersion || null,
          input.deviceInfo || null,
          input.contactEmail || null,
          input.pageUrl || null,
        ],
      );
      const row = inserted.rows[0];
      return res.status(201).json({
        success: true,
        data: {
          referenceCode: row.reference_code,
          status: row.status,
          createdAt: row.created_at,
        },
      });
    } catch (err) {
      log.error('[bugReports] failed to persist bug report', { error: err });
      return res.status(500).json({
        success: false,
        error: { code: 'BUG_REPORT_FAILED', message: 'Could not save bug report. Please try again.' },
      });
    }
  },
);

bugReportsRouter.get(
  '/admin/bug-reports',
  authenticateToken,
  requireAdmin,
  async (req: AuthRequest, res: Response) => {
    const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
    const statusFilter =
      statusParam && (STATUSES as readonly string[]).includes(statusParam) ? statusParam : undefined;
    const rawLimit = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 50;

    const pool = getPool();
    if (!pool) {
      const filtered = statusFilter
        ? memoryBugReports.filter((r) => r.status === statusFilter)
        : memoryBugReports;
      return res.json({ success: true, data: { items: filtered.slice(0, limit) } });
    }

    try {
      const rows = statusFilter
        ? await pool.query(
            `SELECT id, reference_code, user_id, category, summary, description,
                    app_version, device_info, contact_email, page_url, status, created_at
             FROM bug_reports
             WHERE status = $1
             ORDER BY created_at DESC
             LIMIT $2`,
            [statusFilter, limit],
          )
        : await pool.query(
            `SELECT id, reference_code, user_id, category, summary, description,
                    app_version, device_info, contact_email, page_url, status, created_at
             FROM bug_reports
             ORDER BY created_at DESC
             LIMIT $1`,
            [limit],
          );
      return res.json({ success: true, data: { items: rows.rows } });
    } catch (err) {
      log.error('[bugReports] failed to list bug reports', { error: err });
      return res.status(500).json({
        success: false,
        error: { code: 'BUG_REPORTS_UNAVAILABLE', message: 'Could not load bug reports.' },
      });
    }
  },
);

bugReportsRouter.patch(
  '/admin/bug-reports/:id',
  authenticateToken,
  requireAdmin,
  async (req: AuthRequest, res: Response) => {
    const parsed = patchBugReportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: 'Status must be open, triaged, resolved, or wont_fix.' },
      });
    }

    const pool = getPool();
    if (!pool) {
      const item = memoryBugReports.find((r) => r.id === req.params.id);
      if (!item) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Bug report not found.' },
        });
      }
      item.status = parsed.data.status;
      return res.json({ success: true, data: item });
    }

    try {
      const updated = await pool.query(
        `UPDATE bug_reports
         SET status = $1
         WHERE id::text = $2
         RETURNING id, reference_code, status, created_at`,
        [parsed.data.status, req.params.id],
      );
      if (!updated.rows.length) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Bug report not found.' },
        });
      }
      return res.json({ success: true, data: updated.rows[0] });
    } catch (err) {
      log.error('[bugReports] failed to update bug report status', { error: err });
      return res.status(500).json({
        success: false,
        error: { code: 'UPDATE_FAILED', message: 'Could not update bug report.' },
      });
    }
  },
);
