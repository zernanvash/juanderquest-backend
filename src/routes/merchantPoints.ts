import { Router, Response } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validateRequest } from '../middleware/validate.js';
import { env } from '../config/env.js';
import { MerchantPointsError, MerchantPointsService, MERCHANT_POINT_PACKAGES } from '../funding/merchantPoints.js';

export const merchantPointsRouter = Router();

const fundingService = (res: Response) => {
  if (!env.QUEST_FUNDING_ENABLED) {
    res.status(404).json({ success: false, error: { code: 'NOT_AVAILABLE', message: 'Funded quest features are unavailable.' } });
    return null;
  }
  const pool = getPool();
  if (!pool) {
    res.status(503).json({ success: false, error: { code: 'DATABASE_REQUIRED', message: 'Durable storage is required for merchant points.' } });
    return null;
  }
  return new MerchantPointsService(pool);
};

const sendError = (res: Response, error: unknown) => {
  if (error instanceof MerchantPointsError) {
    return res.status(error.status).json({
      success: false,
      error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
    });
  }
  console.error('[merchant-points] command failed:', error);
  return res.status(503).json({ success: false, error: { code: 'MERCHANT_POINTS_UNAVAILABLE', message: 'Merchant points are temporarily unavailable.' } });
};

const purchaseSchema = z.object({
  body: z.object({
    package: z.union([z.literal(500), z.literal(1000), z.literal(2500), z.literal(5000)]),
    idempotency_key: z.string().uuid(),
  }).strict(),
});

async function resolveOwnerMerchant(actorId: string, ownerOnly = true) {
  const pool = getPool();
  if (!pool) return null;
  const result = await pool.query(
    `SELECT m.id FROM merchants m
     JOIN merchant_memberships mm ON mm.merchant_id = m.id
     WHERE mm.user_id = $1 AND mm.role IN ('owner','staff') AND ($2::boolean=FALSE OR mm.role='owner') AND mm.status = 'active' AND m.status = 'active'
     ORDER BY mm.created_at, m.id LIMIT 1`,
    [actorId, ownerOnly]
  );
  return result.rows[0]?.id as string | undefined;
}

merchantPointsRouter.get('/merchant/points', authenticateToken, async (req: AuthRequest, res: Response) => {
  const service = fundingService(res);
  if (!service) return;
  try {
    const merchantId = await resolveOwnerMerchant(req.user!.id, false);
    if (!merchantId) return res.status(403).json({ success: false, error: { code: 'MERCHANT_OWNER_REQUIRED', message: 'An active merchant owner account is required.' } });
    const data = await service.getBalance(req.user!.id, merchantId, Number(req.query.limit ?? 20));
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ success: true, data: { ...data, simulated: true, notice: 'These are prototype points; no real payment or token transfer has occurred.' } });
  } catch (error) {
    return sendError(res, error);
  }
});

merchantPointsRouter.post(
  '/merchant/points/purchase',
  authenticateToken,
  rateLimit({ policyId: 'merchant:points-purchase', windowMs: 60_000, max: 20, keyStrategy: 'actor' }),
  validateRequest(purchaseSchema),
  async (req: AuthRequest, res: Response) => {
    const service = fundingService(res);
    if (!service) return;
    try {
      const merchantId = await resolveOwnerMerchant(req.user!.id);
      if (!merchantId) return res.status(403).json({ success: false, error: { code: 'MERCHANT_OWNER_REQUIRED', message: 'Only an active merchant owner may purchase points.' } });
      const data = await service.purchase(req.user!.id, merchantId, req.body.package, req.body.idempotency_key);
      return res.status(200).json({ success: true, data, notice: 'Simulated purchase — no real payment is taken in this prototype.' });
    } catch (error) {
      return sendError(res, error);
    }
  }
);

const adjustmentSchema = z.object({
  body: z.object({
    points: z.number().int().refine(value => value !== 0 && Number.isSafeInteger(value), 'Point adjustment must be a non-zero safe integer.'),
    reason: z.string().trim().min(10).max(500),
    idempotency_key: z.string().uuid(),
    reverses_credit_id: z.string().min(1).max(200).optional(),
  }).strict(),
});

merchantPointsRouter.post(
  '/admin/merchants/:id/points',
  authenticateToken,
  requireAdmin,
  rateLimit({ policyId: 'admin:merchant-points-adjustment', windowMs: 60_000, max: 10, keyStrategy: 'actor' }),
  validateRequest(adjustmentSchema),
  async (req: AuthRequest, res: Response) => {
    const service = fundingService(res);
    if (!service) return;
    try {
      const data = await service.adminAdjust(
        req.user!.id, req.params.id, req.body.points, req.body.reason,
        req.body.idempotency_key, req.body.reverses_credit_id
      );
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return sendError(res, error);
    }
  }
);

export { MERCHANT_POINT_PACKAGES };
