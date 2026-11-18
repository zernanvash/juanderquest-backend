import { Router, Response } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { authenticateToken, optionalAuthenticateToken, AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validateRequest } from '../middleware/validate.js';
import { assertInScope, requireAreaAdmin, writeAdminAudit } from '../admin/scope.js';
import { SukiError, SukiService, SUKI_REWARD_KINDS } from '../suki/service.js';
import { log } from '../utils/logger.js';

/** Plan 107 — Suki Card merchant loyalty cards. */
export const sukiRouter = Router();

const visitLimiter = rateLimit({ policyId: 'suki:visit', windowMs: 60_000, max: 6, keyStrategy: 'actor' });
const passLimiter = rateLimit({ policyId: 'suki:pass', windowMs: 60_000, max: 10, keyStrategy: 'actor' });
const pollLimiter = rateLimit({ policyId: 'suki:pass-status', windowMs: 60_000, max: 30, keyStrategy: 'actor' });
const scanLimiter = rateLimit({ policyId: 'suki:scan', windowMs: 60_000, max: 30, keyStrategy: 'actor' });
const writeLimiter = rateLimit({ policyId: 'suki:merchant-write', windowMs: 60_000, max: 20, keyStrategy: 'actor' });

const service = (res: Response) => {
  const pool = getPool();
  if (!pool) {
    res.status(503).json({
      success: false,
      error: { code: 'DATABASE_REQUIRED', message: 'Durable storage is required for Suki Cards.' },
    });
    return null;
  }
  return new SukiService(pool);
};

const sendError = (res: Response, error: unknown) => {
  if (error instanceof SukiError) {
    return res.status(error.status).json({
      success: false,
      error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
    });
  }
  log.error('[suki] command failed:', { error });
  return res
    .status(503)
    .json({ success: false, error: { code: 'SUKI_UNAVAILABLE', message: 'Suki Cards are temporarily unavailable.' } });
};

type Handler = (req: AuthRequest, svc: SukiService) => Promise<unknown>;
const handle =
  (work: Handler, status = 200) =>
  async (req: AuthRequest, res: Response) => {
    const svc = service(res);
    if (!svc) return;
    try {
      const data = await work(req, svc);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(status).json({ success: true, data });
    } catch (error) {
      return sendError(res, error);
    }
  };

const finite = z.number().finite();
const visitSchema = z.object({
  body: z
    .object({
      standee: z.string().min(10).max(400),
      lat: finite.min(-90).max(90),
      lng: finite.min(-180).max(180),
      accuracy_m: finite.min(0).max(10_000),
      idempotency_key: z.string().min(8).max(100),
    })
    .strict(),
});
const passSchema = z.object({ body: z.object({ program_id: z.string().min(3).max(80) }).strict() });
const programSchema = z.object({
  body: z
    .object({
      title: z.string().trim().min(3).max(60),
      reward_kind: z.enum(SUKI_REWARD_KINDS),
      reward_value: z.number().int().nullable().optional(),
      reward_text: z.string().trim().min(3).max(120),
      visits_required: z.number().int().min(3).max(20).optional(),
      mode: z.enum(['standee', 'staff_scan']).optional(),
      radius_m: z.number().int().min(30).max(200).optional(),
    })
    .strict(),
});
const locationSchema = z.object({
  body: z
    .object({ lat: finite.min(-90).max(90), lng: finite.min(-180).max(180), accuracy_m: finite.min(0).max(10_000) })
    .strict(),
});
const scanSchema = z.object({ body: z.object({ code: z.string().trim().min(4).max(2000) }).strict() });
const pauseSchema = z.object({ body: z.object({ reason: z.string().trim().min(3).max(300) }).strict() });

const optionalNumber = (raw: unknown) => {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

// ---------- customer ----------

sukiRouter.get(
  '/me/suki-cards',
  authenticateToken,
  handle((req, svc) => svc.listMyCards(req.user!.id)),
);

sukiRouter.get(
  '/me/redemptions',
  authenticateToken,
  handle((req, svc) => svc.listMyRedemptions(req.user!.id)),
);

sukiRouter.get(
  '/suki/programs',
  authenticateToken,
  handle(async (req, svc) => {
    await svc.requireEnabled();
    return svc.listPrograms({
      userId: req.user!.id,
      lat: optionalNumber(req.query.lat),
      lng: optionalNumber(req.query.lng),
      limit: optionalNumber(req.query.limit),
    });
  }),
);

sukiRouter.get(
  '/suki/programs/:id',
  optionalAuthenticateToken,
  handle(async (req, svc) => {
    await svc.requireEnabled();
    return svc.getProgram(String(req.params.id), req.user?.id);
  }),
);

sukiRouter.post(
  '/suki/visits',
  authenticateToken,
  visitLimiter,
  validateRequest(visitSchema),
  handle((req, svc) => svc.recordStandeeVisit(req.user!.id, req.body), 201),
);

sukiRouter.post(
  '/suki/pass',
  authenticateToken,
  passLimiter,
  validateRequest(passSchema),
  handle((req, svc) => svc.issuePass(req.user!.id, req.body.program_id)),
);

sukiRouter.get(
  '/suki/pass/status',
  authenticateToken,
  pollLimiter,
  handle(async (req, svc) => {
    await svc.requireEnabled();
    return svc.passStatus(req.user!.id, String(req.query.program_id ?? ''));
  }),
);

// ---------- merchant ----------

sukiRouter.get(
  '/merchant/suki',
  authenticateToken,
  handle(async (req, svc) => {
    await svc.requireEnabled();
    return svc.merchantView(req.user!.id);
  }),
);

sukiRouter.put(
  '/merchant/suki',
  authenticateToken,
  writeLimiter,
  validateRequest(programSchema),
  handle((req, svc) => svc.upsertProgram(req.user!.id, req.body)),
);

sukiRouter.put(
  '/merchant/suki/location',
  authenticateToken,
  writeLimiter,
  validateRequest(locationSchema),
  handle((req, svc) => svc.setLocation(req.user!.id, req.body)),
);

sukiRouter.post(
  '/merchant/suki/activate',
  authenticateToken,
  writeLimiter,
  handle((req, svc) => svc.activate(req.user!.id)),
);

sukiRouter.post(
  '/merchant/suki/pause',
  authenticateToken,
  writeLimiter,
  handle(async (req, svc) => {
    await svc.requireEnabled();
    return svc.pause(req.user!.id);
  }),
);

sukiRouter.get(
  '/merchant/suki/standee',
  authenticateToken,
  handle(async (req, svc) => {
    await svc.requireEnabled();
    return svc.standee(req.user!.id);
  }),
);

sukiRouter.post(
  '/merchant/suki/standee/rotate',
  authenticateToken,
  writeLimiter,
  handle((req, svc) => svc.rotateStandee(req.user!.id)),
);

sukiRouter.post(
  '/merchant/suki/scan',
  authenticateToken,
  scanLimiter,
  validateRequest(scanSchema),
  handle((req, svc) => svc.scan(req.user!.id, req.body.code)),
);

sukiRouter.get(
  '/merchant/suki/stats',
  authenticateToken,
  handle(async (req, svc) => {
    await svc.requireEnabled();
    return svc.stats(req.user!.id, optionalNumber(req.query.days) ?? 30);
  }),
);

// ---------- admin (area-scoped: merchants_vouchers) ----------

const adminGuard = [authenticateToken, requireAreaAdmin('merchants_vouchers')];

sukiRouter.get(
  '/admin/suki/programs',
  ...adminGuard,
  handle((req, svc) =>
    svc.adminPrograms(req.adminScope!, typeof req.query.status === 'string' ? req.query.status : undefined),
  ),
);

sukiRouter.get(
  '/admin/suki/towns',
  ...adminGuard,
  handle((req, svc) => svc.adminTowns(req.adminScope!, optionalNumber(req.query.weeks) ?? 8)),
);

const setPaused = (paused: boolean) =>
  handle(async (req, svc) => {
    const before = await svc.adminProgramArea(String(req.params.id));
    if (!assertInScope(req.adminScope!, 'merchants_vouchers', before.town_area_id))
      throw new SukiError('SUKI_NOT_FOUND', 404, 'This Suki Card was not found.');
    const reason = paused ? String(req.body.reason) : null;
    await svc.adminSetPaused(before.id, paused, reason);
    const after = await svc.adminProgramArea(before.id);
    await writeAdminAudit({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      areaId: before.town_area_id,
      action: paused ? 'suki.pause' : 'suki.resume',
      subjectType: 'suki_program',
      subjectId: before.id,
      before,
      after,
    });
    return after;
  });

sukiRouter.post(
  '/admin/suki/programs/:id/pause',
  ...adminGuard,
  writeLimiter,
  validateRequest(pauseSchema),
  setPaused(true),
);
sukiRouter.post('/admin/suki/programs/:id/resume', ...adminGuard, writeLimiter, setPaused(false));
