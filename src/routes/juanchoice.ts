import { Router, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { getPool } from '../db/pool.js';
import { authenticateToken, optionalAuthenticateToken, requireAdmin, checkQAAuthorization, isAuthorizedQA, AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { addCandidate, castBallot, cancelCampaign, claimSupporterQuest, finalizeCampaign, getPublicSpotlight, getStandings, getSupporterQuest, JuanChoiceError, moderateCandidate, publishCampaign } from '../juanchoice/service.js';
import { createMerchantOffer, createPromotionBudget, listActiveMerchantOffers } from '../juanchoice/partnerships.js';

export const juanChoiceRouter = Router();
const uuid = z.string().uuid();
const ballotBody = z.object({ candidate_id: uuid, expected_version: z.number().int().min(0) }).strict();
const campaignBody = z.object({
  slug: z.string().min(3).max(100).regex(/^[a-z0-9-]+$/),
  region: z.string().min(2).max(100), theme: z.string().min(2).max(120),
  opens_at: z.string().datetime({ offset: true }), closes_at: z.string().datetime({ offset: true }),
  is_test: z.boolean().default(false),
  series_key: z.string().min(3).max(80).regex(/^[a-z0-9-]+$/).nullable().optional(),
  round_number: z.number().int().positive().nullable().optional(),
  counts_for_streak: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  if (value.counts_for_streak && (value.series_key !== 'pangasinan-primary' || !value.round_number)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Official streak rounds require pangasinan-primary and a round number.' });
  }
  if (!value.counts_for_streak && (value.series_key != null || value.round_number != null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Series identity is reserved for official streak rounds.' });
  }
});
const candidateBody = z.object({ spot_id: z.string().min(1).max(150) }).strict();
const merchantOfferBody = z.object({ merchant_id: z.string().min(1).max(150), voucher_id: z.string().min(1).max(150),
  terms_snapshot: z.record(z.string(), z.unknown()).default({}), starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }), is_test: z.boolean().default(false), partner_consent: z.literal(true) }).strict();
const promotionBudgetBody = z.object({ budget_mjdq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  approval_reference: z.string().trim().min(3).max(200), is_test: z.boolean().default(false) }).strict();

function failure(res: Response, error: unknown) {
  if (error instanceof JuanChoiceError) return res.status(error.status).json({ success: false, error: { code: error.code, message: error.message } });
  console.error('[JUANCHOICE]', error);
  return res.status(503).json({ success: false, error: { code: 'DATABASE_OUTAGE', message: 'JuanChoice is temporarily unavailable.' } });
}
function pool() {
  const result = getPool();
  if (!result) throw new JuanChoiceError('DATABASE_OUTAGE', 503);
  return result;
}
juanChoiceRouter.use('/juanchoice', (_req, res, next) => {
  if (!env.JUANCHOICE_ENABLED) return res.status(503).json({ success: false, error: { code: 'FEATURE_DISABLED' } });
  next();
});
juanChoiceRouter.use('/juanchoice/admin', (_req, res, next) => {
  if (_req.method !== 'GET' && !env.JUANCHOICE_WRITES_ENABLED) return res.status(503).json({ success: false, error: { code: 'WRITES_DISABLED' } });
  next();
});

juanChoiceRouter.get('/juanchoice/spotlight', async (_req, res) => {
  if (!env.JUANCHOICE_PROMOTION_ENABLED) return res.json({ success: true, data: null });
  try {
    res.set('Cache-Control', 'public, max-age=60');
    return res.json({ success: true, data: await getPublicSpotlight() });
  } catch (error) { return failure(res, error); }
});

juanChoiceRouter.get('/juanchoice/supporter-quest', optionalAuthenticateToken, checkQAAuthorization, async (req: AuthRequest,res) => {
  try {
    res.set('Cache-Control',req.user ? 'private, no-store' : 'public, max-age=60');
    return res.json({success:true,data:await getSupporterQuest(req.user?.id,isAuthorizedQA(req))});
  } catch(error){return failure(res,error);}
});

juanChoiceRouter.post('/juanchoice/supporter-quest/:campaignId/claim',authenticateToken,
  rateLimit({policyId:'juanchoice:supporter-claim',windowMs:60_000,max:10,keyStrategy:'actor'}),
  async(req:AuthRequest,res)=>{
    const id=uuid.safeParse(req.params.campaignId);
    if(!id.success)return res.status(400).json({success:false,error:{code:'INVALID_ID'}});
    try{return res.json({success:true,data:await claimSupporterQuest(id.data,req.user!.id)});}
    catch(error){return failure(res,error);}
  });

juanChoiceRouter.get('/juanchoice/admin/campaigns', authenticateToken, requireAdmin, async (_req: AuthRequest, res) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    const campaigns = (await pool().query(
      `SELECT c.*, COALESCE(n.candidate_count,0) AS candidate_count, COALESCE(b.ballot_count,0) AS ballot_count
       FROM juanchoice_campaigns c
       LEFT JOIN (SELECT campaign_id,COUNT(*)::int AS candidate_count FROM juanchoice_candidates GROUP BY campaign_id) n ON n.campaign_id=c.id
       LEFT JOIN (SELECT campaign_id,COUNT(*)::int AS ballot_count FROM juanchoice_ballots GROUP BY campaign_id) b ON b.campaign_id=c.id
       ORDER BY c.created_at DESC,c.id DESC LIMIT 50`
    )).rows;
    return res.json({success:true,data:{items:campaigns}});
  } catch (error) { return failure(res,error); }
});

juanChoiceRouter.get('/juanchoice/admin/campaigns/:id', authenticateToken, requireAdmin, async (req: AuthRequest,res) => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({success:false,error:{code:'INVALID_ID'}});
  try {
    res.set('Cache-Control','private, no-store');
    res.set('X-Robots-Tag','noindex, nofollow');
    const campaign = (await pool().query('SELECT * FROM juanchoice_campaigns WHERE id=$1',[id.data])).rows[0];
    if (!campaign) throw new JuanChoiceError('CAMPAIGN_NOT_FOUND',404);
    const [candidates, counts, audit, result] = await Promise.all([
      pool().query(`SELECT n.*,s.name AS spot_name,s.municipality,s.status AS spot_status,s.crowd_capacity_band,s.recommendation_suppressed
                    FROM juanchoice_candidates n JOIN spots s ON s.id=n.spot_id WHERE n.campaign_id=$1 ORDER BY n.created_at,n.id`,[id.data]),
      pool().query('SELECT candidate_id,COUNT(*)::int AS votes FROM juanchoice_ballots WHERE campaign_id=$1 GROUP BY candidate_id',[id.data]),
      pool().query('SELECT action,reason,actor_id,created_at FROM juanchoice_campaign_audit WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT 30',[id.data]),
      pool().query('SELECT * FROM juanchoice_results WHERE campaign_id=$1',[id.data]),
    ]);
    const countByCandidate=new Map(counts.rows.map(row=>[row.candidate_id,Number(row.votes)]));
    const ballotCount=counts.rows.reduce((sum,row)=>sum+Number(row.votes),0);
    return res.json({success:true,data:{campaign:{...campaign,ballot_count:ballotCount},candidates:candidates.rows.map(row=>({...row,votes:countByCandidate.get(row.id)??0})),audit:audit.rows,result:result.rows[0]??null}});
  } catch (error) { return failure(res,error); }
});

juanChoiceRouter.get('/juanchoice/campaigns', optionalAuthenticateToken, checkQAAuthorization, async (req: AuthRequest, res) => {
  try {
    const region = typeof req.query.region === 'string' ? req.query.region : null;
    const rows = (await pool().query(
      `SELECT id,slug,region,theme,status,opens_at,closes_at,policy_version FROM juanchoice_campaigns
       WHERE status <> 'draft' AND status <> 'cancelled' AND ($1::text IS NULL OR region = $1)
       AND ($2::boolean OR is_test = FALSE) ORDER BY opens_at DESC LIMIT 30`,
      [region, isAuthorizedQA(req)]
    )).rows;
    return res.json({ success: true, data: { items: rows } });
  } catch (error) { return failure(res, error); }
});

juanChoiceRouter.get('/juanchoice/campaigns/:id', optionalAuthenticateToken, checkQAAuthorization, async (req: AuthRequest, res) => {
  if (!uuid.safeParse(req.params.id).success) return res.status(400).json({ success: false, error: { code: 'INVALID_ID' } });
  try { return res.json({ success: true, data: await getStandings(String(req.params.id), isAuthorizedQA(req)) }); }
  catch (error) { return failure(res, error); }
});
juanChoiceRouter.get('/juanchoice/campaigns/:id/standings', optionalAuthenticateToken, checkQAAuthorization, async (req: AuthRequest, res) => {
  if (!uuid.safeParse(req.params.id).success) return res.status(400).json({ success: false, error: { code: 'INVALID_ID' } });
  try { return res.json({ success: true, data: await getStandings(String(req.params.id), isAuthorizedQA(req)) }); }
  catch (error) { return failure(res, error); }
});
juanChoiceRouter.get('/juanchoice/campaigns/:id/offers', optionalAuthenticateToken, checkQAAuthorization, async (req: AuthRequest, res) => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ success: false, error: { code: 'INVALID_ID' } });
  try {
    res.set('Cache-Control', 'public, max-age=60');
    const offers = await listActiveMerchantOffers(id.data, isAuthorizedQA(req));
    return res.json({ success: true, data: { items: offers, total: offers.length } });
  } catch (error) { return failure(res, error); }
});

juanChoiceRouter.get('/juanchoice/campaigns/:id/me', authenticateToken, async (req: AuthRequest, res) => {
  res.set('Cache-Control', 'private, no-store');
  if (!uuid.safeParse(req.params.id).success) return res.status(400).json({ success: false, error: { code: 'INVALID_ID' } });
  try {
    const campaignId = String(req.params.id);
    const actor = (await pool().query('SELECT is_test FROM users WHERE id = $1', [req.user!.id])).rows[0];
    const campaign = (await pool().query('SELECT is_test,status FROM juanchoice_campaigns WHERE id = $1', [campaignId])).rows[0];
    if (!actor || !campaign || actor.is_test !== campaign.is_test || campaign.status === 'draft') throw new JuanChoiceError('CAMPAIGN_NOT_FOUND', 404);
    const ballot = (await pool().query('SELECT candidate_id,version FROM juanchoice_ballots WHERE campaign_id = $1 AND user_id = $2', [campaignId, req.user!.id])).rows[0] ?? null;
    return res.json({ success: true, data: { ballot } });
  } catch (error) { return failure(res, error); }
});

juanChoiceRouter.put('/juanchoice/campaigns/:id/ballot', authenticateToken,
  rateLimit({ policyId: 'juanchoice:ballot', windowMs: 60_000, max: 20, keyStrategy: 'actor' }),
  async (req: AuthRequest, res) => {
    const body = ballotBody.safeParse(req.body);
    const key = uuid.safeParse(req.header('Idempotency-Key'));
    const id = uuid.safeParse(req.params.id);
    if (!body.success || !key.success || !id.success) return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST' } });
    try {
      const result = await castBallot({ campaignId: id.data, userId: req.user!.id, candidateId: body.data.candidate_id,
        expectedVersion: body.data.expected_version, idempotencyKey: key.data });
      res.set('Cache-Control', 'private, no-store');
      return res.json({ success: true, data: result });
    } catch (error) { return failure(res, error); }
  });

juanChoiceRouter.post('/juanchoice/admin/campaigns', authenticateToken, requireAdmin, async (req: AuthRequest, res) => {
  const parsed = campaignBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST' } });
  const data = parsed.data;
  if (new Date(data.closes_at) <= new Date(data.opens_at)) return res.status(400).json({ success: false, error: { code: 'INVALID_WINDOW' } });
  try {
    const id = randomUUID();
    const row = (await pool().query(
      `INSERT INTO juanchoice_campaigns(
         id,slug,region,theme,opens_at,closes_at,is_test,series_key,round_number,counts_for_streak)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id,data.slug,data.region,data.theme,data.opens_at,data.closes_at,data.is_test,
        data.series_key ?? null,data.round_number ?? null,data.counts_for_streak]
    )).rows[0];
    return res.status(201).json({ success: true, data: row });
  } catch (error: any) {
    if (error?.code === '23505') return res.status(409).json({ success: false, error: { code: 'CAMPAIGN_EXISTS' } });
    return failure(res, error);
  }
});
juanChoiceRouter.post('/juanchoice/admin/campaigns/:id/candidates', authenticateToken, requireAdmin, async (req: AuthRequest, res) => {
  const id = uuid.safeParse(req.params.id); const parsed = candidateBody.safeParse(req.body);
  if (!id.success || !parsed.success) return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST' } });
  try {
    return res.status(201).json({ success: true, data: await addCandidate(id.data,parsed.data.spot_id) });
  } catch (error: any) {
    if (error?.code === '23505') return res.status(409).json({ success: false, error: { code: 'CANDIDATE_EXISTS' } });
    return failure(res,error);
  }
});
juanChoiceRouter.post('/juanchoice/admin/campaigns/:id/offers', authenticateToken, requireAdmin, async (req: AuthRequest, res) => {
  const id = uuid.safeParse(req.params.id); const parsed = merchantOfferBody.safeParse(req.body);
  if (!id.success || !parsed.success) return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST' } });
  try {
    const data = parsed.data;
    return res.status(201).json({ success: true, data: await createMerchantOffer({ campaignId: id.data,
      merchantId: data.merchant_id, voucherId: data.voucher_id, termsSnapshot: data.terms_snapshot,
      startsAt: data.starts_at, endsAt: data.ends_at, isTest: data.is_test }) });
  } catch (error) { return failure(res, error); }
});
juanChoiceRouter.post('/juanchoice/admin/campaigns/:id/budget', authenticateToken, requireAdmin, async (req: AuthRequest, res) => {
  if (!env.JUANCHOICE_ECONOMY_ENABLED) return res.status(503).json({ success: false, error: { code: 'ECONOMY_DISABLED' } });
  const id = uuid.safeParse(req.params.id); const parsed = promotionBudgetBody.safeParse(req.body);
  if (!id.success || !parsed.success) return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST' } });
  try { return res.status(201).json({ success: true, data: await createPromotionBudget({ campaignId: id.data,
    budgetMjdq: parsed.data.budget_mjdq, approvalReference: parsed.data.approval_reference, isTest: parsed.data.is_test }) }); }
  catch (error) { return failure(res, error); }
});

juanChoiceRouter.patch('/juanchoice/admin/campaigns/:id/candidates/:candidateId', authenticateToken, requireAdmin, async(req:AuthRequest,res)=>{
  const id=uuid.safeParse(req.params.id), candidateId=uuid.safeParse(req.params.candidateId);
  const body=z.object({status:z.enum(['eligible','suspended']),reason:z.string().trim().min(10).max(500)}).strict().safeParse(req.body);
  if(!id.success||!candidateId.success||!body.success)return res.status(400).json({success:false,error:{code:'INVALID_REQUEST'}});
  try{return res.json({success:true,data:await moderateCandidate(id.data,candidateId.data,body.data.status,req.user!.id,body.data.reason)});}
  catch(error){return failure(res,error);}
});
juanChoiceRouter.post('/juanchoice/admin/campaigns/:id/publish', authenticateToken, requireAdmin, async (req: AuthRequest, res) => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ success: false, error: { code: 'INVALID_ID' } });
  try {
    return res.json({ success: true, data: await publishCampaign(id.data,req.user!.id) });
  } catch (error) { return failure(res,error); }
});
juanChoiceRouter.post('/juanchoice/admin/campaigns/:id/cancel', authenticateToken, requireAdmin, async (req: AuthRequest,res) => {
  const id = uuid.safeParse(req.params.id);
  const reason = z.object({reason:z.string().trim().min(10).max(500)}).strict().safeParse(req.body);
  if (!id.success || !reason.success) return res.status(400).json({ success:false,error:{code:'INVALID_REQUEST'} });
  try { return res.json({success:true,data:await cancelCampaign(id.data,req.user!.id,reason.data.reason)}); }
  catch (error) { return failure(res,error); }
});
juanChoiceRouter.post('/juanchoice/admin/campaigns/:id/finalize', authenticateToken, requireAdmin, async (req: AuthRequest, res) => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ success: false, error: { code: 'INVALID_ID' } });
  try { return res.json({ success: true, data: await finalizeCampaign(id.data,req.user!.id) }); }
  catch (error) { return failure(res,error); }
});
