import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authenticateToken, optionalAuthenticateToken, requireAdmin, AuthRequest, isAuthorizedQA, checkQAAuthorization } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { env } from '../config/env.js';
import { db, QuestRow } from '../db/index.js';
import { getPool } from '../db/pool.js';
import { randomUUID } from 'crypto';
import { distanceKm, spotStore, taxonomy } from '../spots/store.js';
import { assetStore } from '../spots/asset-store.js';
import { getSpotPhotoStorageProvider } from '../storage/spot-photos.js';
import { detectValidatedMediaMime } from '../utils/media-mime.js';
import { fieldLogStore, FieldLogTag, SpotReportReason } from '../spots/field-logs.js';
import { hiddenGemHighlights } from '../spots/highlights.js';
import { sanitizeQuestForViewer } from '../quests/sanitize.js';
import { recordActivity } from '../social/activity.js';
import { listSpotsPage } from '../spots/query.js';

const router = Router();
const csv = (value: unknown) => typeof value === 'string' && value ? value.split(',').map(v => v.trim()).filter(Boolean) : [];
const numeric = (value: unknown) => typeof value === 'string' && value !== '' ? Number(value) : undefined;
const validSpotIdentifier = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,179}$/.test(value);
const publicSpot = (identifier: string, allowTest: boolean) =>
  validSpotIdentifier(identifier)
    ? spotStore.findByIdentifier(identifier, { publishedOnly: true, allowTest })
    : Promise.resolve(undefined);

const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 + 1024 }, // Allowed up to 30 MB for video clips (8 MB for photos enforced downstream)
});

const uploadRateLimiter = rateLimit({
  policyId: 'spots:photo-upload',
  windowMs: 60 * 1000,
  max: env.NODE_ENV === 'test' ? 1000 : 20,
  keyStrategy: 'actor_or_ip',
});


router.get('/spot-taxonomy', (_req, res) => res.json({ success: true, data: {
  categories: taxonomy,
  tags: ['coffee', 'local_food', 'family', 'friends', 'quiet', 'work_friendly', 'scenic', 'running', 'sports', 'hidden_gem', 'free'],
  amenities: ['parking', 'restroom', 'wifi', 'wheelchair_accessible', 'pet_friendly', 'child_friendly'],
} }));

router.get('/spots', optionalAuthenticateToken, checkQAAuthorization, async (req: AuthRequest, res) => {
  const allowTest = isAuthorizedQA(req);
  if (allowTest) res.set('X-Robots-Tag', 'noindex, nofollow');
  const lat = numeric(req.query.lat), lng = numeric(req.query.lng), radius = numeric(req.query.radius_km);
  if ((lat !== undefined) !== (lng !== undefined) || [lat, lng, radius].some(v => v !== undefined && !Number.isFinite(v))) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Valid lat/lng and radius values are required.' } });
  }
  const requestedLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  const sort = typeof req.query.sort === 'string' ? req.query.sort : 'recommended';
  let bbox: [number, number, number, number] | undefined;
  if (req.query.bbox !== undefined) {
    const coords = typeof req.query.bbox === 'string' ? req.query.bbox.split(',').map(Number) : [];
    if (coords.length !== 4 || coords.some(value => !Number.isFinite(value)) || coords[0] < -180 || coords[2] > 180 || coords[1] < -90 || coords[3] > 90 || coords[0] >= coords[2] || coords[1] >= coords[3]) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'bbox must be west,south,east,north within valid coordinates.' } });
    }
    bbox = coords as [number, number, number, number];
  }
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 200 || !['recommended', 'newest', 'nearest', 'trending'].includes(sort)) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'limit must be 1-200 and sort must be recommended, newest, nearest, or trending.' } });
  }
  if (sort === 'nearest' && (lat === undefined || lng === undefined)) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'nearest sort requires lat and lng.' } });
  }
  const actorId = req.user?.id || (req.headers['x-device-id'] as string) || (req.headers['x-forwarded-for'] as string) || req.ip;
  const filters = {
    search: typeof req.query.q === 'string' ? req.query.q : undefined,
    categories: csv(req.query.categories), tags: csv(req.query.tags),
    municipality: typeof req.query.municipality === 'string' ? req.query.municipality : undefined,
    lat, lng, radius, intent: typeof req.query.intent === 'string' ? req.query.intent : undefined,
    sort: sort as 'recommended' | 'newest' | 'nearest' | 'trending',
    hasQuest: req.query.has_quest === 'true', userId: String(actorId || ''), allowTest,
    areaId: typeof req.query.area_id === 'string' ? req.query.area_id : undefined,
    bbox, limit: requestedLimit, cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
  };
  const pool = getPool();
  if (pool) {
    try {
      const page = await listSpotsPage(pool, filters);
      return res.json({ success: true, data: page.items, meta: { count: page.items.length, limit: page.limit, has_more: page.hasMore, next_cursor: page.nextCursor, sort } });
    } catch (error) {
      if (error instanceof Error && error.message === 'INVALID_CURSOR') {
        return res.status(400).json({ success: false, error: { code: 'INVALID_CURSOR', message: 'The spot list cursor is invalid or does not match these filters.' } });
      }
      console.error('[spots:list] database query failed:', error instanceof Error ? error.message : error);
      return res.status(500).json({ success: false, error: { code: 'DATABASE_ERROR', message: 'Unable to load destinations.' } });
    }
  }
  const all = spotStore.list(filters).slice(0, requestedLimit);
  return res.json({ success: true, data: all, meta: { count: all.length, limit: requestedLimit, has_more: false, next_cursor: null, sort } });
});

router.get('/spots/highlights', optionalAuthenticateToken, (req: AuthRequest, res) => {
  res.set('Cache-Control', 'private, no-store');
  return res.json({ success: true, data: hiddenGemHighlights(spotStore, req.user?.id),
    meta: { algorithm: 'curated_hidden_gems_v1', estimated_not_live: true } });
});

router.get('/spots/trending', optionalAuthenticateToken, checkQAAuthorization, (req: AuthRequest, res) => {
  const allowTest = isAuthorizedQA(req);
  if (allowTest) res.set('X-Robots-Tag', 'noindex, nofollow');
  const actorId = req.user?.id || (req.headers['x-device-id'] as string) || (req.headers['x-forwarded-for'] as string) || req.ip;
  res.json({ success: true, data: spotStore.list({ municipality: req.query.municipality as string | undefined, sort: 'trending', userId: actorId, allowTest }).slice(0, 10) });
});

router.get('/spots/:slug/alternatives', optionalAuthenticateToken, checkQAAuthorization, async (req: AuthRequest, res) => {
  const allowTest = isAuthorizedQA(req);
  if (allowTest) res.set('X-Robots-Tag', 'noindex, nofollow');
  const source=await publicSpot(req.params.slug,allowTest);
  if(!source)return res.status(404).json({success:false,error:{code:'NOT_FOUND',message:'Spot not found.'}});
  const requested=numeric(req.query.limit);const limit=requested===undefined?3:Math.max(1,Math.min(5,Math.floor(requested)));
  const actorId = req.user?.id || (req.headers['x-device-id'] as string) || (req.headers['x-forwarded-for'] as string) || req.ip;
  return res.json({success:true,data:spotStore.alternatives(source,actorId,limit),meta:{source_spot_id:source.id,catalog_scope:'pangasinan_alpha',ranking_scope:'catalog_wide',expansion_ready:'philippines',personalized:Boolean(req.user),estimated_not_live:true}});
});

router.get('/spots/:slug', optionalAuthenticateToken, checkQAAuthorization, async (req: AuthRequest, res) => {
  const allowTest = isAuthorizedQA(req);
  const spot = await publicSpot(req.params.slug, allowTest);
  if (!spot) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Spot not found.' } });
  if (spot.is_test) {
    res.set('X-Robots-Tag', 'noindex, nofollow');
  }
  const actorId = req.user?.id || (req.headers['x-device-id'] as string) || (req.headers['x-forwarded-for'] as string) || req.ip;
  const attached = Array.from(assetStore.assets.values()).filter(a => a.spot_id === spot.id && a.status === 'attached');
  return res.json({ success: true, data: { ...spot, ...spotStore.crowd(spot), saved: spotStore.isSaved(actorId, spot.id), liked: spotStore.isLiked(actorId, spot.id), trend_score: spotStore.trend(spot.id), attached_assets: attached } });
});

router.get('/me/discovery-preferences', authenticateToken, (req: AuthRequest, res) => res.json({ success: true, data: spotStore.getPreferences(req.user!.id) }));
const preferencesSchema = z.object({ body: z.object({ categories: z.array(z.string()).max(10).default([]), tags: z.array(z.string()).max(20).default([]), occasions: z.array(z.string()).max(10).default([]), price_levels: z.array(z.number().int().min(0).max(4)).max(5).default([]), radius_km: z.number().int().min(1).max(200).default(25), onboarding_state: z.enum(['pending', 'completed', 'skipped']).default('completed') }) });
router.put('/me/discovery-preferences', authenticateToken, validateRequest(preferencesSchema), (req: AuthRequest, res) => res.json({ success: true, data: spotStore.setPreferences(req.user!.id, req.body) }));

router.put('/spots/:id/save', authenticateToken, async (req: AuthRequest, res) => { const spot=await spotStore.findByIdentifier(req.params.id,{publishedOnly:true,allowTest:true}); const actor=db.findUserById(req.user!.id); if(!actor)return res.status(403).json({success:false,error:{code:'FORBIDDEN',message:'Account is unavailable.'}}); if(!spot)return res.status(404).json({success:false,error:{code:'NOT_FOUND',message:'Spot not found.'}}); if(Boolean(spot.is_test)!==Boolean(actor.is_test))return res.status(403).json({success:false,error:{code:'SCOPE_MISMATCH',message:'Fictional alpha posts are read-only for real accounts.'}}); const saved=spotStore.interact(req.user!.id,spot.id,'save',true);spotStore.recordActivity(req.user!.id,spot.id,'save');return res.json({success:true,data:{saved}}); });
router.delete('/spots/:id/save', authenticateToken, async (req: AuthRequest, res) => { const spot=await spotStore.findByIdentifier(req.params.id,{publishedOnly:true,allowTest:true}); if(!spot)return res.status(404).json({success:false,error:{code:'NOT_FOUND',message:'Spot not found.'}}); return res.json({ success: true, data: { saved: spotStore.interact(req.user!.id, spot.id, 'save', false) } }); });

router.put('/spots/:id/like', optionalAuthenticateToken, async (req: AuthRequest, res) => {
  const spot = await spotStore.findByIdentifier(req.params.id, { publishedOnly: true, allowTest: isAuthorizedQA(req) });
  if (!spot) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Spot not found.' } });
  const actorId = req.user?.id || (req.headers['x-device-id'] as string) || (req.headers['x-forwarded-for'] as string) || req.ip || 'anon';
  spotStore.interact(String(actorId), spot.id, 'like', true);
  return res.json({ success: true, data: { liked: true, spot_id: spot.id } });
});

router.delete('/spots/:id/like', optionalAuthenticateToken, async (req: AuthRequest, res) => {
  const spot = await spotStore.findByIdentifier(req.params.id, { publishedOnly: true, allowTest: isAuthorizedQA(req) });
  if (!spot) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Spot not found.' } });
  const actorId = req.user?.id || (req.headers['x-device-id'] as string) || (req.headers['x-forwarded-for'] as string) || req.ip || 'anon';
  spotStore.interact(String(actorId), spot.id, 'like', false);
  return res.json({ success: true, data: { liked: false, spot_id: spot.id } });
});
router.post('/spots/:id/interactions', authenticateToken, validateRequest(z.object({ body: z.object({ type: z.enum(['view', 'directions', 'helpful', 'visit']), captured_lat:z.number().min(-90).max(90).optional(), captured_lng:z.number().min(-180).max(180).optional() }) })), async (req: AuthRequest, res) => {
  const spot=await spotStore.findByIdentifier(req.params.id,{publishedOnly:true,allowTest:true});if(!spot)return res.status(404).json({success:false,error:{code:'NOT_FOUND',message:'Spot not found.'}});
  const actor=db.findUserById(req.user!.id);if(!actor)return res.status(403).json({success:false,error:{code:'FORBIDDEN',message:'Account is unavailable.'}});if(Boolean(spot.is_test)!==Boolean(actor.is_test))return res.status(403).json({success:false,error:{code:'SCOPE_MISMATCH',message:'Fictional alpha posts are read-only for real accounts.'}});
  if(req.body.type==='visit'&&(req.body.captured_lat===undefined||req.body.captured_lng===undefined||distanceKm(req.body.captured_lat,req.body.captured_lng,spot.gps_lat,spot.gps_lng)>.25))return res.status(422).json({success:false,error:{code:'VISIT_NOT_VERIFIED',message:'A visit must include coordinates within 250 meters of the destination.'}});
  const recorded=spotStore.interact(req.user!.id,req.params.id,req.body.type,true);if(req.body.type!=='helpful')spotStore.recordActivity(req.user!.id,req.params.id,req.body.type);return res.status(201).json({success:true,data:{recorded}});
});

const spotReviewSchema=z.object({body:z.object({status:z.enum(['published','needs_review','unpublished']),crowd_capacity_band:z.enum(['low','medium','high']),recommendation_suppressed:z.boolean().default(false)})});
router.get('/admin/spots',authenticateToken,requireAdmin,async (_req,res)=>{
  const pool=getPool();
  if(pool){const {rows}=await pool.query("SELECT * FROM spots ORDER BY updated_at DESC, id DESC LIMIT 200");return res.json({success:true,data:rows,meta:{limit:200,has_more:rows.length===200}});}
  return res.json({success:true,data:spotStore.spots.slice(0,200).map(s=>({...s,...spotStore.crowd(s)})),meta:{limit:200,has_more:false}});
});
router.patch('/admin/spots/:id',authenticateToken,requireAdmin,validateRequest(spotReviewSchema),(req:AuthRequest,res)=>{const spot=spotStore.review(req.params.id,req.user!.id,req.body.status,req.body.crowd_capacity_band,req.body.recommendation_suppressed);if(!spot)return res.status(404).json({success:false,error:{code:'NOT_FOUND',message:'Spot not found.'}});return res.json({success:true,data:{...spot,...spotStore.crowd(spot)}});});

const importedSpotActionSchema = z.object({ body: z.object({
  action: z.enum(['approve', 'reject', 'edit']),
  name: z.string().trim().min(3).max(200).optional(),
  description: z.string().max(2000).optional(),
  category: z.enum(['eat_drink', 'nature_outdoors', 'culture_heritage', 'activities_wellness', 'shopping_local', 'stay']).optional(),
  subcategory: z.string().trim().min(2).max(50).optional(),
  municipality: z.string().trim().max(100).optional(),
  address: z.string().trim().max(300).optional(),
  approve_scraped_fields: z.array(z.enum(['hours', 'official_website', 'contact_number', 'entrance_fee', 'closure_notice'])).max(5).default([]),
}) });

router.get('/admin/imported-spots', authenticateToken, requireAdmin, async (req: AuthRequest, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_REQUIRED', message: 'Imported-place review requires PostgreSQL.' } });
  const status = typeof req.query.status === 'string' ? req.query.status : 'needs_review';
  const wave = typeof req.query.wave === 'string' ? req.query.wave : undefined;
  const regionPsgc = typeof req.query.region_psgc === 'string' ? req.query.region_psgc : undefined;
  const minConfidence = numeric(req.query.min_confidence), maxConfidence = numeric(req.query.max_confidence);
  const limit = req.query.limit === undefined ? 30 : Number(req.query.limit);
  if (!['needs_review', 'published', 'unpublished', 'all'].includes(status) || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
      [minConfidence, maxConfidence].some(value => value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) ||
      (regionPsgc !== undefined && !/^\d{6,10}$/.test(regionPsgc))) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid imported-place filters.' } });
  }
  const values: unknown[] = [];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const where = [`source_type = 'open_data'`, `external_refs <> '{}'::jsonb`];
  if (status !== 'all') where.push(`status = ${bind(status)}`);
  if (wave) where.push(`import_wave = ${bind(wave)}`);
  if (minConfidence !== undefined) where.push(`import_confidence >= ${bind(minConfidence)}`);
  if (maxConfidence !== undefined) where.push(`import_confidence <= ${bind(maxConfidence)}`);
  if (regionPsgc) {
    const psgc = bind(regionPsgc);
    where.push(`town_area_id IN (WITH RECURSIVE descendants(id) AS (
      SELECT id FROM admin_areas WHERE psgc_code = ${psgc}::bigint
      UNION ALL SELECT a.id FROM admin_areas a JOIN descendants d ON a.parent_id = d.id
    ) SELECT id FROM descendants)`);
  }
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (typeof decoded.created_at !== 'string' || typeof decoded.id !== 'string') throw new Error('bad cursor');
      where.push(`(created_at, id) < (${bind(decoded.created_at)}::timestamptz, ${bind(decoded.id)})`);
    } catch { return res.status(400).json({ success: false, error: { code: 'INVALID_CURSOR', message: 'Review cursor is invalid.' } }); }
  }
  const limitParam = bind(limit + 1);
  try {
    const { rows } = await pool.query(`SELECT s.*, s.created_at::text AS cursor_created_at,
      (SELECT jsonb_agg(jsonb_build_object('url',a.url,'author',a.author,'license',a.license,'attribution_url',a.attribution_url,'status',a.status))
      FROM spot_assets a WHERE a.spot_id=s.id AND a.status='attached') AS commons_assets
      FROM spots s WHERE ${where.map(clause => clause.replaceAll('source_type =', 's.source_type =').replaceAll('external_refs <>', 's.external_refs <>').replaceAll('status =', 's.status =').replaceAll('import_wave =', 's.import_wave =').replaceAll('import_confidence ', 's.import_confidence ').replaceAll('town_area_id IN', 's.town_area_id IN').replaceAll('(created_at, id)', '(s.created_at, s.id)')).join(' AND ')}
      ORDER BY s.created_at DESC,s.id DESC LIMIT ${limitParam}`, values);
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit);
    const last = data.at(-1);
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ created_at: last.cursor_created_at, id: last.id })).toString('base64url') : null;
    return res.json({ success: true, data, meta: { count: data.length, limit, has_more: hasMore, next_cursor: nextCursor } });
  } catch (error) {
    console.error('[admin:imported-spots] query failed:', error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, error: { code: 'DATABASE_ERROR', message: 'Unable to load imported destinations.' } });
  }
});

router.patch('/admin/imported-spots/:id', authenticateToken, requireAdmin, validateRequest(importedSpotActionSchema), async (req: AuthRequest, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_REQUIRED', message: 'Imported-place review requires PostgreSQL.' } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query("SELECT * FROM spots WHERE id=$1 AND source_type='open_data' AND external_refs <> '{}'::jsonb FOR UPDATE", [req.params.id]);
    if (!result.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Imported destination not found.' } }); }
    const spot = result.rows[0];
    const updates: Record<string, unknown> = {};
    if (req.body.action === 'approve') { updates.status = 'published'; updates.trust_level = 'open_data'; updates.recommendation_suppressed = false; }
    if (req.body.action === 'reject') { updates.status = 'unpublished'; updates.recommendation_suppressed = true; }
    if (req.body.action === 'edit') {
      for (const field of ['name', 'description', 'category', 'subcategory', 'municipality', 'address']) if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    const pending = { ...(spot.field_sources?.scraped_pending || {}) } as Record<string, any>;
    for (const key of req.body.approve_scraped_fields || []) {
      const proposed = pending[key];
      if (!proposed || proposed.source !== 'scrapling' || proposed.reviewed !== false || typeof proposed.proposed_value !== 'string') continue;
      const value = proposed.proposed_value.trim().slice(0, 500);
      if (key === 'hours') updates.hours = JSON.stringify({ source_text: value });
      if (key === 'official_website') {
        try { const parsed = new URL(value); if (['http:', 'https:'].includes(parsed.protocol)) updates.official_website = parsed.toString(); }
        catch { /* Invalid URL remains pending and hidden. */ }
      }
      if (key === 'contact_number') updates.contact_phone = value;
      if (key === 'entrance_fee') updates.entrance_fee_text = value;
      if (key === 'closure_notice') updates.closure_notice = value;
      pending[key] = { ...proposed, reviewed: true, reviewed_by: req.user!.id, reviewed_at: new Date().toISOString() };
    }
    const sources = { ...(spot.field_sources || {}), scraped_pending: pending };
    updates.field_sources = JSON.stringify(sources);
    updates.reviewed_by = req.user!.id;
    updates.reviewed_at = new Date().toISOString();
    updates.updated_at = updates.reviewed_at;
    const columns = Object.keys(updates);
    const values: unknown[] = [];
    const assignments = columns.map((column) => {
      values.push(updates[column]);
      return `${column}=$${values.length}${column === 'hours' || column === 'field_sources' ? '::jsonb' : ''}`;
    });
    values.push(req.params.id);
    const updated = await client.query(`UPDATE spots SET ${assignments.join(',')} WHERE id=$${values.length} RETURNING id,slug,name,status,import_confidence,import_wave,official_website,contact_phone,entrance_fee_text,closure_notice,hours,reviewed_by,reviewed_at`, values);
    await client.query('COMMIT');
    return res.json({ success: true, data: updated.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[admin:imported-spots] update failed:', error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, error: { code: 'DATABASE_ERROR', message: 'Unable to update imported destination.' } });
  } finally { client.release(); }
});

const bulkImportedSpotSchema = z.object({ body: z.object({ wave: z.string().min(1).max(100), region_psgc: z.string().regex(/^\d{6,10}$/).optional(), minimum_confidence: z.number().min(0.6).max(1), max_items: z.number().int().min(1).max(500).default(100) }) });
router.post('/admin/imported-spots/bulk-approve', authenticateToken, requireAdmin, validateRequest(bulkImportedSpotSchema), async (req: AuthRequest, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_REQUIRED', message: 'Imported-place review requires PostgreSQL.' } });
  const { wave, region_psgc: psgc, minimum_confidence: min, max_items: max } = req.body;
  const { rows } = await pool.query(`WITH RECURSIVE eligible_area(id) AS (
      SELECT id FROM admin_areas WHERE psgc_code=$3::bigint
      UNION ALL SELECT a.id FROM admin_areas a JOIN eligible_area p ON a.parent_id=p.id
    ), candidates AS (
      SELECT id FROM spots WHERE source_type='open_data' AND status='needs_review' AND import_wave=$1 AND import_confidence >= $2
        AND town_area_id IS NOT NULL AND ($3::text IS NULL OR town_area_id IN (SELECT id FROM eligible_area))
        AND NOT EXISTS (SELECT 1 FROM jsonb_each(COALESCE(field_sources->'scraped_pending','{}'::jsonb)) f WHERE COALESCE((f.value->>'reviewed')::boolean,FALSE)=FALSE)
      ORDER BY import_confidence DESC, id LIMIT $4 FOR UPDATE SKIP LOCKED
    ) UPDATE spots s SET status='published',trust_level='open_data',recommendation_suppressed=FALSE,reviewed_by=$5,reviewed_at=NOW(),updated_at=NOW()
      FROM candidates c WHERE s.id=c.id RETURNING s.id,s.name,s.import_confidence`, [wave, min, psgc || null, max, req.user!.id]);
  return res.json({ success: true, data: rows, meta: { approved_count: rows.length, limit: max } });
});

// Shared handler for photo & rich video media uploads
const handleMediaUpload = (req: AuthRequest, res: any) => {
  mediaUpload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'media', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ])(req, res, async (err: any) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          error: { code: 'FILE_TOO_LARGE', message: 'File size exceeds maximum limit of 30 MB for video clips (8 MB for photos).' },
        });
      }
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: err.message || 'File upload failed.' },
      });
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const uploadedFile =
      files?.photo?.[0] || files?.media?.[0] || files?.file?.[0] || req.file;

    if (!uploadedFile || !uploadedFile.buffer) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'No photo or video file provided in request.' },
      });
    }

    // Validate actual file signatures / magic bytes
    const detected = detectValidatedMediaMime(uploadedFile.buffer);
    if (!detected) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_IMAGE_CONTENT', message: 'File content does not match a valid image (JPEG, PNG, WebP) or video (MP4, WebM, QuickTime) signature.' },
      });
    }

    // Enforce 8 MB cap specifically for static images
    if (detected.mediaType === 'image' && uploadedFile.size > 8 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        error: { code: 'FILE_TOO_LARGE', message: 'Photo file size exceeds maximum limit of 8 MB.' },
      });
    }

    // Enforce 30 MB cap for video clips
    if (detected.mediaType === 'video' && uploadedFile.size > 30 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        error: { code: 'FILE_TOO_LARGE', message: 'Video file size exceeds maximum limit of 30 MB.' },
      });
    }

    let storageProvider;
    try {
      storageProvider = getSpotPhotoStorageProvider();
    } catch (e: any) {
      return res.status(500).json({
        success: false,
        error: { code: 'STORAGE_CONFIG_ERROR', message: e.message || 'Storage configuration error.' },
      });
    }

    try {
      const saveResult = await storageProvider.savePhoto(
        uploadedFile.buffer,
        detected.mime,
        detected.ext,
        detected.mediaType
      );
      const assetRecord = await assetStore.createPendingAsset(req.user!.id, saveResult, storageProvider.name);

      return res.status(201).json({
        success: true,
        data: {
          asset_id: assetRecord.id,
          url: assetRecord.url,
          mime_type: assetRecord.mime_type,
          media_type: assetRecord.media_type,
          width: assetRecord.width,
          height: assetRecord.height,
          size_bytes: assetRecord.size_bytes,
        },
      });
    } catch (e: any) {
      return res.status(500).json({
        success: false,
        error: { code: 'UPLOAD_FAILED', message: e.message || 'Upload processing failed.' },
      });
    }
  });
};

// POST /api/v1/spot-photos - Authenticated photo upload (backward-compatible)
router.post('/spot-photos', authenticateToken, uploadRateLimiter, handleMediaUpload);

// POST /api/v1/spot-media - Authenticated rich media upload (photos & videos)
router.post('/spot-media', authenticateToken, uploadRateLimiter, handleMediaUpload);


const contributionSchema = z.object({
  body: z.object({
    name: z.string().trim().min(3).max(200),
    description: z.string().trim().min(20).max(2000),
    category: z.enum(['eat_drink', 'nature_outdoors', 'culture_heritage', 'activities_wellness', 'shopping_local', 'stay']),
    subcategory: z.string().min(2).max(50),
    tags: z.array(z.string()).max(15).default([]),
    municipality: z.string().min(2).max(100),
    address: z.string().min(3).max(300),
    gps_lat: z.number().min(4.5).max(21.5),
    gps_lng: z.number().min(116).max(127),
    price_level: z.number().int().min(0).max(4).nullable().optional(),
    good_for: z
      .array(z.enum(['families', 'solo', 'couples', 'groups', 'seniors_access']))
      .max(5)
      .default([]),
    best_time: z
      .array(
        z.enum([
          'early_morning',
          'daytime',
          'sunset',
          'night',
          'weekdays',
          'dry_season',
          'rainy_season',
        ])
      )
      .max(4)
      .default([]),
    hours: z.record(z.string()).default({}),
    amenities: z.array(z.string()).max(20).default([]),
    image_url: z.string().url().or(z.literal('')).default(''),
    asset_id: z.string().optional(),
    asset_ids: z.array(z.string()).max(5).optional(),
    quest_id: z.string().optional(),
  }),
});

router.post('/spots', authenticateToken, validateRequest(contributionSchema), async (req: AuthRequest, res) => {
  const assetIds = Array.from(
    new Set([
      ...(req.body.asset_ids || []),
      ...(req.body.asset_id ? [req.body.asset_id] : []),
    ])
  );

  if (assetIds.length > 5) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'A spot can have at most 5 images.' },
    });
  }

  // Pre-validate asset ownership
  for (const assetId of assetIds) {
    const asset = assetStore.getAssetById(assetId);
    if (!asset || asset.status === 'deleted') {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Asset ${assetId} not found.` },
      });
    }
    if (asset.user_id !== req.user!.id) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED_ATTACHMENT', message: 'Cannot attach photo owned by another user.' },
      });
    }
  }

  const result = await spotStore.create(req.body, req.user!.id);

  if (assetIds.length > 0) {
    try {
      const attached = await assetStore.attachAssetsToSpot(assetIds, req.user!.id, result.spot.id);
      result.spot.asset_ids = assetIds;
      if (!result.spot.image_url && attached.length > 0) {
        result.spot.image_url = attached[0].url;
      }
    } catch (e: any) {
      if (e.code === 'UNAUTHORIZED_ATTACHMENT') {
        return res.status(403).json({
          success: false,
          error: { code: 'UNAUTHORIZED_ATTACHMENT', message: 'Cannot attach photo owned by another user.' },
        });
      }
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: e.message || 'Failed to attach photo assets.' },
      });
    }
  }

  if (result.spot.status === 'published' && !result.spot.is_test) {
    try {
      await recordActivity(null, {
        eventKey: `spot_posted:${result.spot.id}`,
        actorId: req.user!.id,
        verb: 'spot_posted',
        subjectType: 'spot',
        subjectId: result.spot.id,
        subjectTitle: result.spot.name,
        subjectHref: `/spots/${result.spot.slug || result.spot.id}`,
        municipality: result.spot.municipality || null,
        payload: {},
        isTest: false,
      });
    } catch (err) {
      console.error('[social:producer] Failed to record spot_posted activity:', err);
    }
  }

  return res.status(201).json({ success: true, data: result.spot });
});

const createAuthorQuestSchema = z.object({
  body: z.object({
    title: z.string().trim().min(5).max(100),
    description: z.string().trim().min(15).max(1000),
    category: z.enum(['eco', 'cultural', 'food_trade']),
    radius_meters: z.number().int().min(50).max(500).default(200),
    reward_points: z.union([z.literal(50), z.literal(75), z.literal(100)]).default(75),
    status: z.enum(['draft', 'published']).default('published'),
    steps: z.array(z.object({
      step_order: z.number().int().min(1),
      title: z.string().trim().min(3).max(100),
      description: z.string().trim().min(5).max(500),
      checkpoint_type: z.enum(['location', 'qr', 'photo', 'action']),
      required: z.boolean().default(true),
      gps_lat: z.number().optional(),
      gps_lng: z.number().optional(),
      radius_meters: z.number().int().optional(),
      hint: z.string().optional(),
    })).max(10).default([]),
  }),
});

router.post('/spots/:id/quests', authenticateToken, validateRequest(createAuthorQuestSchema), async (req: AuthRequest, res) => {
  const spot = await spotStore.findByIdentifier(req.params.id, { publishedOnly: true, allowTest: true });
  if (!spot) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Destination not found.' },
    });
  }

  // Author ownership enforcement
  if (!spot.created_by || spot.created_by !== req.user!.id) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN_NOT_DESTINATION_AUTHOR',
        message: 'Only the original scout who posted this destination can create quests for it.',
      },
    });
  }

  const sanitizedSlug = spot.slug.replace(/[^a-z0-9_-]/g, '').slice(0, 36);
  const questId = `quest-${sanitizedSlug}-${Date.now().toString(36)}`;
  const markerCode = `JDQ-${randomUUID().slice(0, 8).toUpperCase()}`;
  const nowIso = new Date().toISOString();

  const questStatus = env.QUEST_FUNDING_ENABLED ? 'draft' : (req.body.status ?? 'published');
  const requestedSteps = Array.isArray(req.body.steps) ? req.body.steps : [];
  const priorQuest = spot.quest_id ? db.findQuestById(spot.quest_id, true) : undefined;
  const questSteps = requestedSteps.map((step: any) => {
    if (step.checkpoint_type !== 'qr') return step;
    const oldStep = priorQuest?.steps?.find((candidate) => candidate.step_order === step.step_order);
    return { ...step, marker_code: oldStep?.marker_code || `JDQ-STEP-${randomUUID().replace(/-/g, '').toUpperCase()}` };
  });

  const newQuest: QuestRow = {
    id: questId,
    author_id: req.user!.id,
    status: questStatus,
    version: 1,
    steps: questSteps,
    title: req.body.title,
    description: req.body.description,
    category: req.body.category,
    location_name: spot.name,
    gps_lat: spot.gps_lat,
    gps_lng: spot.gps_lng,
    radius_meters: req.body.radius_meters,
    base_reward_php: req.body.reward_points * 0.5,
    difficulty_factor: 1.0,
    geo_multiplier: 2.0,
    reward_points: req.body.reward_points,
    marker_code: markerCode,
    marker_image_url: spot.image_url || 'https://images.unsplash.com/photo-1518509562904-e7ef99cdcc86?auto=format&fit=crop&w=1200&q=80',
    is_active: questStatus === 'published',
    is_test: Boolean(spot.is_test),
    created_at: nowIso,
    updated_at: nowIso,
  };

  const pool = getPool();
  const bindingId = randomUUID();

  if (pool) {
    try {
      await pool.query(
        `INSERT INTO quests (
          id, title, description, category, location_name, gps_lat, gps_lng,
          radius_meters, reward_points, marker_code, marker_image_url, is_active, is_test,
          author_id, status, version, steps,
          created_at, updated_at, funding_required
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          updated_at = NOW()`,
        [
          newQuest.id,
          newQuest.title,
          newQuest.description,
          newQuest.category,
          newQuest.location_name,
          newQuest.gps_lat,
          newQuest.gps_lng,
          newQuest.radius_meters,
          newQuest.reward_points,
          newQuest.marker_code,
          newQuest.marker_image_url,
          newQuest.is_active,
          newQuest.is_test,
          // base_reward_php / difficulty_factor / geo_multiplier are in-memory display
          // values only: no migration creates those columns, and every reader defaults
          // them. Writing them made every PostgreSQL author-quest insert fail.
          newQuest.author_id,
          newQuest.status,
          newQuest.version,
          JSON.stringify(newQuest.steps),
          newQuest.created_at,
          newQuest.updated_at,
          env.QUEST_FUNDING_ENABLED,
        ]
      );

      await pool.query(
        `INSERT INTO reviewed_quest_spot_bindings (
          id, quest_id, spot_id, binding_version, status, reviewed_by, notes, is_test, created_at, updated_at
        ) VALUES ($1, $2, $3, 'v1', 'active', $4, $5, $6, NOW(), NOW())
        ON CONFLICT DO NOTHING`,
        [
          bindingId,
          newQuest.id,
          spot.id,
          req.user!.id,
          `Author quest created by ${req.user!.id} for spot ${spot.name}`,
          newQuest.is_test,
        ]
      );

      if (!spot.quest_id) {
        await pool.query(
          `UPDATE spots SET quest_id = $1, updated_at = NOW() WHERE id = $2`,
          [newQuest.id, spot.id]
        );
      }
    } catch (err: any) {
      console.error('[spots:createQuest] Database persistence error:', err);
      return res.status(500).json({
        success: false,
        error: { code: 'DATABASE_ERROR', message: 'Failed to record quest in database.' },
      });
    }
  }

  // Update in-memory state
  db.upsertQuest(newQuest);
  if (!spot.quest_id) {
    spot.quest_id = newQuest.id;
  }

  return res.status(201).json({
    success: true,
    data: newQuest,
    message: 'Quest created successfully and bound to destination.',
  });
});

router.get('/spots/:id/quests', optionalAuthenticateToken, checkQAAuthorization, async (req: AuthRequest, res) => {
  const allowTest = isAuthorizedQA(req);
  if (allowTest) res.set('X-Robots-Tag', 'noindex, nofollow');
  const spot = await publicSpot(req.params.id, allowTest);
  if (!spot) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Spot not found.' } });
  }

  const isAuthor = Boolean(req.user?.id && spot.created_by === req.user.id);
  const isAdminOrQA = Boolean(req.user?.role === 'admin' || req.user?.role === 'qa');

  const pool = getPool();
  let quests: QuestRow[] = [];

  if (pool) {
    try {
      const { rows } = await pool.query(
        `SELECT q.* FROM quests q
         LEFT JOIN reviewed_quest_spot_bindings b ON b.quest_id = q.id AND b.status = 'active'
         WHERE (b.spot_id = $1 OR q.id = $2) AND (q.is_test = $3 OR $3 = TRUE)
         ORDER BY q.created_at DESC`,
        [spot.id, spot.quest_id || '', allowTest]
      );
      quests = rows.map((r: any) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        category: r.category,
        location_name: r.location_name,
        gps_lat: Number(r.gps_lat),
        gps_lng: Number(r.gps_lng),
        radius_meters: Number(r.radius_meters),
        base_reward_php: Number(r.base_reward_php ?? 25),
        difficulty_factor: Number(r.difficulty_factor ?? 1),
        geo_multiplier: Number(r.geo_multiplier ?? 2),
        reward_points: Number(r.reward_points),
        marker_code: r.marker_code,
        marker_image_url: r.marker_image_url,
        is_active: Boolean(r.is_active),
        is_test: Boolean(r.is_test),
        author_id: r.author_id ?? null,
        status: r.status ?? 'published',
        version: Number(r.version ?? 1),
        steps: Array.isArray(r.steps) ? r.steps : [],
        created_at: new Date(r.created_at).toISOString(),
        updated_at: new Date(r.updated_at).toISOString(),
      }));
    } catch (e: any) {
      console.warn('[spots:getQuests] PG query fallback:', e.message);
      quests = db.quests.filter(q => (q.id === spot.quest_id || q.author_id === spot.created_by) && (allowTest || !q.is_test));
    }
  } else {
    quests = db.quests.filter(q => (q.id === spot.quest_id || q.author_id === spot.created_by) && (allowTest || !q.is_test));
  }

  // Filter out drafts or archived for general travelers
  if (!isAuthor && !isAdminOrQA) {
    quests = quests.filter(q => q.status === 'published' || (!q.status && q.is_active));
  }

  // Sanitize: strip marker_code unless authorized
  const sanitized = quests.map((quest) => {
    const canInspectMarker = allowTest || isAuthor || isAdminOrQA;
    const base = sanitizeQuestForViewer(quest, canInspectMarker);
    if (isAuthor || isAdminOrQA) {
      return {
        ...base,
        stats: db.getQuestAttemptStats(quest.id),
      };
    }
    return base;
  });

  return res.json({
    success: true,
    data: sanitized,
    meta: {
      spot_id: spot.id,
      count: sanitized.length,
    },
  });
});

// GET /spots/:id/comments (or /spots/:id/field-logs)
router.get(['/spots/:id/comments', '/spots/:id/field-logs'], optionalAuthenticateToken, async (req: AuthRequest, res) => {
  const spot = await spotStore.findByIdentifier(req.params.id, { publishedOnly: true, allowTest: isAuthorizedQA(req) });
  if (!spot) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Destination not found.' } });
  }
  const logs = fieldLogStore.list(spot.id);
  return res.json({
    success: true,
    data: logs,
    meta: {
      spot_id: spot.id,
      count: logs.length,
    },
  });
});

// POST /spots/:id/comments
const createFieldLogSchema = z.object({
  body: z.object({
    content: z.string().min(1).max(1000),
    tag: z.enum(['local_tip', 'gear_alert', 'tide_condition', 'food_find', 'heritage', 'eco_watch', 'general']).optional().default('general'),
    author_name: z.string().max(80).optional(),
    author_avatar: z.string().max(2000).optional(),
    image_url: z.string().max(2000000).optional(),
    location_pin: z.object({
      name: z.string().min(1).max(100),
      lat: z.number().optional(),
      lng: z.number().optional(),
    }).optional(),
    is_verified_visit: z.boolean().optional(),
  }),
});

router.post(['/spots/:id/comments', '/spots/:id/field-logs'], optionalAuthenticateToken, validateRequest(createFieldLogSchema), async (req: AuthRequest, res) => {
  const spot = await spotStore.findByIdentifier(req.params.id, { publishedOnly: true, allowTest: isAuthorizedQA(req) });
  if (!spot) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Destination not found.' } });
  }

  const userId = req.user?.id || `guest-${randomUUID().slice(0, 8)}`;
  let authorName = req.body.author_name;
  let authorBadge = 'Explorer';
  let authorAvatar = req.body.author_avatar;

  if (req.user) {
    const actor = db.findUserById(req.user.id);
    authorName = actor?.display_name || authorName || 'Traveler';
    authorAvatar = actor?.avatar_url || authorAvatar;
    if (actor?.role === 'admin') {
      authorBadge = 'Tourism Officer';
    } else if (actor && actor.demo_points > 100) {
      authorBadge = `Scout • Lvl ${Math.floor(actor.demo_points / 100) + 1}`;
    } else {
      authorBadge = 'Verified Scout';
    }
  } else {
    authorName = authorName || 'Guest Explorer';
    authorBadge = 'Traveler';
  }

  const log = fieldLogStore.create(
    spot.id,
    userId,
    authorName,
    authorBadge,
    req.body.tag,
    req.body.content,
    Boolean(req.body.is_verified_visit),
    req.body.image_url,
    req.body.location_pin,
    authorAvatar
  );

  return res.status(201).json({
    success: true,
    data: log,
  });
});

// POST /spots/:id/comments/:logId/helpful
router.post(['/spots/:id/comments/:logId/helpful', '/spots/:id/field-logs/:logId/helpful'], optionalAuthenticateToken, async (req: AuthRequest, res) => {
  const spot = await spotStore.findByIdentifier(req.params.id, { publishedOnly: true, allowTest: isAuthorizedQA(req) });
  if (!spot) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Destination not found.' } });
  }

  const userId = req.user?.id || (req.headers['x-device-id'] as string) || (req.headers['x-forwarded-for'] as string) || req.ip || 'anon';
  const result = fieldLogStore.toggleHelpful(spot.id, req.params.logId, String(userId));
  if (!result) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field log not found.' } });
  }

  return res.json({
    success: true,
    data: result,
  });
});

// POST /spots/:id/reports
const createReportSchema = z.object({
  body: z.object({
    reason: z.enum(['inaccurate_location', 'site_closed_or_hazard', 'misleading_photo', 'spam_or_scam', 'environmental_concern', 'other']),
    details: z.string().max(500).optional(),
    reporter_name: z.string().max(80).optional(),
  }),
});

router.post('/spots/:id/reports', optionalAuthenticateToken, validateRequest(createReportSchema), async (req: AuthRequest, res) => {
  const spot = await spotStore.findByIdentifier(req.params.id, { publishedOnly: true, allowTest: isAuthorizedQA(req) });
  if (!spot) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Destination not found.' } });
  }

  const userId = req.user?.id;
  const reporterActor = userId ? db.findUserById(userId) : undefined;
  const reporterName = reporterActor?.display_name || req.body.reporter_name || 'Anonymous Scout';

  const report = fieldLogStore.createReport(
    spot.id,
    req.body.reason,
    userId,
    reporterName,
    req.body.details
  );

  return res.status(201).json({
    success: true,
    data: {
      report_id: report.id,
      spot_id: spot.id,
      status: report.status,
      message: 'Report received. LGU Tourism moderators will review this spot within 24 hours.',
    },
  });
});

// GET /admin/spot-reports
router.get('/admin/spot-reports', authenticateToken, requireAdmin, (_req: AuthRequest, res) => {
  return res.json({
    success: true,
    data: fieldLogStore.listReports(),
  });
});

export default router;
