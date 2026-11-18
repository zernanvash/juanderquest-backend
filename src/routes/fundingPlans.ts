import { Router, type Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { getPool } from '../db/pool.js';
import { authenticateToken, requireAdmin, type AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validateRequest } from '../middleware/validate.js';
import { FundingPlansService } from '../funding/plans.js';
import {
  getPlanTransactions,
  getPlanTreasury,
  getMerchantFundingDetail,
  listMerchantFunding,
  releaseStuckHold,
  setMerchantSponsoringSuspended,
  setPlanFlagged,
  setPlanHoldsPaused,
} from '../funding/adminOversight.js';
import { writeAdminAudit } from '../admin/scope.js';
import { FundingError } from '../funding/transaction.js';
import { abandonFundedAttempt } from '../funding/holds.js';
import { log } from '../utils/logger.js';

export const fundingPlansRouter = Router();
const key = z.string().uuid();
const terms = z.object({
  mode: z.enum(['budget', 'window']),
  planned_completions: z.number().int().min(1).max(10_000),
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }),
});

export function fundingErrorResponse(res: Response, error: unknown) {
  if (error instanceof FundingError)
    return res.status(error.status).json({
      success: false,
      error: { code: error.code, message: error.message },
      ...(error.data !== undefined ? { data: error.data } : {}),
    });
  if ((error as any)?.code === '23505')
    return res.status(409).json({
      success: false,
      error: {
        code: 'FUNDING_PLAN_EXISTS',
        message: 'A conflicting funding operation has already completed. Refresh to continue.',
      },
    });
  log.error('[funding] command failed:', { error: error });
  return res.status(503).json({
    success: false,
    error: { code: 'QUEST_FUNDING_UNAVAILABLE', message: 'Quest funding is temporarily unavailable.' },
  });
}

function service(res: Response, allowWhenDisabled = false) {
  if (!allowWhenDisabled && !env.QUEST_FUNDING_ENABLED) {
    res
      .status(404)
      .json({ success: false, error: { code: 'NOT_AVAILABLE', message: 'Quest funding is unavailable.' } });
    return null;
  }
  const pool = getPool();
  if (!pool) {
    res.status(503).json({
      success: false,
      error: { code: 'DATABASE_REQUIRED', message: 'Quest funding requires durable storage.' },
    });
    return null;
  }
  return new FundingPlansService(pool);
}

function mutation(
  path: string,
  schema: z.ZodTypeAny,
  action: (svc: FundingPlansService, req: AuthRequest) => Promise<any>,
  admin = false,
  patch = false,
) {
  const handler = async (req: AuthRequest, res: Response) => {
    const svc = service(res, admin);
    if (!svc) return;
    try {
      return res.status(200).json({ success: true, data: await action(svc, req) });
    } catch (error) {
      return fundingErrorResponse(res, error);
    }
  };
  const middleware = [
    authenticateToken,
    ...(admin ? [requireAdmin] : []),
    rateLimit({ policyId: 'quest:funding-command', windowMs: 60_000, max: 60, keyStrategy: 'actor' }),
    validateRequest(z.object({ body: schema })),
    handler,
  ];
  if (patch) fundingPlansRouter.patch(path, ...middleware);
  else fundingPlansRouter.post(path, ...middleware);
}

mutation('/quests/:id/funding-plans', terms.extend({ idempotency_key: key }).strict(), (svc, req) =>
  svc.create(req.user!.id, req.params.id, req.body, req.body.idempotency_key),
);
mutation(
  '/funding-plans/:id',
  terms.extend({ expected_version: z.number().int().positive(), idempotency_key: key }).strict(),
  (svc, req) => svc.update(req.user!.id, req.params.id, req.body, req.body.idempotency_key),
  false,
  true,
);
mutation(
  '/funding-plans/:id/self-contribution',
  z.object({ points: z.number().int().positive().max(1_000_000_000), idempotency_key: key }).strict(),
  (svc, req) => svc.contribute(req.user!.id, req.params.id, req.body.points, req.body.idempotency_key),
);
for (const action of ['submit', 'cancel', 'close'] as const)
  mutation(`/funding-plans/:id/${action}`, z.object({ idempotency_key: key }).strict(), (svc, req) =>
    svc[action](req.user!.id, req.params.id, req.body.idempotency_key),
  );
mutation(
  '/funding-plans/:id/extend',
  z.object({ ends_at: z.string().datetime({ offset: true }), idempotency_key: key }).strict(),
  (svc, req) => svc.extend(req.user!.id, req.params.id, req.body.ends_at, req.body.idempotency_key),
);
mutation(
  '/admin/funding-plans/:id/close',
  z.object({ idempotency_key: key }).strict(),
  (svc, req) => svc.close(req.user!.id, req.params.id, req.body.idempotency_key, true),
  true,
);
mutation('/quests/:id/attempts/:attemptId/abandon', z.object({ idempotency_key: key }).strict(), (svc, req) =>
  abandonFundedAttempt(svc.pool, req.params.id, req.params.attemptId, req.user!.id, req.body.idempotency_key),
);

for (const admin of [false, true])
  fundingPlansRouter.get(
    `${admin ? '/admin' : ''}/funding-plans/:id`,
    authenticateToken,
    ...(admin ? [requireAdmin] : []),
    async (req: AuthRequest, res: Response) => {
      const svc = service(res, admin);
      if (!svc) return;
      try {
        res.setHeader('Cache-Control', 'private, no-store');
        return res.json({
          success: true,
          data: await svc.get(req.user!.id, req.params.id, admin, admin && req.user?.role === 'admin'),
        });
      } catch (error) {
        return fundingErrorResponse(res, error);
      }
    },
  );

fundingPlansRouter.get(
  '/admin/funding-plans/:id/treasury',
  authenticateToken,
  requireAdmin,
  async (req: AuthRequest, res: Response) => {
    const svc = service(res, true);
    if (!svc) return;
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json({ success: true, data: await getPlanTreasury(svc.pool, req.params.id) });
    } catch (error) {
      return fundingErrorResponse(res, error);
    }
  },
);

fundingPlansRouter.get(
  '/admin/funding-plans/:id/transactions',
  authenticateToken,
  requireAdmin,
  async (req: AuthRequest, res: Response) => {
    const svc = service(res, true);
    if (!svc) return;
    try {
      const type = typeof req.query.type === 'string' && req.query.type.trim() ? req.query.type.trim() : null;
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json({ success: true, data: await getPlanTransactions(svc.pool, req.params.id, type) });
    } catch (error) {
      return fundingErrorResponse(res, error);
    }
  },
);

mutation(
  '/admin/funding-plans/:id/extend',
  z
    .object({
      ends_at: z.string().datetime({ offset: true }),
      reason: z.string().trim().max(500).optional(),
      idempotency_key: key,
    })
    .strict(),
  async (svc, req) => {
    const updated = await svc.extend(req.user!.id, req.params.id, req.body.ends_at, req.body.idempotency_key, true);
    await writeAdminAudit({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      action: 'funding_plan.extended',
      subjectType: 'quest_funding_plan',
      subjectId: req.params.id,
      after: { ends_at: req.body.ends_at, reason: req.body.reason ?? null },
    }).catch(() => undefined);
    return updated;
  },
  true,
);

mutation(
  '/admin/funding-plans/:id/cancel',
  z.object({ reason: z.string().trim().max(500).optional(), idempotency_key: key }).strict(),
  async (svc, req) => {
    const cancelled = await svc.cancel(req.user!.id, req.params.id, req.body.idempotency_key, true);
    await writeAdminAudit({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      action: 'funding_plan.cancelled',
      subjectType: 'quest_funding_plan',
      subjectId: req.params.id,
      after: { status: cancelled.status, reason: req.body.reason ?? null },
    }).catch(() => undefined);
    return cancelled;
  },
  true,
);

mutation(
  '/admin/funding-plans/:id/pause-holds',
  z.object({ reason: z.string().trim().min(5).max(500), idempotency_key: key }).strict(),
  (svc, req) =>
    setPlanHoldsPaused(
      svc.pool,
      { id: req.user!.id, role: req.user!.role },
      req.params.id,
      true,
      req.body.reason,
      req.body.idempotency_key,
    ),
  true,
);

mutation(
  '/admin/funding-plans/:id/resume-holds',
  z.object({ reason: z.string().trim().max(500).optional(), idempotency_key: key }).strict(),
  (svc, req) =>
    setPlanHoldsPaused(
      svc.pool,
      { id: req.user!.id, role: req.user!.role },
      req.params.id,
      false,
      req.body.reason,
      req.body.idempotency_key,
    ),
  true,
);

mutation(
  '/admin/funding-plans/:id/flag',
  z
    .object({
      flagged: z.boolean().default(true),
      note: z.string().trim().min(5).max(500),
      idempotency_key: key,
    })
    .strict(),
  (svc, req) =>
    setPlanFlagged(
      svc.pool,
      { id: req.user!.id, role: req.user!.role },
      req.params.id,
      req.body.flagged,
      req.body.note,
      req.body.idempotency_key,
    ),
  true,
);

mutation(
  '/admin/funding-holds/:id/release',
  z.object({ reason: z.string().trim().max(500).optional(), idempotency_key: key }).strict(),
  (svc, req) =>
    releaseStuckHold(
      svc.pool,
      { id: req.user!.id, role: req.user!.role },
      req.params.id,
      req.body.reason,
      req.body.idempotency_key,
    ),
  true,
);

fundingPlansRouter.get(
  '/admin/merchant-funding',
  authenticateToken,
  requireAdmin,
  async (req: AuthRequest, res: Response) => {
    const svc = service(res, true);
    if (!svc) return;
    try {
      const includeTest = req.query.include_test === 'true';
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json({
        success: true,
        data: { items: await listMerchantFunding(svc.pool, includeTest), simulated: true },
      });
    } catch (error) {
      return fundingErrorResponse(res, error);
    }
  },
);

fundingPlansRouter.get(
  '/admin/merchant-funding/:merchantId',
  authenticateToken,
  requireAdmin,
  async (req: AuthRequest, res: Response) => {
    const svc = service(res, true);
    if (!svc) return;
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json({ success: true, data: await getMerchantFundingDetail(svc.pool, req.params.merchantId) });
    } catch (error) {
      return fundingErrorResponse(res, error);
    }
  },
);

mutation(
  '/admin/merchants/:id/sponsoring/suspend',
  z.object({ reason: z.string().trim().min(5).max(500), idempotency_key: key }).strict(),
  (svc, req) =>
    setMerchantSponsoringSuspended(
      svc.pool,
      { id: req.user!.id, role: req.user!.role },
      req.params.id,
      true,
      req.body.reason,
      req.body.idempotency_key,
    ),
  true,
);

mutation(
  '/admin/merchants/:id/sponsoring/resume',
  z.object({ reason: z.string().trim().max(500).optional(), idempotency_key: key }).strict(),
  (svc, req) =>
    setMerchantSponsoringSuspended(
      svc.pool,
      { id: req.user!.id, role: req.user!.role },
      req.params.id,
      false,
      req.body.reason,
      req.body.idempotency_key,
    ),
  true,
);

fundingPlansRouter.get('/quests/:id/funding-plan', authenticateToken, async (req: AuthRequest, res: Response) => {
  const svc = service(res);
  if (!svc) return;
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ success: true, data: await svc.latestForQuest(req.user!.id, req.params.id) });
  } catch (error) {
    return fundingErrorResponse(res, error);
  }
});
