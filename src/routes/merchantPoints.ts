import { Router, Response } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validateRequest } from '../middleware/validate.js';
import { env } from '../config/env.js';
import { MerchantPointsError, MerchantPointsService, MERCHANT_POINT_PACKAGES } from '../funding/merchantPoints.js';
import { reconcileFunding } from '../funding/reconcile.js';

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

merchantPointsRouter.get('/merchant/vouchers', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!env.QUEST_FUNDING_ENABLED) {
    return res.status(404).json({ success: false, error: { code: 'NOT_AVAILABLE', message: 'Funded quest features are unavailable.' } });
  }
  const pool = getPool();
  if (!pool) {
    return res.status(503).json({ success: false, error: { code: 'DATABASE_REQUIRED', message: 'Durable storage is required for merchant vouchers.' } });
  }
  try {
    const merchantId = await resolveOwnerMerchant(req.user!.id, false);
    if (!merchantId) {
      return res.status(403).json({ success: false, error: { code: 'MERCHANT_OWNER_REQUIRED', message: 'An active merchant membership is required.' } });
    }
    // This read validates membership and matching test/real scope.
    await new MerchantPointsService(pool).getBalance(req.user!.id, merchantId, 1);
    const result = await pool.query(
      `SELECT v.id,v.title,v.description,v.cost_points
         FROM vouchers v JOIN merchants m ON m.id=v.merchant_id
        WHERE v.merchant_id=$1 AND m.status='active' AND m.is_published=TRUE AND v.is_active=TRUE
        ORDER BY v.title,v.id`,
      [merchantId]
    );
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ success: true, data: { merchant_id: merchantId, items: result.rows } });
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

merchantPointsRouter.get('/admin/merchant-point-credits',authenticateToken,requireAdmin,async(req:AuthRequest,res:Response)=>{
  const service=fundingService(res);if(!service)return;
  const pool=getPool()!;
  const merchantId=typeof req.query.merchant_id==='string'?req.query.merchant_id:null;
  const source=typeof req.query.source==='string'?req.query.source:null;
  const allowed=['simulated_purchase','admin_grant','voucher_income','admin_correction'];
  if(source&&!allowed.includes(source))return res.status(400).json({success:false,error:{code:'INVALID_SOURCE',message:'Unsupported merchant point source.'}});
  const limit=Math.max(1,Math.min(200,Number.parseInt(String(req.query.limit??50),10)||50));
  try{
    const result=await pool.query(
      `SELECT c.*,m.name AS merchant_name,
         CASE WHEN c.points > 0 THEN GREATEST(c.points - COALESCE((
           SELECT SUM(-reversal.points) FROM merchant_point_credits reversal
           WHERE reversal.reverses_credit_id = c.id AND reversal.merchant_id = c.merchant_id
         ),0),0)::bigint ELSE 0::bigint END AS reversible_points
       FROM merchant_point_credits c JOIN merchants m ON m.id=c.merchant_id
       WHERE ($1::text IS NULL OR c.merchant_id=$1) AND ($2::text IS NULL OR c.source=$2)
       ORDER BY c.created_at DESC,c.id LIMIT $3`,[merchantId,source,limit]);
    res.setHeader('Cache-Control','private, no-store');
    return res.json({success:true,data:{items:result.rows,simulated:true}});
  }catch(error){return sendError(res,error);}
});

merchantPointsRouter.get('/admin/treasury',authenticateToken,requireAdmin,async(_req:AuthRequest,res:Response)=>{
  const service=fundingService(res);if(!service)return;
  try{
    const pool=getPool()!;
    const [accounts,reconciliation]=await Promise.all([
      pool.query("SELECT id,kind,balance_points,is_test FROM points_accounts WHERE kind='treasury' ORDER BY is_test,id"),
      reconcileFunding(pool),
    ]);
    res.setHeader('Cache-Control','private, no-store');
    return res.json({success:true,data:{accounts:accounts.rows,reconciliation,simulated:true}});
  }catch(error){return sendError(res,error);}
});

export { MERCHANT_POINT_PACKAGES };
