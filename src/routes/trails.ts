import { Router, type Response } from 'express';
import { z } from 'zod';
import { authenticateToken, optionalAuthenticateToken, requireAdmin, type AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { getPool } from '../db/pool.js';
import { refreshTravelTimeMatrix, readTravelTimeMatrixStatus } from '../trails/matrix.js';
import { generateTrail, TrailGenerationError, windowsFromBestTime } from '../trails/generate.js';
import { computeSpotSignals, loadTrailSignalInputs } from '../trails/signals.js';
import { loadTravelTimeLookup } from '../trails/matrix.js';
import { solveLocal } from '../trails/solver/local.js';
import { createCuoptSolver, cuoptEnabledWithKey, CuoptError } from '../trails/solver/cuopt.js';
import { randomUUID } from 'node:crypto';
import type { TrailCosting, TrailProblem } from '../trails/types.js';
import { checkinTrailStop, TrailProgressError, unlockTrail } from '../trails/progress.js';
import { createPersonalTrail, PersonalTrailError } from '../trails/personal.js';
import { loadTrailEconomy } from '../trails/economy.js';

export const trailsRouter = Router();
// Every endpoint in this router is operational/admin-only, including reads.
trailsRouter.use('/admin/trails', authenticateToken, requireAdmin);

const unlockRateLimiter = rateLimit({ policyId: 'trails:unlock', windowMs: 60_000, max: 10, keyStrategy: 'actor' });
const checkinRateLimiter = rateLimit({ policyId: 'trails:checkin', windowMs: 60_000, max: 6, keyStrategy: 'actor' });
const personalTrailRateLimiter = rateLimit({ policyId: 'trails:personal', windowMs: 60 * 60_000, max: 3, keyStrategy: 'actor' });

function sendTrailProgressError(res: Response, error: unknown) {
  if (error instanceof TrailProgressError) return res.status(error.status).json({ success:false,error:{code:error.code,message:error.message} });
  return res.status(503).json({ success:false,error:{code:'TRAIL_PROGRESS_UNAVAILABLE',message:'Trail progress could not be saved. Please try again.'} });
}

function lockedTrailShape(row: any, unlocked: boolean) {
  return { id:row.id,slug:row.slug,title:row.title,tagline:row.tagline,tier:row.tier,theme:row.theme,
    municipalities:row.municipalities,stop_count:Number(row.stop_count ?? 0),total_minutes:Number(row.total_minutes),
    total_km:Number(row.total_km),unlock_rule:typeof row.unlock_rule==='string'?JSON.parse(row.unlock_rule):row.unlock_rule,
    available_until:row.available_until,rarity_art_key:row.tier,is_unlocked:unlocked };
}

trailsRouter.get('/trails', optionalAuthenticateToken, async (req: AuthRequest, res: Response) => {
  const pool=getPool();
  if(!pool)return res.status(503).json({success:false,error:{code:'DATABASE_UNAVAILABLE',message:'Trail catalog is unavailable.'}});
  try {
    const user=req.user ? (await pool.query('SELECT id,is_test FROM users WHERE id=$1',[req.user.id])).rows[0] : null;
    const isTest=Boolean(user?.is_test);
    const {rows}=await pool.query(`SELECT t.id,t.slug,t.title,t.tagline,t.tier,t.theme,t.municipalities,t.unlock_rule,t.total_minutes,t.total_km,
        t.available_until,t.owner_user_id,t.is_test,
        (SELECT COUNT(*)::int FROM trail_stops s WHERE s.trail_id=t.id) AS stop_count,
        (t.owner_user_id=$2 OR EXISTS(SELECT 1 FROM trail_unlocks u WHERE u.trail_id=t.id AND u.user_id=$2)) AS is_unlocked
      FROM trails t WHERE t.status='published' AND t.is_test=$1 AND (t.owner_user_id IS NULL OR t.owner_user_id=$2)
      ORDER BY CASE t.tier WHEN 'starter' THEN 1 WHEN 'explorer' THEN 2 WHEN 'signature' THEN 3 WHEN 'legendary' THEN 4 ELSE 5 END,t.title`,[isTest,user?.id??null]);
    let personalGeneration: { free_remaining:number; price_points:number } | null = null;
    if (user) {
      const economy = await loadTrailEconomy(pool);
      if (economy.personalGenerationEnabled) {
        const used = await pool.query(`SELECT COUNT(*)::int AS count FROM trail_generations WHERE kind='personal' AND requested_by=$1
          AND created_at >= (date_trunc('week', clock_timestamp() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila')`, [user.id]);
        personalGeneration = { free_remaining: Math.max(0,economy.personalFreePerWeek-Number(used.rows[0]?.count??0)), price_points:economy.personalGenerationPoints };
      }
    }
    res.set('Cache-Control',req.user?'private, no-store':'public, max-age=60');
    return res.json({success:true,data:{items:rows.map(row=>lockedTrailShape(row,Boolean(row.is_unlocked))),total:rows.length,personal_generation:personalGeneration}});
  } catch { return res.status(503).json({success:false,error:{code:'TRAILS_UNAVAILABLE',message:'Trail catalog is unavailable.'}}); }
});

// Trails for a destination's side panel: published trails with a stop near the point, those
// passing through the selected spot first. Stops stay private; only a cover photo is shared.
const nearSchema = z.object({
  lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180),
  radius_km: z.coerce.number().min(1).max(60).default(30), spot_id: z.string().max(120).optional(),
});
trailsRouter.get('/trails/near', optionalAuthenticateToken, async (req: AuthRequest, res: Response) => {
  const parsed = nearSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ success:false,error:{code:'VALIDATION_ERROR',message:'Valid lat and lng are required.'} });
  const pool=getPool();
  if(!pool)return res.status(503).json({success:false,error:{code:'DATABASE_UNAVAILABLE',message:'Trail catalog is unavailable.'}});
  const { lat, lng, radius_km, spot_id } = parsed.data;
  try {
    const user=req.user ? (await pool.query('SELECT id,is_test FROM users WHERE id=$1',[req.user.id])).rows[0] : null;
    const isTest=Boolean(user?.is_test);
    const {rows}=await pool.query(`WITH near AS (
        SELECT s.trail_id,
          MIN(6371*2*ASIN(SQRT(POWER(SIN(RADIANS(p.gps_lat-$1)/2),2)+COS(RADIANS($1))*COS(RADIANS(p.gps_lat))*POWER(SIN(RADIANS(p.gps_lng-$2)/2),2)))) AS nearest_km,
          BOOL_OR(s.spot_id=$4) AS passes_here
        FROM trail_stops s JOIN spots p ON p.id=s.spot_id GROUP BY s.trail_id)
      SELECT t.id,t.slug,t.title,t.tagline,t.tier,t.theme,t.municipalities,t.unlock_rule,t.total_minutes,t.total_km,t.available_until,
        (SELECT COUNT(*)::int FROM trail_stops s WHERE s.trail_id=t.id) AS stop_count,
        (SELECT p.image_url FROM trail_stops s JOIN spots p ON p.id=s.spot_id WHERE s.trail_id=t.id AND COALESCE(p.image_url,'')<>'' ORDER BY s.position LIMIT 1) AS cover_image_url,
        (t.owner_user_id=$5 OR EXISTS(SELECT 1 FROM trail_unlocks u WHERE u.trail_id=t.id AND u.user_id=$5)) AS is_unlocked,
        near.nearest_km, near.passes_here
      FROM trails t JOIN near ON near.trail_id=t.id
      WHERE t.status='published' AND t.is_test=$6 AND t.owner_user_id IS NULL AND near.nearest_km <= $3
        AND (t.available_until IS NULL OR t.available_until > now())
      ORDER BY near.passes_here DESC, near.nearest_km, CASE t.tier WHEN 'starter' THEN 1 WHEN 'explorer' THEN 2 WHEN 'signature' THEN 3 ELSE 4 END
      LIMIT 12`,[lat,lng,radius_km,spot_id??null,user?.id??null,isTest]);
    res.set('Cache-Control',req.user?'private, no-store':'public, max-age=60');
    return res.json({success:true,data:{items:rows.map(row=>({...lockedTrailShape(row,Boolean(row.is_unlocked)),
      cover_image_url:row.cover_image_url||null,passes_here:Boolean(row.passes_here),nearest_km:Math.round(Number(row.nearest_km)*10)/10}))}});
  } catch { return res.status(503).json({success:false,error:{code:'TRAILS_UNAVAILABLE',message:'Trail catalog is unavailable.'}}); }
});

trailsRouter.get('/trails/:id', optionalAuthenticateToken, async (req: AuthRequest, res: Response) => {
  const pool=getPool();
  if(!pool)return res.status(503).json({success:false,error:{code:'DATABASE_UNAVAILABLE',message:'Trail details are unavailable.'}});
  try {
    const user=req.user ? (await pool.query('SELECT id,is_test FROM users WHERE id=$1',[req.user.id])).rows[0] : null;
    const isTest=Boolean(user?.is_test);
    const selected=await pool.query(`SELECT t.*,(SELECT COUNT(*)::int FROM trail_stops s WHERE s.trail_id=t.id) AS stop_count,
        (t.owner_user_id=$2 OR EXISTS(SELECT 1 FROM trail_unlocks u WHERE u.trail_id=t.id AND u.user_id=$2)) AS is_unlocked
      FROM trails t WHERE t.id=$1 AND t.status='published' AND t.is_test=$3 AND (t.owner_user_id IS NULL OR t.owner_user_id=$2)`,
      [req.params.id,user?.id??null,isTest]);
    const trail=selected.rows[0];
    if(!trail)return res.status(404).json({success:false,error:{code:'TRAIL_NOT_FOUND',message:'Trail was not found.'}});
    res.set('Cache-Control',req.user?'private, no-store':'public, max-age=60');
    if(!trail.is_unlocked){
      // What the trail offers, so a traveler can decide: names, photos and one line per stop.
      // The order, map, coordinates and narration stay private until it is unlocked.
      const preview=await pool.query(`SELECT p.name,p.municipality,p.category,COALESCE(p.image_url,'') AS image_url,p.description
        FROM trail_stops s JOIN spots p ON p.id=s.spot_id WHERE s.trail_id=$1 ORDER BY p.name`,[trail.id]);
      return res.json({success:true,data:{...lockedTrailShape(trail,false),intro:typeof trail.story?.intro==='string'?trail.story.intro:'',
        preview:preview.rows.map((row:any)=>({name:row.name,municipality:row.municipality,category:row.category,image_url:row.image_url||null,
          blurb:String(row.description||'').split(/(?<=[.!?])s/)[0].slice(0,160)}))}});
    }
    const stops=await pool.query(`SELECT s.position,s.spot_id,s.arrive_offset_min,s.dwell_min,s.leg_minutes,s.leg_km,s.narration,s.checkin_radius_m,
        p.name,p.municipality,p.category,p.gps_lat,p.gps_lng
      FROM trail_stops s JOIN spots p ON p.id=s.spot_id WHERE s.trail_id=$1 ORDER BY s.position`,[trail.id]);
    const checkins=user ? await pool.query('SELECT position,verified_at,distance_m,accuracy_m FROM trail_checkins WHERE trail_id=$1 AND user_id=$2',[trail.id,user.id]) : {rows:[]};
    const checkinByPosition=new Map(checkins.rows.map((row:any)=>[Number(row.position),row]));
    return res.json({success:true,data:{...trail,stops:stops.rows.map((stop:any)=>({
      position:Number(stop.position),spot_id:stop.spot_id,arrive_offset_min:Number(stop.arrive_offset_min),dwell_min:Number(stop.dwell_min),
      leg_minutes:Number(stop.leg_minutes),leg_km:Number(stop.leg_km),narration:stop.narration,checkin_radius_m:Number(stop.checkin_radius_m),
      name:stop.name,municipality:stop.municipality,category:stop.category,lat:Number(stop.gps_lat),lng:Number(stop.gps_lng),
      checked_in:checkinByPosition.has(Number(stop.position)),...(checkinByPosition.get(Number(stop.position))??{})
    }))}});
  } catch { return res.status(503).json({success:false,error:{code:'TRAILS_UNAVAILABLE',message:'Trail details are unavailable.'}}); }
});

const personalTrailSchema = z.object({
  text: z.string().trim().max(300).optional(),
  themes: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  good_for: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  municipalities: z.array(z.string().trim().min(1).max(100)).max(12).optional(),
  budget_min: z.number().int().min(120).max(600).optional(),
  pace: z.enum(['relaxed','balanced','packed']).optional(),
  start: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict().optional(),
}).strict().refine(value => Boolean(value.text || value.themes?.length || value.good_for?.length || value.municipalities?.length), {
  message: 'Describe the trip or choose at least one preference.',
});

trailsRouter.post('/trails/personal', authenticateToken, personalTrailRateLimiter, async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ success:false,error:{code:'DATABASE_UNAVAILABLE',message:'Personal trail generation is unavailable.'} });
  try {
    const economy = await loadTrailEconomy(pool);
    if (!economy.personalGenerationEnabled) return res.status(404).json({ success:false,error:{code:'PERSONAL_TRAILS_DISABLED',message:'Traveler-created trails are currently unavailable.'} });
  } catch {
    return res.status(503).json({success:false,error:{code:'TRAILS_UNAVAILABLE',message:'Trail settings are unavailable.'}});
  }
  const parsed = personalTrailSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ success:false,error:{code:'VALIDATION_ERROR',message:parsed.error.issues[0]?.message ?? 'Invalid personal trail request.'} });
  try {
    const result = await createPersonalTrail(pool, req.user!.id, req.header('Idempotency-Key') ?? '', parsed.data);
    return res.status(201).json({ success:true,data:result });
  } catch (error) {
    if (error instanceof PersonalTrailError) return res.status(error.status).json({success:false,error:{code:error.code,message:error.message}});
    if (error instanceof TrailGenerationError) return res.status(422).json({success:false,error:{code:error.code,message:error.message}});
    return res.status(503).json({success:false,error:{code:'PERSONAL_TRAIL_FAILED',message:'Personal trail could not be created; any points charge was rolled back.'}});
  }
});

trailsRouter.post('/trails/:id/unlock', authenticateToken, unlockRateLimiter, async (req: AuthRequest, res: Response) => {
  const pool=getPool();
  if(!pool)return res.status(503).json({success:false,error:{code:'DATABASE_UNAVAILABLE',message:'Trail unlock is unavailable.'}});
  const key=req.header('Idempotency-Key');
  if(!key || key.length<8 || key.length>200)return res.status(400).json({success:false,error:{code:'IDEMPOTENCY_KEY_REQUIRED',message:'A valid Idempotency-Key header is required.'}});
  try { return res.json({success:true,data:await unlockTrail(pool,req.user!.id,req.params.id,key)}); }
  catch(error){return sendTrailProgressError(res,error);}
});

const checkinSchema=z.object({lat:z.number().min(-90).max(90),lng:z.number().min(-180).max(180),accuracy_m:z.number().finite().nonnegative()}).strict();
trailsRouter.post('/trails/:id/stops/:position/checkin', authenticateToken, checkinRateLimiter, async (req: AuthRequest, res: Response) => {
  const parsed=checkinSchema.safeParse(req.body??{});
  const position=Number(req.params.position);
  if(!parsed.success || !Number.isInteger(position) || position<1)return res.status(400).json({success:false,error:{code:'VALIDATION_ERROR',message:'Provide a positive stop position and valid location with accuracy_m at most 100.'}});
  const pool=getPool();
  if(!pool)return res.status(503).json({success:false,error:{code:'DATABASE_UNAVAILABLE',message:'Trail check-in is unavailable.'}});
  try { return res.json({success:true,data:await checkinTrailStop(pool,req.user!.id,req.params.id,position,parsed.data)}); }
  catch(error){return sendTrailProgressError(res,error);}
});

trailsRouter.get('/admin/trails/matrix/status', async (_req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'Trail storage is unavailable.' } });
  try { return res.json({ success: true, data: await readTravelTimeMatrixStatus(pool) }); }
  catch { return res.status(503).json({ success: false, error: { code: 'MATRIX_UNAVAILABLE', message: 'Travel matrix status is unavailable.' } }); }
});

trailsRouter.get('/admin/trails/areas', async (_req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'Trail areas are unavailable.' } });
  try {
    const { rows } = await pool.query(`
      WITH RECURSIVE area_scope(root_id,id,name,level,path) AS (
        SELECT id,id,name,level,ARRAY[id]::text[] FROM admin_areas
        UNION ALL
        SELECT scope.root_id,child.id,child.name,child.level,scope.path||child.id
        FROM admin_areas child JOIN area_scope scope ON child.parent_id=scope.id
        WHERE NOT child.id=ANY(scope.path)
      )
      SELECT root.id,root.level,root.name,root.display_name,root.parent_id,COUNT(DISTINCT s.id)::int AS published_spot_count
      FROM admin_areas root
      JOIN area_scope scope ON scope.root_id=root.id
      LEFT JOIN spots s ON s.status='published' AND COALESCE(s.is_test,FALSE)=FALSE AND s.gps_lat IS NOT NULL AND s.gps_lng IS NOT NULL
        AND (s.town_area_id=scope.id OR (s.town_area_id IS NULL AND scope.level='town' AND lower(s.municipality)=lower(scope.name)))
      WHERE root.level IN ('region','province','town')
      GROUP BY root.id,root.level,root.name,root.display_name,root.parent_id
      HAVING COUNT(DISTINCT s.id)>0
      ORDER BY CASE root.level WHEN 'region' THEN 0 WHEN 'province' THEN 1 ELSE 2 END,root.display_name
    `);
    return res.json({ success: true, data: rows });
  } catch { return res.status(503).json({ success: false, error: { code: 'TRAIL_AREAS_UNAVAILABLE', message: 'Trail areas are unavailable.' } }); }
});

trailsRouter.post('/admin/trails/matrix/refresh', async (req: AuthRequest, res: Response) => {
  const costing = String(req.body?.costing ?? 'auto');
  if (!['auto','pedestrian','bicycle','motorcycle'].includes(costing)) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Unsupported routing costing.' } });
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'Trail storage is unavailable.' } });
  try { return res.json({ success: true, data: await refreshTravelTimeMatrix(pool, costing as TrailCosting) }); }
  catch { return res.status(503).json({ success: false, error: { code: 'MATRIX_REFRESH_FAILED', message: 'Travel matrix refresh did not complete.' } }); }
});

trailsRouter.get('/admin/trails', async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'Trail storage is unavailable.' } });
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  try {
    const { rows } = await pool.query(`SELECT t.*, g.solver_ms, g.objective, g.solver FROM trails t LEFT JOIN trail_generations g ON g.id=t.generation_id
      WHERE ($1::text IS NULL OR t.status=$1) AND t.source='engine' ORDER BY t.created_at DESC LIMIT 100`, [status ?? null]);
    return res.json({ success: true, data: rows });
  } catch { return res.status(503).json({ success: false, error: { code: 'TRAILS_UNAVAILABLE', message: 'Trails are unavailable.' } }); }
});

trailsRouter.get('/admin/trails/generations', async (_req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ success:false,error:{code:'DATABASE_UNAVAILABLE',message:'Trail generation history is unavailable.'} });
  try {
    const { rows } = await pool.query(`SELECT id,kind,requested_by,input,constraints,solver,solver_ms,objective,result,ai_model,ai_used,ai_fallback_reason,created_at
      FROM trail_generations ORDER BY created_at DESC LIMIT 100`);
    return res.json({success:true,data:rows});
  } catch { return res.status(503).json({success:false,error:{code:'TRAIL_GENERATIONS_UNAVAILABLE',message:'Trail generation history is unavailable.'}}); }
});

trailsRouter.get('/admin/trails/review', async (_req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'Trail storage is unavailable.' } });
  try {
    const { rows } = await pool.query(`SELECT t.*, g.solver_ms, g.objective, g.solver, g.ai_model, g.ai_used, g.ai_fallback_reason,
      COALESCE((SELECT json_agg(json_build_object('position',s.position,'spot_id',s.spot_id,'name',p.name,'municipality',p.municipality,
        'lat',p.gps_lat,'lng',p.gps_lng,'narration',s.narration,'leg_minutes',s.leg_minutes,'leg_km',s.leg_km,
        'approximate',CASE WHEN s.position=1 THEN FALSE ELSE COALESCE(m.approximate,TRUE) END) ORDER BY s.position)
        FROM trail_stops s JOIN spots p ON p.id=s.spot_id
        LEFT JOIN trail_stops previous ON previous.trail_id=s.trail_id AND previous.position=s.position-1
        LEFT JOIN travel_time_matrix m ON m.costing=t.costing AND m.from_spot=previous.spot_id AND m.to_spot=s.spot_id
        WHERE s.trail_id=t.id),'[]'::json) AS stops
      FROM trails t LEFT JOIN trail_generations g ON g.id=t.generation_id
      WHERE t.source='engine' AND t.status='pending_review' ORDER BY t.created_at ASC LIMIT 100`);
    return res.json({ success: true, data: rows });
  } catch { return res.status(503).json({ success: false, error: { code: 'TRAIL_REVIEW_UNAVAILABLE', message: 'Trail review queue is unavailable.' } }); }
});

const generationSchema = z.object({
  area_id: z.string().trim().min(1).max(120).optional(),
  theme: z.string().trim().min(1).max(80).optional(), tier: z.enum(['starter','explorer','signature','legendary']).optional(),
  budgetMin: z.number().int().min(60).max(600).optional(), seed: z.number().int().optional(),
  minStops: z.number().int().min(2).max(12).optional(), maxStops: z.number().int().min(2).max(12).optional(),
  maxLegMin: z.number().int().min(15).max(180).optional(), maxPerCategory: z.number().int().min(1).max(12).optional(),
  mustInclude: z.array(z.string().max(120)).max(12).optional(), exclude: z.array(z.string().max(120)).max(100).optional(),
  startNode: z.string().max(120).optional(), costing: z.enum(['auto','pedestrian','bicycle','motorcycle']).optional(),
  start_point: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict().optional(),
  constraints: z.object({ themes: z.array(z.string().max(80)).optional(), goodFor: z.array(z.string().max(80)).optional() }).optional(),
}).refine(v => !v.minStops || !v.maxStops || v.minStops <= v.maxStops, { message: 'minStops must not exceed maxStops.' })
  .refine(v => [v.area_id, v.startNode, v.start_point].filter(Boolean).length === 1, { message: 'Choose exactly one area, start spot, or start location.' });

trailsRouter.post('/admin/trails/generate', async (req: AuthRequest, res: Response) => {
  const parsed = generationSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid trail generation request.' } });
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'Trail storage is unavailable.' } });
  try {
    const { area_id, start_point, ...generation } = parsed.data;
    const result = await generateTrail(pool, { ...generation, areaId: area_id, startNode: start_point ?? generation.startNode, kind: 'admin', requestedBy: req.user!.id });
    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    if (error instanceof TrailGenerationError) return res.status(422).json({ success: false, error: { code: error.code, message: error.message } });
    return res.status(503).json({ success: false, error: { code: 'GENERATION_FAILED', message: 'Trail generation failed; no partial trail was saved.' } });
  }
});

const compareSolversSchema = z.object({
  spot_ids: z.array(z.string().min(1).max(120)).min(3).max(60),
  budget_min: z.number().int().min(60).max(600),
  min_stops: z.number().int().min(2).max(12).default(3),
  max_stops: z.number().int().min(2).max(12).default(6),
  max_leg_min: z.number().int().min(15).max(180).default(60),
  max_per_category: z.number().int().min(1).max(12).default(2),
  must_include: z.array(z.string().max(120)).max(12).default([]),
  exclude: z.array(z.string().max(120)).max(60).default([]),
  start_node: z.string().max(120).optional(),
  seed: z.number().int().default(44),
  costing: z.enum(['auto','pedestrian','bicycle','motorcycle']).default('auto'),
  with_windows: z.boolean().default(true),
}).strict().refine(body => body.min_stops <= body.max_stops, { message: 'min_stops must not exceed max_stops.' })
  .refine(body => new Set(body.spot_ids).size === body.spot_ids.length, { message: 'spot_ids must be unique.' });

// cuOpt is deliberately isolated to this administrator-only benchmark path.
// Traveler generation always remains on the deterministic local solver.
trailsRouter.post('/admin/trails/compare-solvers', async (req: AuthRequest, res: Response) => {
  const parsed = compareSolversSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid solver comparison request.' } });
  if (!await cuoptEnabledWithKey()) return res.status(503).json({ success: false, error: { code: 'CUOPT_DISABLED', message: 'cuOpt comparison requires explicit local enablement and the private owner key file.' } });
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'Trail storage is unavailable.' } });
  try {
    const allSpots = await loadTrailSignalInputs(pool, undefined, { spotIds: parsed.data.spot_ids });
    const byId = new Map(allSpots.map(spot => [spot.spotId, spot]));
    const selected = parsed.data.spot_ids.map(id => byId.get(id));
    if (selected.some(spot => !spot)) return res.status(400).json({ success: false, error: { code: 'SPOT_SET_INVALID', message: 'Every spot must be published, public, and non-test.' } });
    if (parsed.data.start_node && !byId.has(parsed.data.start_node)) return res.status(400).json({ success: false, error: { code: 'START_SPOT_INVALID', message: 'Start spot must be a published catalog spot.' } });
    const spots = selected.filter((spot): spot is NonNullable<typeof spot> => spot !== undefined);
    const values = new Map(computeSpotSignals(spots).map(signal => [signal.spotId, signal.value]));
    const problem: TrailProblem = {
      nodes: spots.map(spot => ({ spotId: spot.spotId, title: spot.title, municipality: spot.municipality, description: spot.description,
        lat: spot.lat, lng: spot.lng, value: values.get(spot.spotId) ?? 0, dwellMin: 45,
        windows: parsed.data.with_windows ? windowsFromBestTime(spot.bestTime ?? []) : [], crowdByHour: Array(24).fill(0), category: spot.category })),
      startNode: parsed.data.start_node, dayStartMin: 8 * 60, budgetMin: parsed.data.budget_min,
      minStops: parsed.data.min_stops, maxStops: parsed.data.max_stops, maxLegMin: parsed.data.max_leg_min,
      maxPerCategory: parsed.data.max_per_category, mustInclude: parsed.data.must_include, exclude: parsed.data.exclude,
      weights: { crowdPenalty: 0.15, travelPenalty: 0.003 }, seed: parsed.data.seed, costing: parsed.data.costing,
    };
    const matrix = await loadTravelTimeLookup(pool, problem.costing ?? 'auto');
    const local = solveLocal(problem, matrix);
    const cuopt = await createCuoptSolver().solve(problem, matrix);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [solver, result] of [['local', local], ['cuopt', cuopt]] as const) {
        const generationId = randomUUID();
        await client.query(`INSERT INTO trail_generations
          (id,kind,requested_by,input,constraints,solver,solver_ms,objective,result,ai_used)
          VALUES ($1,'benchmark',$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8::jsonb,FALSE)`, [generationId, req.user!.id,
          JSON.stringify({ compare_solvers: true, candidate_count: problem.nodes.length, seed: problem.seed, costing: problem.costing }),
          JSON.stringify({ budget_min: problem.budgetMin, min_stops: problem.minStops, max_stops: problem.maxStops, max_leg_min: problem.maxLegMin, with_windows: parsed.data.with_windows }),
          solver, Math.max(0, Math.round(result.ms)), Number.isFinite(result.objective) ? result.objective : -1,
          JSON.stringify({ feasible: result.feasible, objective: Number.isFinite(result.objective) ? result.objective : null, stops: result.stops.map(stop => stop.spotId), stop_count: result.stops.length, total_min: result.totalMin, total_km: result.totalKm })]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return res.json({ success: true, data: { local, cuopt } });
  } catch (error) {
    if (error instanceof CuoptError) return res.status(error.code === 'CUOPT_INFEASIBLE' ? 422 : 503).json({ success: false, error: { code: error.code, message: error.code === 'CUOPT_INFEASIBLE' ? 'cuOpt found no route satisfying the submitted constraints.' : 'cuOpt comparison is unavailable.' } });
    return res.status(503).json({ success: false, error: { code: 'SOLVER_COMPARISON_FAILED', message: 'Solver comparison failed; no benchmark rows were saved.' } });
  }
});

trailsRouter.post('/admin/trails/:id/review', async (req: AuthRequest, res: Response) => {
  const decision = req.body?.decision;
  if (decision !== 'submit') return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "Review decision must be 'submit'." } });
  return updateTrailStatus(req.params.id, 'pending_review', req.user!.id, res);
});
trailsRouter.post('/admin/trails/:id/publish', async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({success:false,error:{code:'DATABASE_UNAVAILABLE',message:'Trail storage is unavailable.'}});
  try {
    const approximate = await pool.query(`SELECT EXISTS(
      SELECT 1 FROM trail_stops s JOIN trails t ON t.id=s.trail_id
      LEFT JOIN trail_stops previous ON previous.trail_id=s.trail_id AND previous.position=s.position-1
      LEFT JOIN travel_time_matrix m ON m.costing=t.costing AND m.from_spot=previous.spot_id AND m.to_spot=s.spot_id
      WHERE s.trail_id=$1 AND s.position>1 AND COALESCE(m.approximate,TRUE)) AS has_approximate`, [req.params.id]);
    if (approximate.rows[0]?.has_approximate && req.body?.confirm_approximate !== true) {
      return res.status(409).json({success:false,error:{code:'APPROXIMATE_LEGS_CONFIRMATION_REQUIRED',message:'This route has estimated straight-line legs. Review them and explicitly confirm before publishing.'}});
    }
  } catch { return res.status(503).json({success:false,error:{code:'TRAIL_UPDATE_FAILED',message:'Trail routing quality could not be checked.'}}); }
  return updateTrailStatus(req.params.id, 'published', req.user!.id, res, true);
});
trailsRouter.post('/admin/trails/:id/reject', async (req: AuthRequest, res: Response) => updateTrailStatus(req.params.id, 'rejected', req.user!.id, res));
trailsRouter.post('/admin/trails/:id/retire', async (req: AuthRequest, res: Response) => updateTrailStatus(req.params.id, 'retired', req.user!.id, res));

const trailPatchSchema = z.object({
  title: z.string().trim().min(3).max(80).optional(),
  tagline: z.string().trim().max(160).optional(),
  tier: z.enum(['starter','explorer','signature','legendary']).optional(),
  price_points: z.number().int().min(1).max(100_000).optional(),
  available_from: z.string().datetime({ offset: true }).nullable().optional(),
  available_until: z.string().datetime({ offset: true }).nullable().optional(),
  narration: z.array(z.object({ position: z.number().int().min(1).max(12), text: z.string().trim().max(400) }).strict()).min(1).max(12).optional(),
}).strict().refine(value => Object.keys(value).length > 0, { message: 'Provide at least one editable trail field.' });

trailsRouter.patch('/admin/trails/:id', async (req: AuthRequest, res: Response) => {
  const parsed = trailPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid trail update.' } });
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'Trail storage is unavailable.' } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query('SELECT * FROM trails WHERE id=$1 AND source=\'engine\' FOR UPDATE', [req.params.id]);
    const trail = selected.rows[0];
    if (!trail) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: { code: 'TRAIL_NOT_FOUND', message: 'Editable engine trail was not found.' } });
    }

    const body = parsed.data;
    const currentFrom = trail.available_from ? new Date(trail.available_from) : null;
    const currentUntil = trail.available_until ? new Date(trail.available_until) : null;
    const nextFrom = body.available_from === undefined ? currentFrom : body.available_from === null ? null : new Date(body.available_from);
    const nextUntil = body.available_until === undefined ? currentUntil : body.available_until === null ? null : new Date(body.available_until);
    if (nextFrom && nextUntil && nextFrom.getTime() >= nextUntil.getTime()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: { code: 'INVALID_AVAILABILITY', message: 'available_from must be earlier than available_until.' } });
    }

    const tier = body.tier ?? trail.tier;
    const economy = await loadTrailEconomy(client);
    const oldRule = typeof trail.unlock_rule === 'string' ? JSON.parse(trail.unlock_rule) : trail.unlock_rule ?? {};
    let unlockRule = oldRule;
    if (body.price_points !== undefined && !['signature', 'legendary'].includes(tier)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: { code: 'PRICE_NOT_ALLOWED', message: 'Only Signature and Legendary trails have a points price.' } });
    }
    if (body.tier !== undefined || body.price_points !== undefined) {
      if (tier === 'starter') unlockRule = { type: 'free' };
      else if (tier === 'explorer') unlockRule = { type: 'level', min_level: economy.explorerMinLevel };
      else {
        const changedTier = body.tier !== undefined && body.tier !== trail.tier;
        const existingPrice = changedTier ? undefined : oldRule.price_points;
        const configuredPrice = tier === 'legendary' ? economy.legendaryUnlockPoints : economy.signatureUnlockPoints;
        unlockRule = { type: 'points', price_points: body.price_points ?? existingPrice ?? configuredPrice };
      }
    }

    const story = typeof trail.story === 'string' ? JSON.parse(trail.story) : { ...(trail.story ?? {}) };
    if (body.title !== undefined) story.title = body.title;
    if (body.tagline !== undefined) story.tagline = body.tagline;
    const updates: string[] = ['version=version+1'];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => { values.push(value); updates.push(`${column}=$${values.length}`); };
    if (body.title !== undefined) add('title', body.title);
    if (body.tagline !== undefined) add('tagline', body.tagline);
    if (body.tier !== undefined) add('tier', tier);
    if (body.tier !== undefined || body.price_points !== undefined) add('unlock_rule', JSON.stringify(unlockRule));
    if (body.available_from !== undefined) add('available_from', nextFrom);
    if (body.available_until !== undefined) add('available_until', nextUntil);
    add('story', JSON.stringify(story));
    values.push(req.params.id);
    const updated = await client.query(`UPDATE trails SET ${updates.join(',')} WHERE id=$${values.length} RETURNING *`, values);

    if (body.narration) {
      const positions = body.narration.map(item => item.position);
      if (new Set(positions).size !== positions.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: { code: 'DUPLICATE_STOP_POSITION', message: 'Each stop position may be edited once per request.' } });
      }
      const existingStops = await client.query('SELECT position,spot_id FROM trail_stops WHERE trail_id=$1', [req.params.id]);
      const stopsByPosition = new Map(existingStops.rows.map(row => [Number(row.position), String(row.spot_id)]));
      const storyStops = Array.isArray(story.stops) ? story.stops : [];
      for (const item of body.narration) {
        const spotId = stopsByPosition.get(item.position);
        if (!spotId) {
          await client.query('ROLLBACK');
          return res.status(400).json({ success: false, error: { code: 'STOP_NOT_FOUND', message: `Stop position ${item.position} does not exist.` } });
        }
        await client.query('UPDATE trail_stops SET narration=$1 WHERE trail_id=$2 AND position=$3', [item.text, req.params.id, item.position]);
        const storyStop = storyStops.find((stop: any) => stop.spot_id === spotId);
        if (storyStop) storyStop.narration = item.text;
      }
      await client.query('UPDATE trails SET story=$1::jsonb WHERE id=$2', [JSON.stringify(story), req.params.id]);
    }

    const stops = await client.query('SELECT position,spot_id,arrive_offset_min,dwell_min,leg_minutes,leg_km,narration FROM trail_stops WHERE trail_id=$1 ORDER BY position', [req.params.id]);
    await client.query('COMMIT');
    return res.json({ success: true, data: { ...updated.rows[0], stops: stops.rows } });
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(503).json({ success: false, error: { code: 'TRAIL_UPDATE_FAILED', message: 'Trail update failed; no partial change was saved.' } });
  } finally { client.release(); }
});

async function updateTrailStatus(id: string, status: string, adminId: string, res: Response, publish = false) {
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'Trail storage is unavailable.' } });
  try {
    const result = await pool.query(`UPDATE trails SET status=$1, reviewed_by=$2, published_at=CASE WHEN $3 THEN clock_timestamp() ELSE published_at END
      WHERE id=$4 AND source='engine' AND ($1 <> 'published' OR status='pending_review') RETURNING *`, [status, adminId, publish, id]);
    if (!result.rowCount) return res.status(404).json({ success: false, error: { code: 'TRAIL_NOT_REVIEWABLE', message: 'Engine trail was not found or is not ready for this action.' } });
    return res.json({ success: true, data: result.rows[0] });
  } catch { return res.status(503).json({ success: false, error: { code: 'TRAIL_UPDATE_FAILED', message: 'Trail status could not be updated.' } }); }
}
