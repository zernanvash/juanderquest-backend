import { Router, Response } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import {
  authenticateToken,
  checkQAAuthorization,
  isAuthorizedQA,
  optionalAuthenticateToken,
  AuthRequest,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validateRequest } from '../middleware/validate.js';
import {
  VOUCHER_ICON_KEYS,
  WorkspaceError,
  addMerchantStaff,
  archiveMerchantVoucher,
  createMerchantVoucher,
  getCounterHistory,
  getMerchantAnalytics,
  listManageVouchers,
  listMerchantStaff,
  listPublicMerchants,
  revokeMerchantStaff,
  updateMerchantVoucher,
} from '../merchants/workspace.js';
import { log } from '../utils/logger.js';

/** Plan 110a — Merchant workspace bridges & public partner directory. */
export const merchantWorkspaceRouter = Router();

const writeLimiter = rateLimit({
  policyId: 'merchant:workspace-write',
  windowMs: 60_000,
  max: 20,
  keyStrategy: 'actor',
});

const createVoucherSchema = z.object({
  body: z
    .object({
      title: z.string().trim().min(3).max(120),
      description: z.string().trim().min(3).max(400),
      cost_points: z.number().int().min(1).max(100_000),
      stock_limit: z.number().int().min(1).max(100_000).nullable().optional(),
      valid_days: z.number().int().min(1).max(365).nullable().optional(),
      icon_key: z.enum(VOUCHER_ICON_KEYS).nullable().optional(),
    })
    .strict(),
});

const updateVoucherSchema = z.object({
  body: z
    .object({
      title: z.string().trim().min(3).max(120).optional(),
      description: z.string().trim().min(3).max(400).optional(),
      cost_points: z.number().int().min(1).max(100_000).optional(),
      stock_limit: z.number().int().min(1).max(100_000).nullable().optional(),
      valid_days: z.number().int().min(1).max(365).nullable().optional(),
      icon_key: z.enum(VOUCHER_ICON_KEYS).nullable().optional(),
      is_active: z.boolean().optional(),
    })
    .strict(),
});

const addStaffSchema = z.object({
  body: z.object({ email: z.string().trim().email().max(255) }).strict(),
});

const optionalNumber = (raw: unknown) => {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

const handle =
  (work: (req: AuthRequest, pool: NonNullable<ReturnType<typeof getPool>>) => Promise<unknown>, status = 200) =>
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_REQUIRED', message: 'Durable storage is required.' },
      });
    }
    try {
      const data = await work(req, pool);
      return res.status(status).json({ success: true, data });
    } catch (error) {
      if (error instanceof WorkspaceError) {
        return res.status(error.status).json({
          success: false,
          error: { code: error.code, message: error.message },
        });
      }
      log.error('[merchant-workspace] request failed:', { error });
      return res.status(503).json({
        success: false,
        error: { code: 'WORKSPACE_UNAVAILABLE', message: 'Merchant workspace is temporarily unavailable.' },
      });
    }
  };

// ---------- Merchant Voucher CRUD ----------

merchantWorkspaceRouter.get(
  '/merchant/vouchers/manage',
  authenticateToken,
  handle(async (req, pool) => listManageVouchers(pool, req.user!.id)),
);

merchantWorkspaceRouter.post(
  '/merchant/vouchers',
  authenticateToken,
  writeLimiter,
  validateRequest(createVoucherSchema),
  handle(async (req, pool) => createMerchantVoucher(pool, req.user!.id, req.body), 201),
);

merchantWorkspaceRouter.patch(
  '/merchant/vouchers/:id',
  authenticateToken,
  writeLimiter,
  validateRequest(updateVoucherSchema),
  handle(async (req, pool) => updateMerchantVoucher(pool, req.user!.id, String(req.params.id), req.body)),
);

merchantWorkspaceRouter.delete(
  '/merchant/vouchers/:id',
  authenticateToken,
  writeLimiter,
  handle(async (req, pool) => archiveMerchantVoucher(pool, req.user!.id, String(req.params.id))),
);

// ---------- Merchant Staff / Cashier Management ----------

merchantWorkspaceRouter.get(
  '/merchant/staff',
  authenticateToken,
  handle(async (req, pool) => listMerchantStaff(pool, req.user!.id)),
);

merchantWorkspaceRouter.post(
  '/merchant/staff',
  authenticateToken,
  writeLimiter,
  validateRequest(addStaffSchema),
  handle(async (req, pool) => addMerchantStaff(pool, req.user!.id, req.body.email), 201),
);

merchantWorkspaceRouter.delete(
  '/merchant/staff/:userId',
  authenticateToken,
  writeLimiter,
  handle(async (req, pool) => revokeMerchantStaff(pool, req.user!.id, String(req.params.userId))),
);

// ---------- Counter Scan History & ROI Analytics ----------

merchantWorkspaceRouter.get(
  '/merchant/counter/history',
  authenticateToken,
  handle(async (req, pool) => getCounterHistory(pool, req.user!.id, optionalNumber(req.query.limit))),
);

merchantWorkspaceRouter.get(
  '/merchant/analytics',
  authenticateToken,
  handle(async (req, pool) => getMerchantAnalytics(pool, req.user!.id, optionalNumber(req.query.days))),
);

// ---------- Public Partner Directory ----------

merchantWorkspaceRouter.get(
  '/merchants',
  optionalAuthenticateToken,
  checkQAAuthorization,
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_REQUIRED', message: 'Durable storage is required.' },
      });
    }
    const viewerIsTest = isAuthorizedQA(req);
    if (viewerIsTest) res.set('X-Robots-Tag', 'noindex, nofollow');
    try {
      const data = await listPublicMerchants(pool, {
        municipality: typeof req.query.municipality === 'string' ? req.query.municipality : undefined,
        category: typeof req.query.category === 'string' ? req.query.category : undefined,
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        lat: optionalNumber(req.query.lat),
        lng: optionalNumber(req.query.lng),
        page: optionalNumber(req.query.page),
        limit: optionalNumber(req.query.limit),
        isTest: viewerIsTest,
      });
      return res.json({ success: true, data });
    } catch (error) {
      log.error('[merchant-workspace] public directory failed:', { error });
      return res.status(503).json({
        success: false,
        error: { code: 'MERCHANTS_UNAVAILABLE', message: 'Partner directory is temporarily unavailable.' },
      });
    }
  },
);
