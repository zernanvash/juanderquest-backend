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

const router = Router();
const csv = (value: unknown) => typeof value === 'string' && value ? value.split(',').map(v => v.trim()).filter(Boolean) : [];
const numeric = (value: unknown) => typeof value === 'string' && value !== '' ? Number(value) : undefined;
const validSpotIdentifier = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,179}$/.test(value);
const publicSpot = (identifier: string, allowTest: boolean) =>
  validSpotIdentifier(identifier)
    ? spotStore.spots.find(s => (s.id === identifier || s.slug === identifier) && s.status === 'published' && (allowTest || !s.is_test))
    : undefined;

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

router.get('/spots', optionalAuthenticateToken, checkQAAuthorization, (req: AuthRequest, res) => {
  const allowTest = isAuthorizedQA(req);
  if (allowTest) res.set('X-Robots-Tag', 'noindex, nofollow');
  const lat = numeric(req.query.lat), lng = numeric(req.query.lng), radius = numeric(req.query.radius_km);
  if ((lat !== undefined) !== (lng !== undefined) || [lat, lng, radius].some(v => v !== undefined && !Number.isFinite(v))) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Valid lat/lng and radius values are required.' } });
  }
  const data = spotStore.list({ search: req.query.q as string | undefined, categories: csv(req.query.categories), tags: csv(req.query.tags), municipality: req.query.municipality as string | undefined, lat, lng, radius, intent: req.query.intent as string | undefined, sort: req.query.sort as string | undefined, hasQuest: req.query.has_quest === 'true', userId: req.user?.id, allowTest });
  return res.json({ success: true, data, meta: { count: data.length, sort: req.query.sort || 'recommended' } });
});

router.get('/spots/trending', optionalAuthenticateToken, checkQAAuthorization, (req: AuthRequest, res) => {
  const allowTest = isAuthorizedQA(req);
  if (allowTest) res.set('X-Robots-Tag', 'noindex, nofollow');
  res.json({ success: true, data: spotStore.list({ municipality: req.query.municipality as string | undefined, sort: 'trending', userId: req.user?.id, allowTest }).slice(0, 10) });
});

router.get('/spots/:slug/alternatives', optionalAuthenticateToken, checkQAAuthorization, (req: AuthRequest, res) => {
  const allowTest = isAuthorizedQA(req);
  if (allowTest) res.set('X-Robots-Tag', 'noindex, nofollow');
  const source=publicSpot(req.params.slug,allowTest);
  if(!source)return res.status(404).json({success:false,error:{code:'NOT_FOUND',message:'Spot not found.'}});
  const requested=numeric(req.query.limit);const limit=requested===undefined?3:Math.max(1,Math.min(5,Math.floor(requested)));
  return res.json({success:true,data:spotStore.alternatives(source,req.user?.id,limit),meta:{source_spot_id:source.id,catalog_scope:'pangasinan_alpha',ranking_scope:'catalog_wide',expansion_ready:'philippines',personalized:Boolean(req.user),estimated_not_live:true}});
});

router.get('/spots/:slug', optionalAuthenticateToken, checkQAAuthorization, (req: AuthRequest, res) => {
  const allowTest = isAuthorizedQA(req);
  const spot = publicSpot(req.params.slug, allowTest);
  if (!spot) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Spot not found.' } });
  if (spot.is_test) {
    res.set('X-Robots-Tag', 'noindex, nofollow');
  }
  const attached = Array.from(assetStore.assets.values()).filter(a => a.spot_id === spot.id && a.status === 'attached');
  return res.json({ success: true, data: { ...spot, ...spotStore.crowd(spot), saved: spotStore.isSaved(req.user?.id, spot.id), trend_score: spotStore.trend(spot.id), attached_assets: attached } });
});

router.get('/me/discovery-preferences', authenticateToken, (req: AuthRequest, res) => res.json({ success: true, data: spotStore.getPreferences(req.user!.id) }));
const preferencesSchema = z.object({ body: z.object({ categories: z.array(z.string()).max(10).default([]), tags: z.array(z.string()).max(20).default([]), occasions: z.array(z.string()).max(10).default([]), price_levels: z.array(z.number().int().min(0).max(4)).max(5).default([]), radius_km: z.number().int().min(1).max(200).default(25), onboarding_state: z.enum(['pending', 'completed', 'skipped']).default('completed') }) });
router.put('/me/discovery-preferences', authenticateToken, validateRequest(preferencesSchema), (req: AuthRequest, res) => res.json({ success: true, data: spotStore.setPreferences(req.user!.id, req.body) }));

router.put('/spots/:id/save', authenticateToken, (req: AuthRequest, res) => { const spot=spotStore.spots.find(item=>item.id===req.params.id); const actor=db.findUserById(req.user!.id); if(!actor)return res.status(403).json({success:false,error:{code:'FORBIDDEN',message:'Account is unavailable.'}}); if(spot&&Boolean(spot.is_test)!==Boolean(actor.is_test))return res.status(403).json({success:false,error:{code:'SCOPE_MISMATCH',message:'Fictional alpha posts are read-only for real accounts.'}}); const saved=spotStore.interact(req.user!.id,req.params.id,'save',true);spotStore.recordActivity(req.user!.id,req.params.id,'save');return res.json({success:true,data:{saved}}); });
router.delete('/spots/:id/save', authenticateToken, (req: AuthRequest, res) => res.json({ success: true, data: { saved: spotStore.interact(req.user!.id, req.params.id, 'save', false) } }));
router.post('/spots/:id/interactions', authenticateToken, validateRequest(z.object({ body: z.object({ type: z.enum(['view', 'directions', 'helpful', 'visit']), captured_lat:z.number().min(-90).max(90).optional(), captured_lng:z.number().min(-180).max(180).optional() }) })), (req: AuthRequest, res) => {
  const spot=spotStore.spots.find(item=>item.id===req.params.id);if(!spot)return res.status(404).json({success:false,error:{code:'NOT_FOUND',message:'Spot not found.'}});
  const actor=db.findUserById(req.user!.id);if(!actor)return res.status(403).json({success:false,error:{code:'FORBIDDEN',message:'Account is unavailable.'}});if(Boolean(spot.is_test)!==Boolean(actor.is_test))return res.status(403).json({success:false,error:{code:'SCOPE_MISMATCH',message:'Fictional alpha posts are read-only for real accounts.'}});
  if(req.body.type==='visit'&&(req.body.captured_lat===undefined||req.body.captured_lng===undefined||distanceKm(req.body.captured_lat,req.body.captured_lng,spot.gps_lat,spot.gps_lng)>.25))return res.status(422).json({success:false,error:{code:'VISIT_NOT_VERIFIED',message:'A visit must include coordinates within 250 meters of the destination.'}});
  const recorded=spotStore.interact(req.user!.id,req.params.id,req.body.type,true);if(req.body.type!=='helpful')spotStore.recordActivity(req.user!.id,req.params.id,req.body.type);return res.status(201).json({success:true,data:{recorded}});
});

const spotReviewSchema=z.object({body:z.object({status:z.enum(['published','needs_review','unpublished']),crowd_capacity_band:z.enum(['low','medium','high']),recommendation_suppressed:z.boolean().default(false)})});
router.get('/admin/spots',authenticateToken,requireAdmin,(_req,res)=>res.json({success:true,data:spotStore.spots.map(s=>({...s,...spotStore.crowd(s)}))}));
router.patch('/admin/spots/:id',authenticateToken,requireAdmin,validateRequest(spotReviewSchema),(req:AuthRequest,res)=>{const spot=spotStore.review(req.params.id,req.user!.id,req.body.status,req.body.crowd_capacity_band,req.body.recommendation_suppressed);if(!spot)return res.status(404).json({success:false,error:{code:'NOT_FOUND',message:'Spot not found.'}});return res.json({success:true,data:{...spot,...spotStore.crowd(spot)}});});

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
    gps_lat: z.number().min(15.5).max(16.7),
    gps_lng: z.number().min(119.5).max(121),
    price_level: z.number().int().min(0).max(4).default(0),
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

  const result = spotStore.create(req.body, req.user!.id);
  if (result.duplicate) {
    return res.status(409).json({
      success: false,
      error: { code: 'DUPLICATE_SPOT', message: 'A similar spot already exists within 50 meters.', existing_spot: result.duplicate.slug },
    });
  }

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

  return res.status(201).json({ success: true, data: result.spot });
});

const createAuthorQuestSchema = z.object({
  body: z.object({
    title: z.string().trim().min(5).max(100),
    description: z.string().trim().min(15).max(1000),
    category: z.enum(['eco', 'cultural', 'food_trade']),
    radius_meters: z.number().int().min(50).max(500).default(200),
    reward_points: z.union([z.literal(50), z.literal(75), z.literal(100)]).default(75),
  }),
});

router.post('/spots/:id/quests', authenticateToken, validateRequest(createAuthorQuestSchema), async (req: AuthRequest, res) => {
  const spot = spotStore.spots.find(s => s.id === req.params.id || s.slug === req.params.id);
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

  const newQuest: QuestRow = {
    id: questId,
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
    is_active: true,
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
          base_reward_php, difficulty_factor, geo_multiplier, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
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
          newQuest.base_reward_php,
          newQuest.difficulty_factor,
          newQuest.geo_multiplier,
          newQuest.created_at,
          newQuest.updated_at,
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
  const spot = publicSpot(req.params.id, allowTest) || spotStore.spots.find(s => s.id === req.params.id || s.slug === req.params.id);
  if (!spot) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Spot not found.' } });
  }

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
        created_at: new Date(r.created_at).toISOString(),
        updated_at: new Date(r.updated_at).toISOString(),
      }));
    } catch (e: any) {
      console.warn('[spots:getQuests] PG query fallback:', e.message);
      quests = db.quests.filter(q => (q.id === spot.quest_id) && (allowTest || !q.is_test));
    }
  } else {
    quests = db.quests.filter(q => (q.id === spot.quest_id) && (allowTest || !q.is_test));
  }

  const sanitized = quests.map(({ marker_code, ...quest }) => quest);

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
router.get(['/spots/:id/comments', '/spots/:id/field-logs'], optionalAuthenticateToken, (req: AuthRequest, res) => {
  const spot = spotStore.spots.find(s => s.id === req.params.id || s.slug === req.params.id);
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
    content: z.string().min(3).max(600),
    tag: z.enum(['local_tip', 'gear_alert', 'tide_condition', 'food_find', 'heritage', 'eco_watch', 'general']).default('local_tip'),
    author_name: z.string().max(80).optional(),
    is_verified_visit: z.boolean().optional(),
  }),
});

router.post(['/spots/:id/comments', '/spots/:id/field-logs'], optionalAuthenticateToken, validateRequest(createFieldLogSchema), (req: AuthRequest, res) => {
  const spot = spotStore.spots.find(s => s.id === req.params.id || s.slug === req.params.id);
  if (!spot) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Destination not found.' } });
  }

  const userId = req.user?.id || `guest-${randomUUID().slice(0, 8)}`;
  let authorName = req.body.author_name;
  let authorBadge = 'Explorer';

  if (req.user) {
    const actor = db.findUserById(req.user.id);
    authorName = actor?.display_name || authorName || 'Verified Scout';
    if (actor?.role === 'admin') {
      authorBadge = 'Tourism Officer';
    } else if (actor && actor.demo_points > 100) {
      authorBadge = `Scout • Lvl ${Math.floor(actor.demo_points / 100) + 1}`;
    } else {
      authorBadge = 'Verified Scout';
    }
  } else {
    authorName = authorName || 'Pangasinan Scout';
    authorBadge = 'Guest Explorer';
  }

  const log = fieldLogStore.create(
    spot.id,
    userId,
    authorName,
    authorBadge,
    req.body.tag,
    req.body.content,
    Boolean(req.body.is_verified_visit)
  );

  return res.status(201).json({
    success: true,
    data: log,
  });
});

// POST /spots/:id/comments/:logId/helpful
router.post(['/spots/:id/comments/:logId/helpful', '/spots/:id/field-logs/:logId/helpful'], optionalAuthenticateToken, (req: AuthRequest, res) => {
  const spot = spotStore.spots.find(s => s.id === req.params.id || s.slug === req.params.id);
  if (!spot) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Destination not found.' } });
  }

  const userId = req.user?.id || (req.headers['x-forwarded-for'] as string) || req.ip || 'anon';
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

router.post('/spots/:id/reports', optionalAuthenticateToken, validateRequest(createReportSchema), (req: AuthRequest, res) => {
  const spot = spotStore.spots.find(s => s.id === req.params.id || s.slug === req.params.id);
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
