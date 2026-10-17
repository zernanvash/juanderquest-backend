import { Router, type Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { getPool } from '../db/pool.js';
import { authenticateToken, requireAdmin, type AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validateRequest } from '../middleware/validate.js';
import { FundingPlansService } from '../funding/plans.js';
import { FundingError } from '../funding/transaction.js';
import { abandonFundedAttempt } from '../funding/holds.js';

export const fundingPlansRouter = Router();
const key = z.string().uuid();
const terms = z.object({ mode: z.enum(['budget','window']), planned_completions: z.number().int().min(1).max(10_000),
  starts_at: z.string().datetime({ offset: true }), ends_at: z.string().datetime({ offset: true }) });

export function fundingErrorResponse(res: Response, error: unknown) {
  if (error instanceof FundingError) return res.status(error.status).json({ success: false, error: { code: error.code, message: error.message } });
  if ((error as any)?.code === '23505') return res.status(409).json({ success: false, error: { code: 'FUNDING_PLAN_EXISTS', message: 'A conflicting funding operation has already completed. Refresh to continue.' } });
  console.error('[funding] command failed:', error);
  return res.status(503).json({ success: false, error: { code: 'QUEST_FUNDING_UNAVAILABLE', message: 'Quest funding is temporarily unavailable.' } });
}

function service(res: Response) {
  if (!env.QUEST_FUNDING_ENABLED) { res.status(404).json({ success: false, error: { code: 'NOT_AVAILABLE', message: 'Quest funding is unavailable.' } }); return null; }
  const pool = getPool();
  if (!pool) { res.status(503).json({ success: false, error: { code: 'DATABASE_REQUIRED', message: 'Quest funding requires durable storage.' } }); return null; }
  return new FundingPlansService(pool);
}

function mutation(path: string, schema: z.ZodTypeAny, action: (svc: FundingPlansService, req: AuthRequest) => Promise<any>, admin = false, patch = false) {
  const handler = async (req: AuthRequest, res: Response) => {
    const svc = service(res); if (!svc) return;
    try { return res.status(200).json({ success: true, data: await action(svc, req) }); }
    catch (error) { return fundingErrorResponse(res, error); }
  };
  const middleware = [authenticateToken, ...(admin ? [requireAdmin] : []),
    rateLimit({ policyId: 'quest:funding-command', windowMs: 60_000, max: 60, keyStrategy: 'actor' }),
    validateRequest(z.object({ body: schema })), handler];
  if (patch) fundingPlansRouter.patch(path, ...middleware); else fundingPlansRouter.post(path, ...middleware);
}

mutation('/quests/:id/funding-plans', terms.extend({ idempotency_key: key }).strict(), (svc, req) => svc.create(req.user!.id, req.params.id, req.body, req.body.idempotency_key));
mutation('/funding-plans/:id', terms.extend({ expected_version: z.number().int().positive(), idempotency_key: key }).strict(),
  (svc, req) => svc.update(req.user!.id, req.params.id, req.body, req.body.idempotency_key), false, true);
mutation('/funding-plans/:id/self-contribution', z.object({ points: z.number().int().positive().max(1_000_000_000), idempotency_key: key }).strict(),
  (svc, req) => svc.contribute(req.user!.id, req.params.id, req.body.points, req.body.idempotency_key));
for (const action of ['submit','cancel','close'] as const) mutation(`/funding-plans/:id/${action}`, z.object({ idempotency_key: key }).strict(),
  (svc, req) => svc[action](req.user!.id, req.params.id, req.body.idempotency_key));
mutation('/funding-plans/:id/extend', z.object({ ends_at: z.string().datetime({ offset: true }), idempotency_key: key }).strict(),
  (svc, req) => svc.extend(req.user!.id, req.params.id, req.body.ends_at, req.body.idempotency_key));
mutation('/admin/funding-plans/:id/close', z.object({ idempotency_key: key }).strict(),
  (svc, req) => svc.close(req.user!.id, req.params.id, req.body.idempotency_key, true), true);
mutation('/quests/:id/attempts/:attemptId/abandon',z.object({idempotency_key:key}).strict(),
  (svc,req)=>abandonFundedAttempt(svc.pool,req.params.id,req.params.attemptId,req.user!.id,req.body.idempotency_key));

for (const admin of [false, true]) fundingPlansRouter.get(`${admin ? '/admin' : ''}/funding-plans/:id`, authenticateToken,
  ...(admin ? [requireAdmin] : []), async (req: AuthRequest, res: Response) => {
    const svc = service(res); if (!svc) return;
    try { res.setHeader('Cache-Control', 'private, no-store'); return res.json({ success: true, data: await svc.get(req.user!.id, req.params.id, admin) }); }
    catch (error) { return fundingErrorResponse(res, error); }
  });

fundingPlansRouter.get('/quests/:id/funding-plan',authenticateToken,async(req:AuthRequest,res:Response)=>{
  const svc=service(res);if(!svc)return;
  try{res.setHeader('Cache-Control','private, no-store');return res.json({success:true,data:await svc.latestForQuest(req.user!.id,req.params.id)});}
  catch(error){return fundingErrorResponse(res,error);}
});
