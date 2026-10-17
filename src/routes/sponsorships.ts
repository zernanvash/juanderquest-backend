import { Router, type Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { getPool } from '../db/pool.js';
import { authenticateToken, requireAdmin, type AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validateRequest } from '../middleware/validate.js';
import { FundingError } from '../funding/transaction.js';
import { SponsorshipService } from '../funding/sponsorships.js';
import { fundingErrorResponse } from './fundingPlans.js';

export const sponsorshipsRouter=Router();
const id=z.string().min(1).max(200);
const key=z.string().uuid();
const baseTerms=z.object({points:z.number().int().min(0).max(1_000_000_000),voucher_id:id.nullable().optional(),voucher_qty:z.number().int().min(0).max(100_000),promo:z.boolean(),message:z.string().max(500).nullable().optional()}).strict();

function service(res:Response){
  if(!env.QUEST_FUNDING_ENABLED){res.status(404).json({success:false,error:{code:'NOT_AVAILABLE',message:'Quest funding is unavailable.'}});return null;}
  const pool=getPool();
  if(!pool){res.status(503).json({success:false,error:{code:'DATABASE_REQUIRED',message:'Quest funding requires durable storage.'}});return null;}
  return new SponsorshipService(pool);
}

function mutation(path:string,schema:z.ZodTypeAny,action:(svc:SponsorshipService,req:AuthRequest)=>Promise<any>){
  sponsorshipsRouter.post(path,authenticateToken,rateLimit({policyId:'quest:sponsorship-command',windowMs:60_000,max:30,keyStrategy:'actor'}),validateRequest(z.object({body:schema})),async(req:AuthRequest,res:Response)=>{
    const svc=service(res);if(!svc)return;
    try{return res.status(200).json({success:true,data:await action(svc,req)});}catch(error){if(error instanceof FundingError)return res.status(error.status).json({success:false,error:{code:error.code,message:error.message}});return fundingErrorResponse(res,error);}
  });
}

sponsorshipsRouter.get('/sponsor-directory',authenticateToken,async(req:AuthRequest,res:Response)=>{
  const svc=service(res);if(!svc)return;
  try{const questId=String(req.query.quest_id??'');if(!questId)return res.status(400).json({success:false,error:{code:'VALIDATION_ERROR',message:'quest_id is required.'}});return res.json({success:true,data:await svc.directory(questId,req.user!.id,{q:String(req.query.q??''),page:Number(req.query.page??1)})});}catch(error){return fundingErrorResponse(res,error);}
});

mutation('/funding-plans/:id/sponsorships',z.object({merchant_id:id,...baseTerms.shape,idempotency_key:key}).strict(),(svc,req)=>svc.request(req.user!.id,req.params.id,req.body.merchant_id,req.body,req.body.idempotency_key));
mutation('/funding-plans/:id/merchant-top-up',z.object({points:z.number().int().positive().max(1_000_000_000),idempotency_key:key}).strict(),(svc,req)=>svc.topUp(req.user!.id,req.params.id,req.body.points,req.body.idempotency_key));
mutation('/sponsorships/:id/accept',z.object({terms_version:z.number().int().positive(),idempotency_key:key}).strict(),(svc,req)=>svc.accept(req.user!.id,req.params.id,req.body.terms_version,req.body.idempotency_key));
mutation('/sponsorships/:id/counter',z.object({...baseTerms.shape,terms_version:z.number().int().positive(),idempotency_key:key}).strict(),(svc,req)=>svc.counter(req.user!.id,req.params.id,req.body,req.body.terms_version,req.body.idempotency_key));
mutation('/sponsorships/:id/accept-counter',z.object({terms_version:z.number().int().positive(),idempotency_key:key}).strict(),(svc,req)=>svc.acceptCounter(req.user!.id,req.params.id,req.body.terms_version,req.body.idempotency_key));
mutation('/sponsorships/:id/decline',z.object({reason:z.string().max(500).optional(),idempotency_key:key}).strict(),(svc,req)=>svc.decide(req.user!.id,req.params.id,'decline',req.body.idempotency_key,req.body.reason));
mutation('/sponsorships/:id/withdraw',z.object({reason:z.string().max(500).optional(),idempotency_key:key}).strict(),(svc,req)=>svc.decide(req.user!.id,req.params.id,'withdraw',req.body.idempotency_key,req.body.reason));

sponsorshipsRouter.get('/merchant/sponsorships',authenticateToken,async(req:AuthRequest,res:Response)=>{
  const svc=service(res);if(!svc)return;
  try{return res.json({success:true,data:await svc.inbox(req.user!.id,req.query.status?String(req.query.status):undefined)});}catch(error){return fundingErrorResponse(res,error);}
});

sponsorshipsRouter.get('/admin/quest-funding',authenticateToken,requireAdmin,async(req:AuthRequest,res:Response)=>{
  const svc=service(res);if(!svc)return;
  try{const pool=getPool()!;const status=req.query.status?String(req.query.status):null;const result=await pool.query(
    `SELECT p.id,p.quest_id,p.round_number,p.mode,p.status,p.reward_points,p.fee_points,p.planned_completions,p.target_points,p.starts_at,p.ends_at,p.created_at,
       COALESCE((SELECT SUM(c.committed_points) FROM quest_funding_contributions c WHERE c.plan_id=p.id AND c.is_test=p.is_test),0)::bigint AS committed_points,
       COALESCE((SELECT COUNT(*) FROM quest_funding_holds h WHERE h.plan_id=p.id AND h.status='held'),0)::int AS live_holds,
       p.is_test FROM quest_funding_plans p WHERE ($1::text IS NULL OR p.status=$1) ORDER BY p.updated_at DESC LIMIT 200`,[status]);
    return res.json({success:true,data:{items:result.rows,simulated:true}});
  }catch(error){return fundingErrorResponse(res,error);}
});
