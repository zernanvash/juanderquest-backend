import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { httpUrl } from '../utils/http-url.js';
import {
  authenticateToken,
  optionalAuthenticateToken,
  AuthRequest,
  isAuthorizedQA,
  checkQAAuthorization,
} from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
import { forwardAsyncRouteErrors } from '../middleware/asyncRoutes.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { env } from '../config/env.js';
import { db, QuestRow } from '../db/index.js';
import { getPool } from '../db/pool.js';
import { randomUUID } from 'crypto';
import { distanceKm, spotStore, taxonomy } from '../spots/store.js';
import {
  applyAdminSpotModeration,
  buildModerationSummary,
  computeReportWeight,
  evaluateSpotSubmission,
  listSpotModerationEvents,
  maybeHideSpotAfterReport,
  reconcileSpotAfterReportResolution,
  recordSpotModerationEvent,
  submitSpotAppeal,
} from '../spots/moderation.js';
import { ensureAreaCache, matchSpotToAreas } from '../maps/areas-service.js';
import { assetStore } from '../spots/asset-store.js';
import { MAX_SPOT_GALLERY_PHOTOS, spotPhotoSubmissionStore } from '../spots/photo-submission-store.js';
import { getSpotPhotoStorageProvider } from '../storage/spot-photos.js';
import { detectValidatedMediaMime } from '../utils/media-mime.js';
import { fieldLogStore } from '../spots/field-logs.js';
import { hiddenGemHighlights } from '../spots/highlights.js';
import { recognizeSpotLocation } from '../spots/recognize.js';
import { sanitizeQuestForViewer } from '../quests/sanitize.js';
import { recordActivity } from '../social/activity.js';
import { notify } from '../social/notify.js';
import { normalizeTasks } from '../quests/taskNormalize.js';
import { questTaskInputSchema, validateTasksWithinDistance } from '../quests/taskValidation.js';
import { assertInScope, requireAreaAdmin, spotInScope, writeAdminAudit } from '../admin/scope.js';
import { handleSpotInteraction } from '../stamps/hooks.js';
import { getHomeTown } from '../social/homeTown.js';
import { log } from '../utils/logger.js';
import { publishChecklist, publishChecklistError } from '../quests/publishChecklist.js';

const router = Router();
const csv = (value: unknown) =>
  typeof value === 'string' && value
    ? value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    : [];
const numeric = (value: unknown) => (typeof value === 'string' && value !== '' ? Number(value) : undefined);
const validSpotIdentifier = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,179}$/.test(value);
const publicSpot = (identifier: string, allowTest: boolean) =>
  validSpotIdentifier(identifier)
    ? spotStore.spots.find(
        (s) => (s.id === identifier || s.slug === identifier) && s.status === 'published' && (allowTest || !s.is_test),
      )
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
const spotInAdminScope = (
  scope: NonNullable<AuthRequest['adminScope']>,
  spot: { town_area_id?: string | null; barangay_area_id?: string | null },
) =>
  assertInScope(scope, 'destinations', spot.town_area_id) ||
  assertInScope(scope, 'destinations', spot.barangay_area_id);

router.get('/spot-taxonomy', (_req, res) =>
  res.json({
    success: true,
    data: {
      categories: taxonomy,
      tags: [
        'coffee',
        'local_food',
        'family',
        'friends',
        'quiet',
        'work_friendly',
        'scenic',
        'running',
        'sports',
        'hidden_gem',
        'free',
      ],
      amenities: ['parking', 'restroom', 'wifi', 'wheelchair_accessible', 'pet_friendly', 'child_friendly'],
    },
  }),
);

router.get('/spots', optionalAuthenticateToken, checkQAAuthorization, async (req: AuthRequest, res) => {
  const allowTest = isAuthorizedQA(req);
  if (allowTest) res.set('X-Robots-Tag', 'noindex, nofollow');
  const lat = numeric(req.query.lat),
    lng = numeric(req.query.lng),
    radius = numeric(req.query.radius_km);
  const limit = numeric(req.query.limit),
    offset = numeric(req.query.offset);
  if (
    (lat !== undefined) !== (lng !== undefined) ||
    [lat, lng, radius, limit, offset].some((v) => v !== undefined && !Number.isFinite(v))
  ) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Valid lat/lng and radius values are required.' },
    });
  }
  const actorId =
    req.user?.id || (req.headers['x-device-id'] as string) || (req.headers['x-forwarded-for'] as string) || req.ip;
  const homeTown = req.user?.id ? await getHomeTown(req.user.id) : null;
  const data = spotStore.list({
    search: req.query.q as string | undefined,
    categories: csv(req.query.categories),
    tags: csv(req.query.tags),
    municipality: req.query.municipality as string | undefined,
    lat,
    lng,
    radius,
    intent: req.query.intent as string | undefined,
    sort: req.query.sort as string | undefined,
    hasQuest: req.query.has_quest === 'true',
    userId: req.user?.id || actorId,
    actorId,
    homeTown,
    allowTest,
    limit: limit !== undefined ? Math.max(1, Math.min(100, Math.floor(limit))) : undefined,
    offset: offset !== undefined ? Math.max(0, Math.floor(offset)) : undefined,
  });
  return res.json({ success: true, data, meta: { count: data.length, sort: req.query.sort || 'recommended' } });
});

router.get('/spots/highlights', optionalAuthenticateToken, (req: AuthRequest, res) => {
  res.set('Cache-Control', 'private, no-store');
  return res.json({
    success: true,
    data: hiddenGemHighlights(spotStore, req.user?.id),
    meta: { algorithm: 'curated_hidden_gems_v1', estimated_not_live: true },
  });
});

router.get('/spots/trending', optionalAuthenticateToken, checkQAAuthorization, (req: AuthRequest, res) => {
  const allowTest = isAuthorizedQA(req);
  if (allowTest) res.set('X-Robots-Tag', 'noindex, nofollow');
  const actorId =
    req.user?.id || (req.headers['x-device-id'] as string) || (req.headers['x-forwarded-for'] as string) || req.ip;
  res.json({
    success: true,
    data: spotStore
      .list({
        municipality: req.query.municipality as string | undefined,
        sort: 'trending',
        userId: actorId,
        allowTest,
      })
      .slice(0, 10),
  });
});

// Plan 66: recognize a map pin (town/barangay, POI name, suggested category/details, story starters,
// nearby duplicates). Registered before /spots/:slug so "recognize" is never read as a slug.
const recognizeQuery = z.object({
  lat: z.coerce.number().min(4.5).max(21.5),
  lng: z.coerce.number().min(116).max(127),
});
const recognizeRateLimiter = rateLimit({
  policyId: 'spots:recognize',
  windowMs: 60 * 1000,
  max: env.NODE_ENV === 'test' ? 1000 : 60,
  keyStrategy: 'actor_or_ip',
});
router.get('/spots/recognize', optionalAuthenticateToken, recognizeRateLimiter, async (req: AuthRequest, res) => {
  const parsed = recognizeQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'lat and lng must be inside the Philippines.' },
    });
  }
  try {
    res.set('Cache-Control', 'private, max-age=300');
    return res.json({ success: true, data: await recognizeSpotLocation(parsed.data.lat, parsed.data.lng, getPool()) });
  } catch (error) {
    log.error('[spots] recognize failed:', { error: error instanceof Error ? error.message : error });
    return res.status(503).json({
      success: false,
      error: { code: 'RECOGNIZE_UNAVAILABLE', message: 'Place recognition is unavailable right now.' },
    });
  }
});

router.get('/spots/:slug/alternatives', optionalAuthenticateToken, checkQAAuthorization, (req: AuthRequest, res) => {
  const allowTest = isAuthorizedQA(req);
  if (allowTest) res.set('X-Robots-Tag', 'noindex, nofollow');
  const source = publicSpot(req.params.slug, allowTest);
  if (!source)
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Spot not found.' } });
  const requested = numeric(req.query.limit);
  const limit = requested === undefined ? 3 : Math.max(1, Math.min(5, Math.floor(requested)));
  const actorId =
    req.user?.id || (req.headers['x-device-id'] as string) || (req.headers['x-forwarded-for'] as string) || req.ip;
  return res.json({
    success: true,
    data: spotStore.alternatives(source, actorId, limit),
    meta: {
      source_spot_id: source.id,
      catalog_scope: 'pangasinan_alpha',
      ranking_scope: 'catalog_wide',
      expansion_ready: 'philippines',
      personalized: Boolean(req.user),
      estimated_not_live: true,
    },
  });
});

router.get('/spots/:slug', optionalAuthenticateToken, checkQAAuthorization, async (req: AuthRequest, res) => {
  const allowTest = isAuthorizedQA(req);
  let spot = publicSpot(req.params.slug, allowTest);
  if (!spot && req.user?.id && validSpotIdentifier(req.params.slug)) {
    const candidate = spotStore.spots.find(
      (s) =>
        (s.id === req.params.slug || s.slug === req.params.slug) &&
        s.created_by === req.user!.id &&
        (s.status === 'held' || s.status === 'hidden_pending_review') &&
        (allowTest || !s.is_test),
    );
    if (candidate) spot = candidate;
  }
  if (!spot) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Spot not found.' } });
  if (spot.is_test) {
    res.set('X-Robots-Tag', 'noindex, nofollow');
  }
  const actorId =
    req.user?.id || (req.headers['x-device-id'] as string) || (req.headers['x-forwarded-for'] as string) || req.ip;
  const pool = getPool();
  const attached = Array.from(assetStore.assets.values()).filter(
    (a) => a.spot_id === spot.id && a.status === 'attached',
  );
  if (pool) {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM spot_assets WHERE spot_id = $1 AND status = 'attached' ORDER BY created_at ASC`,
        [spot.id],
      );
      if (rows.length > 0) {
        const seen = new Set(attached.map((a) => a.id));
        for (const r of rows) {
          if (!seen.has(r.id)) {
            const isVideo = r.mime_type?.startsWith('video/') || r.object_key?.includes('video');
            attached.push({
              ...r,
              media_type: r.media_type || (isVideo ? 'video' : 'image'),
              created_at: new Date(r.created_at).toISOString(),
              updated_at: new Date(r.updated_at).toISOString(),
            });
          }
        }
      }
    } catch (_) {}
  }
  const moderation =
    req.user?.id &&
    spot.created_by === req.user.id &&
    (spot.status === 'held' || spot.status === 'hidden_pending_review')
      ? buildModerationSummary(spot, await listSpotModerationEvents([spot.id]))
      : {};
  return res.json({
    success: true,
    data: {
      ...spot,
      ...spotStore.crowd(spot),
      saved: spotStore.isSaved(actorId, spot.id),
      liked: spotStore.isLiked(actorId, spot.id),
      like_count: spotStore.likeCount(spot.id, actorId),
      trend_score: spotStore.trend(spot.id),
      attached_assets: attached,
      ...moderation,
    },
  });
});

router.get('/me/discovery-preferences', authenticateToken, (req: AuthRequest, res) =>
  res.json({ success: true, data: spotStore.getPreferences(req.user!.id) }),
);
const preferencesSchema = z.object({
  body: z.object({
    categories: z.array(z.string()).max(10).default([]),
    tags: z.array(z.string()).max(20).default([]),
    occasions: z.array(z.string()).max(10).default([]),
    price_levels: z.array(z.number().int().min(0).max(4)).max(5).default([]),
    radius_km: z.number().int().min(1).max(200).default(25),
    onboarding_state: z.enum(['pending', 'completed', 'skipped']).default('completed'),
  }),
});
router.put(
  '/me/discovery-preferences',
  authenticateToken,
  validateRequest(preferencesSchema),
  (req: AuthRequest, res) => res.json({ success: true, data: spotStore.setPreferences(req.user!.id, req.body) }),
);

router.put('/spots/:id/save', authenticateToken, (req: AuthRequest, res) => {
  const spot = spotStore.spots.find((item) => item.id === req.params.id);
  const actor = db.findUserById(req.user!.id);
  if (!actor)
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Account is unavailable.' } });
  if (spot && Boolean(spot.is_test) !== Boolean(actor.is_test))
    return res.status(403).json({
      success: false,
      error: { code: 'SCOPE_MISMATCH', message: 'Fictional alpha posts are read-only for real accounts.' },
    });
  const saved = spotStore.interact(req.user!.id, req.params.id, 'save', true);
  spotStore.recordActivity(req.user!.id, req.params.id, 'save');
  return res.json({ success: true, data: { saved } });
});
router.delete('/spots/:id/save', authenticateToken, (req: AuthRequest, res) =>
  res.json({ success: true, data: { saved: spotStore.interact(req.user!.id, req.params.id, 'save', false) } }),
);

router.put('/spots/:id/like', optionalAuthenticateToken, (req: AuthRequest, res) => {
  const spot = spotStore.spots.find((item) => item.id === req.params.id || item.slug === req.params.id);
  if (!spot) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Spot not found.' } });
  const actorId =
    req.user?.id ||
    (req.headers['x-device-id'] as string) ||
    (req.headers['x-forwarded-for'] as string) ||
    req.ip ||
    'anon';
  spotStore.interact(String(actorId), spot.id, 'like', true);
  return res.json({
    success: true,
    data: { liked: true, spot_id: spot.id, like_count: spotStore.likeCount(spot.id, String(actorId)) },
  });
});

router.delete('/spots/:id/like', optionalAuthenticateToken, (req: AuthRequest, res) => {
  const spot = spotStore.spots.find((item) => item.id === req.params.id || item.slug === req.params.id);
  if (!spot) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Spot not found.' } });
  const actorId =
    req.user?.id ||
    (req.headers['x-device-id'] as string) ||
    (req.headers['x-forwarded-for'] as string) ||
    req.ip ||
    'anon';
  spotStore.interact(String(actorId), spot.id, 'like', false);
  return res.json({
    success: true,
    data: { liked: false, spot_id: spot.id, like_count: spotStore.likeCount(spot.id, String(actorId)) },
  });
});
router.post(
  '/spots/:id/interactions',
  authenticateToken,
  validateRequest(
    z.object({
      body: z.object({
        type: z.enum(['view', 'directions', 'helpful', 'visit']),
        captured_lat: z.number().min(-90).max(90).optional(),
        captured_lng: z.number().min(-180).max(180).optional(),
      }),
    }),
  ),
  async (req: AuthRequest, res) => {
    const spot = spotStore.spots.find((item) => item.id === req.params.id);
    if (!spot)
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Spot not found.' } });
    const actor = db.findUserById(req.user!.id);
    if (!actor)
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Account is unavailable.' } });
    if (Boolean(spot.is_test) !== Boolean(actor.is_test))
      return res.status(403).json({
        success: false,
        error: { code: 'SCOPE_MISMATCH', message: 'Fictional alpha posts are read-only for real accounts.' },
      });
    if (
      req.body.type === 'visit' &&
      (req.body.captured_lat === undefined ||
        req.body.captured_lng === undefined ||
        distanceKm(req.body.captured_lat, req.body.captured_lng, spot.gps_lat, spot.gps_lng) > 0.25)
    )
      return res.status(422).json({
        success: false,
        error: {
          code: 'VISIT_NOT_VERIFIED',
          message: 'A visit must include coordinates within 250 meters of the destination.',
        },
      });
    const recorded = spotStore.interact(req.user!.id, req.params.id, req.body.type, true);
    if (req.body.type !== 'helpful') spotStore.recordActivity(req.user!.id, req.params.id, req.body.type);
    await handleSpotInteraction(getPool(), { userId: req.user!.id, spotId: spot.id, type: req.body.type });
    return res.status(201).json({ success: true, data: { recorded } });
  },
);

const spotReviewSchema = z.object({
  body: z.object({
    status: z.enum(['published', 'needs_review', 'unpublished']),
    crowd_capacity_band: z.enum(['low', 'medium', 'high']),
    recommendation_suppressed: z.boolean().default(false),
  }),
});
// Read-only list: quiz authors (quests_quizzes) also need their area's destinations for the quiz destination picker.
router.get(
  '/admin/spots',
  authenticateToken,
  requireAreaAdmin(['destinations', 'quests_quizzes']),
  (req: AuthRequest, res) => {
    const scope = req.adminScope!;
    const spots = spotStore.spots.filter(
      (s) => spotInAdminScope(scope, s) || spotInScope(scope, 'quests_quizzes', s.id),
    );
    return res.json({ success: true, data: spots.map((s) => ({ ...s, ...spotStore.crowd(s) })) });
  },
);
router.get('/admin/spots/:id', authenticateToken, requireAreaAdmin('destinations'), (req: AuthRequest, res) => {
  const spot = spotStore.spots.find((s) => s.id === req.params.id || s.slug === req.params.id);
  if (!spot || !spotInAdminScope(req.adminScope!, spot))
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Spot not found.' } });
  return res.json({ success: true, data: { ...spot, ...spotStore.crowd(spot) } });
});
router.patch(
  '/admin/spots/:id',
  authenticateToken,
  requireAreaAdmin('destinations'),
  validateRequest(spotReviewSchema),
  async (req: AuthRequest, res) => {
    const before = spotStore.spots.find((s) => s.id === req.params.id);
    if (!before || !spotInAdminScope(req.adminScope!, before))
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Spot not found.' } });
    if (!req.adminScope!.platform && before.created_by === req.user!.id)
      return res.status(403).json({
        success: false,
        error: {
          code: 'SELF_MODERATION_FORBIDDEN',
          message: 'Platform administrator review is required for a destination you created.',
        },
      });
    const spot = spotStore.review(
      req.params.id,
      req.user!.id,
      req.body.status,
      req.body.crowd_capacity_band,
      req.body.recommendation_suppressed,
    );
    if (!spot)
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Spot not found.' } });
    await writeAdminAudit({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      areaId: spot.town_area_id,
      action: 'destination.reviewed',
      subjectType: 'spot',
      subjectId: spot.id,
      before,
      after: spot,
    });
    return res.json({ success: true, data: { ...spot, ...spotStore.crowd(spot) } });
  },
);

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
          error: {
            code: 'FILE_TOO_LARGE',
            message: 'File size exceeds maximum limit of 30 MB for video clips (8 MB for photos).',
          },
        });
      }
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: err.message || 'File upload failed.' },
      });
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const uploadedFile = files?.photo?.[0] || files?.media?.[0] || files?.file?.[0] || req.file;

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
        error: {
          code: 'INVALID_IMAGE_CONTENT',
          message:
            'File content does not match a valid image (JPEG, PNG, WebP) or video (MP4, WebM, QuickTime) signature.',
        },
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
        detected.mediaType,
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

// POST /api/v1/spot-media - Authenticated rich media upload (photos & videos)
router.post('/spot-media', authenticateToken, uploadRateLimiter, handleMediaUpload);

const contributionSchema = z.object({
  body: z.object({
    name: z.string().trim().min(3).max(200),
    description: z.string().trim().min(20).max(2000),
    category: z.enum([
      'eat_drink',
      'nature_outdoors',
      'culture_heritage',
      'activities_wellness',
      'shopping_local',
      'stay',
    ]),
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
      .array(z.enum(['early_morning', 'daytime', 'sunset', 'night', 'weekdays', 'dry_season', 'rainy_season']))
      .max(4)
      .default([]),
    hours: z.record(z.string()).default({}),
    amenities: z.array(z.string()).max(20).default([]),
    // Our own upload route returns a root-relative path (/api/v1/uploads/spot-photos/<file>); accept it as-is.
    image_url: httpUrl()
      .or(z.string().regex(/^\/api\/v1\/uploads\/spot-photos\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/))
      .or(z.literal(''))
      .default(''),
    asset_id: z.string().optional(),
    asset_ids: z.array(z.string()).max(5).optional(),
    quest_id: z.string().optional(),
  }),
});

router.post('/spots', authenticateToken, validateRequest(contributionSchema), async (req: AuthRequest, res) => {
  const assetIds = Array.from(
    new Set([...(req.body.asset_ids || []), ...(req.body.asset_id ? [req.body.asset_id] : [])]),
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

  const evaluation = await evaluateSpotSubmission({
    mode: 'create',
    userId: req.user!.id,
    name: req.body.name,
    description: req.body.description,
    tags: req.body.tags,
    gps_lat: req.body.gps_lat,
    gps_lng: req.body.gps_lng,
  });

  if (evaluation.action === 'reject') {
    if (evaluation.retryAfterSeconds) {
      res.set('Retry-After', String(evaluation.retryAfterSeconds));
    }
    return res.status(evaluation.httpStatus).json({
      success: false,
      error: {
        code: evaluation.code,
        message: evaluation.message,
        ...(evaluation.retryAfterSeconds !== undefined ? { retry_after_seconds: evaluation.retryAfterSeconds } : {}),
        ...(evaluation.retryAt ? { retry_at: evaluation.retryAt } : {}),
        ...(evaluation.existingSpot ? { existing_spot: evaluation.existingSpot } : {}),
      },
    });
  }

  const result = await spotStore.create(req.body, req.user!.id, evaluation.status);

  await recordSpotModerationEvent({
    spotId: result.spot.id,
    actor: 'system',
    decision: evaluation.status,
    reasonCodes: evaluation.reasonCodes,
    details: {
      messages: evaluation.messages,
      ...(evaluation.duplicateSpot ? { duplicate_spot: evaluation.duplicateSpot } : {}),
    },
  });

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
      log.error('[social:producer] Failed to record spot_posted activity:', { error: err });
    }
  }

  return res.status(201).json({
    success: true,
    data: {
      ...result.spot,
      moderation_reasons: evaluation.reasonCodes,
      moderation_messages: evaluation.messages,
      ...(evaluation.duplicateSpot ? { duplicate_spot: evaluation.duplicateSpot } : {}),
      moderation: {
        status: evaluation.status,
        reason_codes: evaluation.reasonCodes,
        messages: evaluation.messages,
        duplicate_spot: evaluation.duplicateSpot ?? null,
      },
    },
  });
});

const updateContributionSchema = z.object({
  body: contributionSchema.shape.body.partial(),
});

router.patch(
  '/spots/:id',
  authenticateToken,
  validateRequest(updateContributionSchema),
  async (req: AuthRequest, res) => {
    const existing = spotStore.spots.find((s) => s.id === req.params.id || s.slug === req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Destination not found.' } });
    }
    if (existing.created_by !== req.user!.id) {
      return res
        .status(403)
        .json({ success: false, error: { code: 'FORBIDDEN', message: 'Only the author can edit this destination.' } });
    }
    if (existing.status === 'hidden_pending_review' || existing.status === 'unpublished') {
      return res.status(403).json({
        success: false,
        error: {
          code: 'SPOT_LOCKED_FOR_REVIEW',
          message: 'Destinations hidden for moderator review cannot be edited directly. Submit an appeal instead.',
        },
      });
    }

    const nextName = req.body.name ?? existing.name;
    const nextDescription = req.body.description ?? existing.description;
    const nextTags = req.body.tags ?? existing.tags;
    const nextLat = req.body.gps_lat ?? existing.gps_lat;
    const nextLng = req.body.gps_lng ?? existing.gps_lng;
    const nextMunicipality = req.body.municipality ?? existing.municipality;

    const evaluation = await evaluateSpotSubmission({
      mode: 'edit',
      userId: req.user!.id,
      editingSpotId: existing.id,
      name: nextName,
      description: nextDescription,
      tags: nextTags,
      gps_lat: nextLat,
      gps_lng: nextLng,
    });

    if (evaluation.action === 'reject') {
      return res.status(evaluation.httpStatus).json({
        success: false,
        error: {
          code: evaluation.code,
          message: evaluation.message,
          ...(evaluation.existingSpot ? { existing_spot: evaluation.existingSpot } : {}),
        },
      });
    }

    await ensureAreaCache(getPool());
    const areaMatch = matchSpotToAreas(nextLat, nextLng, nextMunicipality);
    const wasPublished = existing.status === 'published';

    const updated = await spotStore.updateSpot(existing.id, {
      ...req.body,
      status: evaluation.status,
      town_area_id: areaMatch.townAreaId,
      barangay_area_id: areaMatch.barangayAreaId,
    });

    await recordSpotModerationEvent({
      spotId: existing.id,
      actor: 'system',
      decision: evaluation.status,
      reasonCodes: evaluation.reasonCodes,
      details: {
        edited_by: req.user!.id,
        messages: evaluation.messages,
        ...(evaluation.duplicateSpot ? { duplicate_spot: evaluation.duplicateSpot } : {}),
      },
    });

    if (!wasPublished && evaluation.status === 'published' && !existing.is_test) {
      try {
        await recordActivity(null, {
          eventKey: `spot_posted:${existing.id}`,
          actorId: req.user!.id,
          verb: 'spot_posted',
          subjectType: 'spot',
          subjectId: existing.id,
          subjectTitle: nextName,
          subjectHref: `/spots/${existing.slug || existing.id}`,
          municipality: nextMunicipality || null,
          payload: {},
          isTest: false,
        });
      } catch (err) {
        log.error('[social:producer] Failed to record spot_posted activity on edit:', { error: err });
      }
    }

    return res.json({
      success: true,
      data: {
        ...(updated ?? existing),
        moderation_reasons: evaluation.reasonCodes,
        moderation_messages: evaluation.messages,
        ...(evaluation.duplicateSpot ? { duplicate_spot: evaluation.duplicateSpot } : {}),
        moderation: {
          status: evaluation.status,
          reason_codes: evaluation.reasonCodes,
          messages: evaluation.messages,
          duplicate_spot: evaluation.duplicateSpot ?? null,
        },
      },
    });
  },
);

const createAuthorQuestSchema = z.object({
  body: z.object({
    // Plan 56: drafts save anything; publishing checks publishChecklist().
    title: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000).default(''),
    category: z.enum(['eco', 'cultural', 'food_trade']),
    radius_meters: z.number().int().min(50).max(500).default(200),
    reward_points: z.union([z.literal(50), z.literal(75), z.literal(100)]).default(75),
    status: z.enum(['draft', 'published']).default('published'),
    step_order_mode: z.enum(['sequential', 'any']).default('sequential'),
    tasks: z.array(questTaskInputSchema).max(10).optional(),
    steps: z.array(z.any()).max(10).optional(),
  }),
});

router.post(
  '/spots/:id/quests',
  authenticateToken,
  validateRequest(createAuthorQuestSchema),
  async (req: AuthRequest, res) => {
    const spot = spotStore.spots.find((s) => s.id === req.params.id || s.slug === req.params.id);
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

    const questStatus = env.QUEST_FUNDING_ENABLED ? 'draft' : (req.body.status ?? 'published');
    if (questStatus === 'published') {
      const missing = publishChecklist(req.body);
      if (missing.length) return res.status(400).json(publishChecklistError(missing));
    }
    let rawTasks = req.body.tasks || req.body.steps || [];

    // Backward compatibility: If no tasks/steps are provided by legacy clients, default to destination check-in task
    if (rawTasks.length === 0) {
      rawTasks = [
        {
          step_order: 1,
          title: 'Destination check-in',
          description: 'Visit the destination and verify your location.',
          checkpoint_type: 'location',
          required: true,
          gps_lat: spot.gps_lat,
          gps_lng: spot.gps_lng,
          radius_meters: req.body.radius_meters || 200,
        },
      ];
    }

    // Validate tasks distance from destination spot (Plan 43 §4.6)
    const maxDistanceKm = Number(process.env.QUEST_TASK_MAX_DISTANCE_KM || 5);
    const distanceValidation = validateTasksWithinDistance(rawTasks, spot.gps_lat, spot.gps_lng, maxDistanceKm);
    if (!distanceValidation.valid) {
      return res.status(422).json({
        success: false,
        error: { code: 'TASK_TOO_FAR', message: distanceValidation.error },
      });
    }

    // Normalize tasks into canonical v2 QuestTask[] (server generates keys and marker_code)
    const normalizedTasks = normalizeTasks(rawTasks, spot, { allowClientMarkerCode: false });

    if (questStatus === 'published') {
      if (normalizedTasks.length === 0 || normalizedTasks.length > 10) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Published quests must have between 1 and 10 tasks.' },
        });
      }
      const hasRequired = normalizedTasks.some((t) => t.required);
      if (!hasRequired) {
        return res.status(400).json({
          success: false,
          error: { code: 'NO_REQUIRED_TASKS', message: 'Published quests must have at least one required task.' },
        });
      }
    }

    const sanitizedSlug = spot.slug.replace(/[^a-z0-9_-]/g, '').slice(0, 36);
    const questId = `quest-${sanitizedSlug}-${Date.now().toString(36)}`;
    const markerCode = `JDQ-${randomUUID().slice(0, 8).toUpperCase()}`;
    const nowIso = new Date().toISOString();
    const stepOrderMode = req.body.step_order_mode ?? 'sequential';

    const newQuest: QuestRow = {
      id: questId,
      author_id: req.user!.id,
      status: questStatus,
      version: 1,
      steps: normalizedTasks,
      step_order_mode: stepOrderMode,
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
      marker_image_url:
        spot.image_url ||
        'https://images.unsplash.com/photo-1518509562904-e7ef99cdcc86?auto=format&fit=crop&w=1200&q=80',
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
          author_id, status, version, steps, step_order_mode,
          created_at, updated_at, funding_required
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          step_order_mode = EXCLUDED.step_order_mode,
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
            newQuest.author_id,
            newQuest.status,
            newQuest.version,
            JSON.stringify(newQuest.steps),
            newQuest.step_order_mode,
            newQuest.created_at,
            newQuest.updated_at,
            env.QUEST_FUNDING_ENABLED,
          ],
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
          ],
        );

        if (!spot.quest_id) {
          await pool.query(`UPDATE spots SET quest_id = $1, updated_at = NOW() WHERE id = $2`, [newQuest.id, spot.id]);
        }
      } catch (err: any) {
        log.error('[spots:createQuest] Database persistence error:', { error: err });
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
  },
);

router.get('/spots/:id/quests', optionalAuthenticateToken, checkQAAuthorization, async (req: AuthRequest, res) => {
  const allowTest = isAuthorizedQA(req);
  if (allowTest) res.set('X-Robots-Tag', 'noindex, nofollow');
  const spot =
    publicSpot(req.params.id, allowTest) ||
    spotStore.spots.find((s) => s.id === req.params.id || s.slug === req.params.id);
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
        [spot.id, spot.quest_id || '', allowTest],
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
      log.warn('[spots:getQuests] PG query fallback:', { error: e.message });
      quests = db.quests.filter(
        (q) => (q.id === spot.quest_id || q.author_id === spot.created_by) && (allowTest || !q.is_test),
      );
    }
  } else {
    quests = db.quests.filter(
      (q) => (q.id === spot.quest_id || q.author_id === spot.created_by) && (allowTest || !q.is_test),
    );
  }

  // Filter out drafts or archived for general travelers
  if (!isAuthor && !isAdminOrQA) {
    quests = quests.filter((q) => q.status === 'published' || (!q.status && q.is_active));
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
router.get(['/spots/:id/comments', '/spots/:id/field-logs'], optionalAuthenticateToken, (req: AuthRequest, res) => {
  const spot = spotStore.spots.find((s) => s.id === req.params.id || s.slug === req.params.id);
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
    tag: z
      .enum(['local_tip', 'gear_alert', 'tide_condition', 'food_find', 'heritage', 'eco_watch', 'general'])
      .optional()
      .default('general'),
    author_name: z.string().max(80).optional(),
    author_avatar: z.string().max(2000).optional(),
    image_url: z.string().max(2000000).optional(),
    location_pin: z
      .object({
        name: z.string().min(1).max(100),
        lat: z.number().optional(),
        lng: z.number().optional(),
      })
      .optional(),
    is_verified_visit: z.boolean().optional(),
  }),
});

router.post(
  ['/spots/:id/comments', '/spots/:id/field-logs'],
  optionalAuthenticateToken,
  validateRequest(createFieldLogSchema),
  (req: AuthRequest, res) => {
    const spot = spotStore.spots.find((s) => s.id === req.params.id || s.slug === req.params.id);
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
      authorAvatar,
    );

    return res.status(201).json({
      success: true,
      data: log,
    });
  },
);

// POST /spots/:id/comments/:logId/helpful
router.post(
  ['/spots/:id/comments/:logId/helpful', '/spots/:id/field-logs/:logId/helpful'],
  optionalAuthenticateToken,
  (req: AuthRequest, res) => {
    const spot = spotStore.spots.find((s) => s.id === req.params.id || s.slug === req.params.id);
    if (!spot) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Destination not found.' } });
    }

    const userId =
      req.user?.id ||
      (req.headers['x-device-id'] as string) ||
      (req.headers['x-forwarded-for'] as string) ||
      req.ip ||
      'anon';
    const result = fieldLogStore.toggleHelpful(spot.id, req.params.logId, String(userId));
    if (!result) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field log not found.' } });
    }

    return res.json({
      success: true,
      data: result,
    });
  },
);

// POST /spots/:id/reports
const createReportSchema = z.object({
  body: z.object({
    reason: z.enum([
      'inaccurate_location',
      'site_closed_or_hazard',
      'misleading_photo',
      'spam_or_scam',
      'environmental_concern',
      'other',
    ]),
    details: z.string().max(500).optional(),
    reporter_name: z.string().max(80).optional(),
  }),
});

router.post(
  '/spots/:id/reports',
  optionalAuthenticateToken,
  validateRequest(createReportSchema),
  async (req: AuthRequest, res) => {
    const spot = spotStore.spots.find((s) => s.id === req.params.id || s.slug === req.params.id);
    if (!spot) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Destination not found.' } });
    }

    const userId = req.user?.id;
    const reporterActor = userId ? db.findUserById(userId) : undefined;
    const reporterName = reporterActor?.display_name || req.body.reporter_name || 'Anonymous Scout';
    const weight = await computeReportWeight(spot, userId);

    const report = await fieldLogStore.createReport(
      spot.id,
      req.body.reason,
      userId,
      reporterName,
      req.body.details,
      weight,
    );
    const hideResult = await maybeHideSpotAfterReport(spot);

    return res.status(201).json({
      success: true,
      data: {
        report_id: report.id,
        spot_id: spot.id,
        status: report.status,
        weight,
        spot_hidden: hideResult.hidden,
        message: 'Report received. LGU Tourism moderators will review this spot within 24 hours.',
      },
    });
  },
);

const appealSchema = z.object({
  body: z.object({
    note: z.string().trim().min(5).max(500),
  }),
});

router.post('/spots/:id/appeal', authenticateToken, validateRequest(appealSchema), async (req: AuthRequest, res) => {
  const spot = spotStore.spots.find((s) => s.id === req.params.id || s.slug === req.params.id);
  if (!spot) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Destination not found.' } });
  }
  if (spot.created_by !== req.user!.id) {
    return res
      .status(403)
      .json({ success: false, error: { code: 'FORBIDDEN', message: 'Only the destination author can appeal.' } });
  }
  if (spot.status !== 'held' && spot.status !== 'hidden_pending_review') {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_STATUS', message: 'Only held or auto-hidden destinations can be appealed.' },
    });
  }
  try {
    const event = await submitSpotAppeal(spot, req.user!.id, req.body.note);
    return res.status(201).json({ success: true, data: event });
  } catch (err: any) {
    if (err.code === 'ALREADY_APPEALED') {
      return res.status(409).json({
        success: false,
        error: { code: 'ALREADY_APPEALED', message: err.message },
      });
    }
    throw err;
  }
});

// GET /admin/spot-reports
router.get(
  '/admin/spot-reports',
  authenticateToken,
  requireAreaAdmin('destinations'),
  async (req: AuthRequest, res) => {
    const scopedSpotIds = new Set(
      spotStore.spots.filter((spot) => spotInAdminScope(req.adminScope!, spot)).map((spot) => spot.id),
    );
    return res.json({
      success: true,
      data: (await fieldLogStore.listReports()).filter((report) => scopedSpotIds.has(report.spot_id)),
    });
  },
);

// GET /admin/spot-moderation (Plan 60): flagged destinations (held, auto-hidden, appealed) in admin scope.
router.get(
  '/admin/spot-moderation',
  authenticateToken,
  requireAreaAdmin('destinations'),
  async (req: AuthRequest, res) => {
    const scopedSpots = spotStore.spots.filter((spot) => spotInAdminScope(req.adminScope!, spot));
    const events = await listSpotModerationEvents(scopedSpots.map((s) => s.id));
    const eventsBySpot = new Map<string, typeof events>();
    for (const ev of events) {
      const list = eventsBySpot.get(ev.spot_id) ?? [];
      list.push(ev);
      eventsBySpot.set(ev.spot_id, list);
    }

    const flagged = scopedSpots
      .filter((spot) => {
        if (spot.status === 'held' || spot.status === 'hidden_pending_review') return true;
        const spotEvents = eventsBySpot.get(spot.id) ?? [];
        return spotEvents.some((e) => e.decision === 'appealed') && spot.status !== 'published';
      })
      .map((spot) => {
        const spotEvents = eventsBySpot.get(spot.id) ?? [];
        return {
          ...spot,
          ...buildModerationSummary(spot, spotEvents),
        };
      });

    return res.json({ success: true, data: flagged });
  },
);

const moderateSpotSchema = z.object({
  body: z
    .object({
      action: z.enum(['publish', 'keep_hidden', 'remove']),
      note: z.string().trim().min(5).max(500),
    })
    .strict(),
});

router.post(
  '/admin/spots/:id/moderate',
  authenticateToken,
  requireAreaAdmin('destinations'),
  validateRequest(moderateSpotSchema),
  async (req: AuthRequest, res) => {
    const spot = spotStore.spots.find((s) => s.id === req.params.id || s.slug === req.params.id);
    if (!spot || !spotInAdminScope(req.adminScope!, spot)) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Spot not found.' } });
    }
    if (!req.adminScope!.platform && spot.created_by === req.user!.id) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'SELF_MODERATION_FORBIDDEN',
          message: 'Platform administrator review is required for a destination you created.',
        },
      });
    }
    const beforeStatus = spot.status;
    await applyAdminSpotModeration({
      spot,
      adminId: req.user!.id,
      action: req.body.action,
      note: req.body.note,
    });
    await writeAdminAudit({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      areaId: spot.town_area_id ?? null,
      action: `spot.moderation.${req.body.action}`,
      subjectType: 'spot',
      subjectId: spot.id,
      before: { status: beforeStatus },
      after: { status: spot.status, note: req.body.note },
    });
    const events = await listSpotModerationEvents([spot.id]);
    return res.json({
      success: true,
      data: {
        ...spot,
        ...buildModerationSummary(spot, events),
      },
    });
  },
);

// PATCH /admin/spot-reports/:id (Plan 92b): mark a report reviewed or dismissed, with a note.
const resolveReportSchema = z.object({
  body: z
    .object({
      status: z.enum(['reviewed', 'dismissed']),
      resolution_note: z.string().trim().min(5).max(500),
    })
    .strict(),
});

router.patch(
  '/admin/spot-reports/:id',
  authenticateToken,
  requireAreaAdmin('destinations'),
  validateRequest(resolveReportSchema),
  async (req: AuthRequest, res) => {
    const notFound = () =>
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Report not found.' } });
    const existing = await fieldLogStore.findReport(req.params.id);
    const spot = existing ? spotStore.spots.find((s) => s.id === existing.spot_id) : undefined;
    if (!existing || !spot || !spotInAdminScope(req.adminScope!, spot)) return notFound();
    const updated = await fieldLogStore.resolveReport(existing.id, {
      status: req.body.status,
      resolvedBy: req.user!.id,
      note: req.body.resolution_note,
    });
    if (!updated) return notFound();
    await reconcileSpotAfterReportResolution(spot, req.body.status, req.user!.id, req.body.resolution_note);
    await writeAdminAudit({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      areaId: spot.town_area_id ?? null,
      action: `spot_report.${req.body.status}`,
      subjectType: 'spot_report',
      subjectId: existing.id,
      before: { status: existing.status },
      after: { status: updated.status, resolution_note: updated.resolution_note },
    });
    return res.json({ success: true, data: updated });
  },
);

// Plan 102: Submit an uploaded photo to an existing destination for admin approval.
const submitSpotPhotoSchema = z.object({
  body: z
    .object({
      asset_id: z.string().trim().min(1).max(128),
      caption: z.string().trim().max(240).optional(),
    })
    .strict(),
});

router.post(
  '/spots/:id/photos',
  authenticateToken,
  uploadRateLimiter,
  validateRequest(submitSpotPhotoSchema),
  async (req: AuthRequest, res) => {
    const spot = spotStore.spots.find((s) => s.id === req.params.id || s.slug === req.params.id);
    if (!spot) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Destination not found.' } });
    }

    const pool = getPool();
    const asset = await assetStore.resolveAssetById(req.body.asset_id, pool);
    if (!asset || asset.status === 'deleted') {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Asset ${req.body.asset_id} not found.` },
      });
    }
    if (asset.user_id !== req.user!.id) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED_ATTACHMENT', message: 'Cannot submit a photo owned by another user.' },
      });
    }
    if (asset.media_type === 'video' || asset.mime_type.startsWith('video/')) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Only photo uploads can be added to a destination.' },
      });
    }

    try {
      const submission = await spotPhotoSubmissionStore.create({
        spotId: spot.id,
        userId: req.user!.id,
        assetId: asset.id,
        caption: req.body.caption,
      });
      return res.status(201).json({
        success: true,
        data: submission,
        message: 'Photo sent for admin review.',
      });
    } catch (e: any) {
      if (e.code === 'DUPLICATE_PENDING') {
        return res.status(409).json({
          success: false,
          error: { code: 'DUPLICATE_PENDING', message: e.message },
        });
      }
      if (e.code === 'MAX_PENDING_REACHED') {
        return res.status(429).json({
          success: false,
          error: { code: 'MAX_PENDING_REACHED', message: e.message },
        });
      }
      throw e;
    }
  },
);

// GET /admin/spot-photos?status=pending|approved|rejected|all
router.get('/admin/spot-photos', authenticateToken, requireAreaAdmin('destinations'), async (req: AuthRequest, res) => {
  const rawStatus = typeof req.query.status === 'string' ? req.query.status : 'pending';
  const status =
    rawStatus === 'pending' || rawStatus === 'approved' || rawStatus === 'rejected' || rawStatus === 'all'
      ? rawStatus
      : 'pending';
  const allowedSpotIds = new Set(
    spotStore.spots.filter((spot) => spotInAdminScope(req.adminScope!, spot)).map((spot) => spot.id),
  );
  const items = await spotPhotoSubmissionStore.list({ status, allowedSpotIds });
  return res.json({ success: true, data: items });
});

// POST /admin/spot-photos/:id/approve
router.post(
  '/admin/spot-photos/:id/approve',
  authenticateToken,
  requireAreaAdmin('destinations'),
  async (req: AuthRequest, res) => {
    const notFound = () =>
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Photo submission not found.' } });

    const existing = await spotPhotoSubmissionStore.findById(req.params.id);
    const spot = existing ? spotStore.spots.find((s) => s.id === existing.spot_id) : undefined;
    if (!existing || !spot || !spotInAdminScope(req.adminScope!, spot)) return notFound();
    if (existing.status !== 'pending') {
      return res.status(409).json({
        success: false,
        error: { code: 'ALREADY_REVIEWED', message: `Photo submission is already ${existing.status}.` },
      });
    }

    const pool = getPool();
    const attachedCount = await spotPhotoSubmissionStore.countAttachedForSpot(spot.id);
    if (attachedCount >= MAX_SPOT_GALLERY_PHOTOS) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'MAX_IMAGES_EXCEEDED',
          message: `This destination already has ${MAX_SPOT_GALLERY_PHOTOS} attached photos.`,
        },
      });
    }

    const asset = await assetStore.resolveAssetById(existing.asset_id, pool);
    if (!asset || asset.status === 'deleted') {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Uploaded photo asset could not be found.' },
      });
    }

    await assetStore.attachAssetsToSpot([existing.asset_id], existing.user_id, spot.id, pool);
    if (!spot.image_url) {
      spot.image_url = asset.url;
    }

    const updated = await spotPhotoSubmissionStore.markApproved(existing.id, req.user!.id);
    if (!updated) return notFound();

    await writeAdminAudit({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      areaId: spot.town_area_id ?? null,
      action: 'spot_photo.approved',
      subjectType: 'spot_photo_submission',
      subjectId: existing.id,
      before: { status: existing.status },
      after: { status: updated.status, asset_id: existing.asset_id, spot_id: spot.id },
    });

    if (pool) {
      try {
        await notify(pool, {
          userId: existing.user_id,
          kind: 'spot_photo_approved',
          eventKey: `spot_photo_approved:${existing.id}`,
          title: 'Photo approved',
          message: `Your photo of ${spot.name} is live`,
          href: `/explore/${spot.slug || spot.id}`,
          isTest: Boolean(spot.is_test),
        });
      } catch (err) {
        log.warn('[spots:approvePhoto] Notification skipped:', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return res.json({ success: true, data: updated });
  },
);

// POST /admin/spot-photos/:id/reject
const rejectSpotPhotoSchema = z.object({
  body: z
    .object({
      reason: z.string().trim().min(3).max(500),
    })
    .strict(),
});

router.post(
  '/admin/spot-photos/:id/reject',
  authenticateToken,
  requireAreaAdmin('destinations'),
  validateRequest(rejectSpotPhotoSchema),
  async (req: AuthRequest, res) => {
    const notFound = () =>
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Photo submission not found.' } });

    const existing = await spotPhotoSubmissionStore.findById(req.params.id);
    const spot = existing ? spotStore.spots.find((s) => s.id === existing.spot_id) : undefined;
    if (!existing || !spot || !spotInAdminScope(req.adminScope!, spot)) return notFound();
    if (existing.status !== 'pending') {
      return res.status(409).json({
        success: false,
        error: { code: 'ALREADY_REVIEWED', message: `Photo submission is already ${existing.status}.` },
      });
    }

    const updated = await spotPhotoSubmissionStore.markRejected(existing.id, req.user!.id, req.body.reason);
    if (!updated) return notFound();

    await writeAdminAudit({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      areaId: spot.town_area_id ?? null,
      action: 'spot_photo.rejected',
      subjectType: 'spot_photo_submission',
      subjectId: existing.id,
      before: { status: existing.status },
      after: { status: updated.status, reject_reason: updated.reject_reason },
    });

    return res.json({ success: true, data: updated });
  },
);
forwardAsyncRouteErrors(router);

export default router;
