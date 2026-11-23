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
import { resolveSpotAreas } from '../maps/areas-service.js';
import { mapView, searchSpots } from '../spots/national.js';
import { assetStore } from '../spots/asset-store.js';
import { MAX_SPOT_GALLERY_PHOTOS, spotPhotoSubmissionStore } from '../spots/photo-submission-store.js';
import { getSpotPhotoStorageProvider } from '../storage/spot-photos.js';
import { detectValidatedMediaMime } from '../utils/media-mime.js';
import { fieldLogStore, NOTE_REPORT_REASONS } from '../spots/field-logs.js';
import { hiddenGemHighlights } from '../spots/highlights.js';
import { recognizeSpotLocation } from '../spots/recognize.js';
import { sanitizeQuestForViewer } from '../quests/sanitize.js';
import { recordActivity } from '../social/activity.js';
import { notify } from '../social/notify.js';
import { normalizeTasks } from '../quests/taskNormalize.js';
import { questTaskInputSchema, validateTasksWithinDistance } from '../quests/taskValidation.js';
import { assertInScope, loadAdminScope, requireAreaAdmin, spotInScope, writeAdminAudit } from '../admin/scope.js';
import { resolveSpotAuthors, spotRelocationStore, type RelocationStatus } from '../spots/relocations.js';
import { handleSpotInteraction } from '../stamps/hooks.js';
import { getHomeTown } from '../social/homeTown.js';
import { log } from '../utils/logger.js';
import { publishChecklist, publishChecklistError } from '../quests/publishChecklist.js';
import { scheduleNearbyQuestAnnouncement } from '../social/nearbyQuest.js';
import { publishBroadcast } from '../realtime/bus.js';

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

const adminSpotListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  status: z.string().max(40).optional(),
  tier: z.enum(['featured', 'standard', 'review']).optional(),
  area_id: z.string().max(200).optional(),
  q: z.string().trim().max(80).optional(),
  wave: z.string().max(80).optional(),
  confidence_min: z.coerce.number().min(0).max(1).optional(),
  confidence_max: z.coerce.number().min(0).max(1).optional(),
  sort: z.enum(['newest', 'name']).optional(),
});

// Plan 116: page size when the client sends neither limit nor cursor. Every shipped app (v0.3.x
// and v0.4.0) calls GET /spots without paging and builds Explore AND the map from that one list,
// so this must cover a launch region (Region I: 146 public spots) or installed apps lose spots.
// Bounded (≤ CACHED_HEAD); handout 116b moves the app to /spots/map + cursor paging before more
// regions launch, after which this can drop back to 50.
const DEFAULT_SPOT_PAGE = 300;
// Explicit limit= stays capped at 100 per page.
const MAX_SPOT_PAGE = 100;

function encodeSpotCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

function decodeSpotCursor(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !raw || raw.length > 64) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return Number.isInteger(parsed?.o) && parsed.o >= 0 && parsed.o <= 100_000 ? parsed.o : undefined;
  } catch {
    return undefined;
  }
}

/** `west,south,east,north` in degrees; undefined when absent, null when malformed. */
function parseBbox(raw: unknown): [number, number, number, number] | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
  const [west, south, east, north] = parts;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) return null;
  return [west, south, east, north];
}

router.get('/spots', optionalAuthenticateToken, checkQAAuthorization, async (req: AuthRequest, res) => {
  const allowTest = isAuthorizedQA(req);
  if (allowTest) res.set('X-Robots-Tag', 'noindex, nofollow');
  const lat = numeric(req.query.lat),
    lng = numeric(req.query.lng),
    radius = numeric(req.query.radius_km);
  const limit = numeric(req.query.limit);
  // Plan 116: `cursor` (opaque, from meta.next_cursor) or the older numeric `offset`.
  const cursorOffset = decodeSpotCursor(req.query.cursor);
  const offset = cursorOffset ?? numeric(req.query.offset);
  const bbox = parseBbox(req.query.bbox);
  const tier = req.query.tier as string | undefined;
  if (
    (lat !== undefined) !== (lng !== undefined) ||
    [lat, lng, radius, limit, offset].some((v) => v !== undefined && !Number.isFinite(v)) ||
    (req.query.cursor !== undefined && cursorOffset === undefined) ||
    bbox === null ||
    (tier !== undefined && !['featured', 'standard', 'review'].includes(tier))
  ) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Valid lat/lng, radius, bbox (west,south,east,north), tier and cursor values are required.',
      },
    });
  }
  // Plan 116: never return the whole national catalogue. Old clients that send no limit get
  // the first page plus meta.total; new clients page with meta.next_cursor.
  const pageSize =
    limit !== undefined
      ? Math.max(1, Math.min(MAX_SPOT_PAGE, Math.floor(limit)))
      : cursorOffset !== undefined
        ? MAX_SPOT_PAGE
        : DEFAULT_SPOT_PAGE;
  const pageOffset = offset !== undefined ? Math.max(0, Math.floor(offset)) : 0;
  const actorId =
    req.user?.id || (req.headers['x-device-id'] as string) || (req.headers['x-forwarded-for'] as string) || req.ip;
  const homeTown = req.user?.id ? await getHomeTown(req.user.id) : null;
  const page = spotStore.listPage({
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
    bbox: bbox ?? undefined,
    areaId: typeof req.query.area_id === 'string' && req.query.area_id ? req.query.area_id : undefined,
    tier: tier as 'featured' | 'standard' | 'review' | undefined,
    limit: pageSize,
    offset: pageOffset,
  });
  const authors = await resolveSpotAuthors(page.items.map((s) => s.created_by));
  const data = page.items.map((s) => ({
    ...s,
    author: s.created_by ? (authors.get(s.created_by) ?? null) : null,
  }));
  const nextOffset = pageOffset + data.length;
  return res.json({
    success: true,
    data,
    meta: {
      count: data.length,
      total: page.total,
      next_cursor: nextOffset < page.total && data.length > 0 ? encodeSpotCursor(nextOffset) : null,
      sort: req.query.sort || 'recommended',
    },
  });
});

// Plan 116: lightweight map markers for a viewport; grid clusters when a low zoom would
// otherwise return too many points. Registered before /spots/:slug.
const mapQuerySchema = z.object({
  bbox: z.string(),
  zoom: z.coerce.number().min(0).max(22),
  categories: z.string().optional(),
  tier: z.enum(['featured', 'standard', 'review']).optional(),
});
router.get('/spots/map', (req, res) => {
  const parsed = mapQuerySchema.safeParse(req.query);
  const bbox = parsed.success ? parseBbox(parsed.data.bbox) : null;
  if (!parsed.success || !bbox)
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'bbox=west,south,east,north and zoom (0-22) are required.' },
    });
  res.set('Cache-Control', 'public, max-age=60');
  const view = mapView(spotStore.spots, {
    bbox,
    zoom: Math.floor(parsed.data.zoom),
    categories: csv(parsed.data.categories),
    tier: parsed.data.tier,
  });
  return res.json({
    success: true,
    data: { markers: view.markers, clusters: view.clusters },
    meta: { total: view.total },
  });
});

// Plan 116: typeahead destination search (accent-insensitive; trigram typo tolerance on PostgreSQL).
const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(80),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});
router.get('/spots/search', async (req, res) => {
  const parsed = searchQuerySchema.safeParse(req.query);
  if (!parsed.success)
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'q must be 2-80 characters.' },
    });
  res.set('Cache-Control', 'public, max-age=60');
  const data = await searchSpots(getPool(), spotStore.spots, parsed.data.q, parsed.data.limit ?? 10);
  return res.json({ success: true, data, meta: { count: data.length } });
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
  const attached = Array.from(assetStore.assets.values())
    .filter((a) => a.spot_id === spot.id && a.status === 'attached')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  let sponsors: Array<{ name: string; logo: string | null; quest_id: string }> = [];
  if (pool) {
    try {
      const sponsorsResult = await pool
        .query(
          `SELECT DISTINCT ON (s.merchant_id)
             m.name, m.logo_url AS logo, p.quest_id
           FROM quest_sponsorships s
           JOIN quest_funding_plans p ON p.id = s.plan_id
           JOIN quests q ON q.id = p.quest_id
           JOIN merchants m ON m.id = s.merchant_id
           LEFT JOIN reviewed_quest_spot_bindings b
             ON b.quest_id = q.id AND b.spot_id = $1 AND b.status = 'active'
           WHERE s.status = 'accepted'
             AND p.status IN ('active', 'closing')
             AND q.is_active = TRUE
             AND q.status = 'published'
             AND s.is_test = $2 AND p.is_test = $2 AND q.is_test = $2
             AND (
               b.spot_id = $1
               OR q.id = $3
               OR EXISTS (SELECT 1 FROM spots sp2 WHERE sp2.id = $1 AND sp2.quest_id = q.id)
               OR (abs(q.gps_lat - $4) <= 0.0015 AND abs(q.gps_lng - $5) <= 0.0015)
             )
           ORDER BY s.merchant_id, s.created_at, s.id
           LIMIT 20`,
          [spot.id, Boolean(spot.is_test), spot.quest_id || '', Number(spot.gps_lat), Number(spot.gps_lng)],
        )
        .catch(() => ({ rows: [] as any[] }));
      sponsors = sponsorsResult.rows.map((r: any) => ({
        name: String(r.name),
        logo: r.logo ? String(r.logo) : null,
        quest_id: String(r.quest_id),
      }));
    } catch (_) {}
  }
  const moderation =
    req.user?.id &&
    spot.created_by === req.user.id &&
    (spot.status === 'held' || spot.status === 'hidden_pending_review')
      ? buildModerationSummary(spot, await listSpotModerationEvents([spot.id]))
      : {};
  const authorMap = spot.created_by ? await resolveSpotAuthors([spot.created_by]) : null;
  const author = spot.created_by ? (authorMap?.get(spot.created_by) ?? null) : null;
  return res.json({
    success: true,
    data: {
      ...spot,
      author,
      ...spotStore.crowd(spot),
      saved: spotStore.isSaved(actorId, spot.id),
      liked: spotStore.isLiked(actorId, spot.id),
      like_count: spotStore.likeCount(spot.id, actorId),
      trend_score: spotStore.trend(spot.id),
      attached_assets: attached,
      // Plan 116 §6.3: licensed catalog photos with credit; image_url stays the primary w640.
      photos: assetStore.catalogPhotos(spot.id),
      sponsors,
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
    recommendation_suppressed_until: z.string().datetime().nullable().optional(),
    suppress_hours: z.number().min(1).max(168).optional(),
  }),
});
// Read-only list: quiz authors (quests_quizzes) also need their area's destinations for the quiz destination picker.
router.get(
  '/admin/spots',
  authenticateToken,
  requireAreaAdmin(['destinations', 'quests_quizzes']),
  async (req: AuthRequest, res) => {
    const scope = req.adminScope!;
    const spots = spotStore.spots.filter(
      (s) => spotInAdminScope(scope, s) || spotInScope(scope, 'quests_quizzes', s.id),
    );
    const now = Date.now();
    const paged = req.query.limit !== undefined || req.query.cursor !== undefined;
    if (!paged) {
      // Legacy shape (whole list) for the current dashboard; Plan 116 handout 116b moves it to paging.
      return res.json({
        success: true,
        data: spots.map((s) => {
          spotStore.isSuppressed(s, now);
          return { ...s, ...spotStore.crowd(s, now) };
        }),
      });
    }
    const filters = adminSpotListSchema.safeParse(req.query);
    const offset = req.query.cursor !== undefined ? decodeSpotCursor(req.query.cursor) : 0;
    if (!filters.success || offset === undefined)
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid admin destination filters.' },
      });
    const f = filters.data;
    let provenanceIds: Set<string> | null = null;
    if (f.wave || f.confidence_min !== undefined || f.confidence_max !== undefined) {
      const pool = getPool();
      if (!pool)
        return res.status(400).json({
          success: false,
          error: { code: 'UNSUPPORTED_FILTER', message: 'Import filters need the database.' },
        });
      const { rows } = await pool.query(
        `SELECT spot_id FROM spot_provenance
          WHERE ($1::text IS NULL OR import_wave = $1)
            AND ($2::real IS NULL OR import_confidence >= $2)
            AND ($3::real IS NULL OR import_confidence <= $3)`,
        [f.wave ?? null, f.confidence_min ?? null, f.confidence_max ?? null],
      );
      provenanceIds = new Set(rows.map((r: { spot_id: string }) => r.spot_id));
    }
    const needle = f.q ? f.q.toLowerCase() : null;
    const matched = spots
      .filter(
        (s) =>
          (!f.status || s.status === f.status) &&
          (!f.tier || s.launch_tier === f.tier) &&
          (!f.area_id ||
            [s.town_area_id, s.barangay_area_id, s.province_area_id, s.region_area_id].includes(f.area_id)) &&
          (!needle || `${s.name} ${s.municipality}`.toLowerCase().includes(needle)) &&
          (!provenanceIds || provenanceIds.has(s.id)),
      )
      .sort((a, b) =>
        f.sort === 'name'
          ? a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
          : Date.parse(b.created_at) - Date.parse(a.created_at) || a.id.localeCompare(b.id),
      );
    const page = matched.slice(offset, offset + f.limit);
    const next = offset + page.length;
    return res.json({
      success: true,
      data: page.map((s) => {
        spotStore.isSuppressed(s, now);
        return { ...s, ...spotStore.crowd(s, now) };
      }),
      meta: {
        count: page.length,
        total: matched.length,
        next_cursor: next < matched.length && page.length > 0 ? encodeSpotCursor(next) : null,
      },
    });
  },
);
// Plan 118: Pending destination relocation requests (> 200 m moves). Registered before /admin/spots/:id.
router.get(
  '/admin/spots/relocations',
  authenticateToken,
  requireAreaAdmin('destinations'),
  async (req: AuthRequest, res) => {
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const status: RelocationStatus | 'all' =
      rawStatus === 'pending' ||
      rawStatus === 'approved' ||
      rawStatus === 'rejected' ||
      rawStatus === 'cancelled' ||
      rawStatus === 'all'
        ? rawStatus
        : 'pending';
    const allowedSpotIds = new Set(
      spotStore.spots.filter((spot) => spotInAdminScope(req.adminScope!, spot)).map((spot) => spot.id),
    );
    const items = await spotRelocationStore.list({ status, allowedSpotIds });
    return res.json({ success: true, data: items, meta: { count: items.length } });
  },
);

router.post(
  '/admin/spots/relocations/:id/approve',
  authenticateToken,
  requireAreaAdmin('destinations'),
  async (req: AuthRequest, res) => {
    const notFound = () =>
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Relocation request not found.' } });
    const existing = await spotRelocationStore.findById(req.params.id);
    const spot = existing ? spotStore.spots.find((s) => s.id === existing.spot_id) : undefined;
    if (!existing || !spot || !spotInAdminScope(req.adminScope!, spot)) return notFound();
    if (existing.status !== 'pending') {
      return res.status(409).json({
        success: false,
        error: { code: 'ALREADY_REVIEWED', message: `Relocation request is already ${existing.status}.` },
      });
    }

    const beforeCoords = { gps_lat: spot.gps_lat, gps_lng: spot.gps_lng };
    const areaMatch = await resolveSpotAreas(getPool(), existing.to_lat, existing.to_lng, spot.municipality);
    await spotStore.updateSpot(spot.id, {
      gps_lat: existing.to_lat,
      gps_lng: existing.to_lng,
      town_area_id: areaMatch.townAreaId,
      barangay_area_id: areaMatch.barangayAreaId,
      province_area_id: areaMatch.provinceAreaId,
      region_area_id: areaMatch.regionAreaId,
    });

    const updated = await spotRelocationStore.markApproved(existing.id, req.user!.id);
    if (!updated) return notFound();

    await writeAdminAudit({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      areaId: spot.town_area_id ?? null,
      action: 'spot_relocation.approved',
      subjectType: 'spot_relocation_request',
      subjectId: existing.id,
      before: { status: existing.status, ...beforeCoords },
      after: {
        status: updated.status,
        gps_lat: existing.to_lat,
        gps_lng: existing.to_lng,
        distance_m: existing.distance_m,
      },
    });

    const pool = getPool();
    if (pool) {
      try {
        await notify(pool, {
          userId: existing.requested_by,
          kind: 'spot_moderation',
          eventKey: `spot_relocation_approved:${existing.id}`,
          title: 'Destination move approved',
          message: `Your pin relocation for ${spot.name} (${existing.distance_m} m) was approved.`,
          href: `/spots/${spot.slug || spot.id}`,
          isTest: Boolean(spot.is_test),
        });
      } catch (err) {
        log.warn('[spots:approveRelocation] Notification skipped:', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return res.json({ success: true, data: updated });
  },
);

const rejectRelocationSchema = z.object({
  body: z
    .object({
      note: z.string().trim().min(3).max(500),
    })
    .strict(),
});

router.post(
  '/admin/spots/relocations/:id/reject',
  authenticateToken,
  requireAreaAdmin('destinations'),
  validateRequest(rejectRelocationSchema),
  async (req: AuthRequest, res) => {
    const notFound = () =>
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Relocation request not found.' } });
    const existing = await spotRelocationStore.findById(req.params.id);
    const spot = existing ? spotStore.spots.find((s) => s.id === existing.spot_id) : undefined;
    if (!existing || !spot || !spotInAdminScope(req.adminScope!, spot)) return notFound();
    if (existing.status !== 'pending') {
      return res.status(409).json({
        success: false,
        error: { code: 'ALREADY_REVIEWED', message: `Relocation request is already ${existing.status}.` },
      });
    }

    const updated = await spotRelocationStore.markRejected(existing.id, req.user!.id, req.body.note);
    if (!updated) return notFound();

    await writeAdminAudit({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      areaId: spot.town_area_id ?? null,
      action: 'spot_relocation.rejected',
      subjectType: 'spot_relocation_request',
      subjectId: existing.id,
      before: { status: existing.status },
      after: { status: updated.status, review_note: updated.review_note },
    });

    const pool = getPool();
    if (pool) {
      try {
        await notify(pool, {
          userId: existing.requested_by,
          kind: 'spot_moderation',
          eventKey: `spot_relocation_rejected:${existing.id}`,
          title: 'Destination move not approved',
          message: `Your pin relocation for ${spot.name} was rejected: ${req.body.note}`,
          href: `/spots/${spot.slug || spot.id}`,
          isTest: Boolean(spot.is_test),
        });
      } catch (err) {
        log.warn('[spots:rejectRelocation] Notification skipped:', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return res.json({ success: true, data: updated });
  },
);

router.get('/admin/spots/:id', authenticateToken, requireAreaAdmin('destinations'), (req: AuthRequest, res) => {
  const spot = spotStore.spots.find((s) => s.id === req.params.id || s.slug === req.params.id);
  if (!spot || !spotInAdminScope(req.adminScope!, spot))
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Spot not found.' } });
  const now = Date.now();
  spotStore.isSuppressed(spot, now);
  return res.json({ success: true, data: { ...spot, ...spotStore.crowd(spot, now) } });
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
    const suppressed = Boolean(req.body.recommendation_suppressed);
    const suppressedUntil = !suppressed
      ? null
      : typeof req.body.suppress_hours === 'number'
        ? new Date(Date.now() + req.body.suppress_hours * 3_600_000).toISOString()
        : (req.body.recommendation_suppressed_until ?? null);
    const spot = spotStore.review(
      req.params.id,
      req.user!.id,
      req.body.status,
      req.body.crowd_capacity_band,
      suppressed,
      suppressedUntil,
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

const RELOCATION_INSTANT_MAX_M = 200;

const updateContributionSchema = z.object({
  body: contributionSchema.shape.body
    .extend({
      accuracy_m: z.number().min(0).max(50000).nullable().optional(),
    })
    .partial(),
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
    const requestedLat = req.body.gps_lat ?? existing.gps_lat;
    const requestedLng = req.body.gps_lng ?? existing.gps_lng;
    const nextMunicipality = req.body.municipality ?? existing.municipality;

    const coordsChanged =
      (req.body.gps_lat !== undefined || req.body.gps_lng !== undefined) &&
      (requestedLat !== existing.gps_lat || requestedLng !== existing.gps_lng);
    const moveDistanceM = coordsChanged
      ? Math.round(distanceKm(existing.gps_lat, existing.gps_lng, requestedLat, requestedLng) * 1000)
      : 0;
    const needsRelocationReview = coordsChanged && moveDistanceM > RELOCATION_INSTANT_MAX_M;

    const effectiveLat = needsRelocationReview ? existing.gps_lat : requestedLat;
    const effectiveLng = needsRelocationReview ? existing.gps_lng : requestedLng;

    const evaluation = await evaluateSpotSubmission({
      mode: 'edit',
      userId: req.user!.id,
      editingSpotId: existing.id,
      name: nextName,
      description: nextDescription,
      tags: nextTags,
      gps_lat: effectiveLat,
      gps_lng: effectiveLng,
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

    const areaMatch = await resolveSpotAreas(getPool(), effectiveLat, effectiveLng, nextMunicipality);
    const wasPublished = existing.status === 'published';

    const { accuracy_m: accuracyM, gps_lat: _ignoredLat, gps_lng: _ignoredLng, ...nonCoordFields } = req.body;
    const spotPatch = needsRelocationReview
      ? nonCoordFields
      : {
          ...nonCoordFields,
          ...(req.body.gps_lat !== undefined ? { gps_lat: req.body.gps_lat } : {}),
          ...(req.body.gps_lng !== undefined ? { gps_lng: req.body.gps_lng } : {}),
        };

    const updated = await spotStore.updateSpot(existing.id, {
      ...spotPatch,
      status: evaluation.status,
      town_area_id: areaMatch.townAreaId,
      barangay_area_id: areaMatch.barangayAreaId,
      province_area_id: areaMatch.provinceAreaId,
      region_area_id: areaMatch.regionAreaId,
    });

    let pendingRelocation: { id: string; status: 'pending'; distance_m: number } | null = null;
    if (needsRelocationReview) {
      const createdRelocation = await spotRelocationStore.createOrReplacePending({
        spotId: existing.id,
        requestedBy: req.user!.id,
        fromLat: existing.gps_lat,
        fromLng: existing.gps_lng,
        toLat: requestedLat,
        toLng: requestedLng,
        distanceM: moveDistanceM,
        accuracyM: accuracyM ?? null,
      });
      pendingRelocation = {
        id: createdRelocation.id,
        status: 'pending',
        distance_m: createdRelocation.distance_m,
      };
    }

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

    return res.status(pendingRelocation ? 202 : 200).json({
      success: true,
      ...(pendingRelocation ? { relocation: pendingRelocation } : {}),
      data: {
        ...(updated ?? existing),
        ...(pendingRelocation ? { relocation: pendingRelocation } : {}),
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

    // Plan 118 (owner 2026-11-23): only the destination's poster can add quests (including while
    // their destination is still in review). Destinations with no poster take quests from platform
    // admins or in-scope area admins only. Existing quests by other travelers stay live.
    const isDestinationAuthor = Boolean(spot.created_by && spot.created_by === req.user!.id);
    let isAuthorizedAdminForPosterlessSpot = false;
    if (!isDestinationAuthor && !spot.created_by) {
      try {
        const scope = await loadAdminScope(req.user!.id);
        isAuthorizedAdminForPosterlessSpot = spotInAdminScope(scope, spot);
      } catch {
        isAuthorizedAdminForPosterlessSpot = false;
      }
    }
    if (!isDestinationAuthor && !isAuthorizedAdminForPosterlessSpot) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'DESTINATION_OWNER_ONLY',
          message: 'Only the person who posted this destination can add quests to it.',
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
      spot_id: spot.id,
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
    if (questStatus === 'published' && !newQuest.is_test)
      publishBroadcast({
        type: 'quest_published',
        id: newQuest.id,
        title: newQuest.title,
        town: spot.municipality ?? null,
      });
    if (!spot.quest_id) {
      spot.quest_id = newQuest.id;
    }
    if (newQuest.status === 'published') scheduleNearbyQuestAnnouncement(newQuest);

    return res.status(201).json({
      success: true,
      data: newQuest,
      message: 'Quest created successfully and bound to destination.',
    });
  },
);

/** In-memory mode: the destination's first quest, quests created on it, and (legacy) quests by its poster. */
function memoryQuestsForSpot(
  spot: { id: string; quest_id?: string | null; created_by?: string | null },
  allowTest: boolean,
) {
  return db.quests.filter(
    (q) =>
      (q.id === spot.quest_id || q.spot_id === spot.id || (!q.spot_id && q.author_id === spot.created_by)) &&
      (allowTest || !q.is_test),
  );
}

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
      quests = memoryQuestsForSpot(spot, allowTest);
    }
  } else {
    quests = memoryQuestsForSpot(spot, allowTest);
  }

  // Several travelers can write quests for one destination, so draft visibility, marker codes and stats
  // follow the quest's own author (legacy author-less quests fall back to the destination poster).
  const ownsQuest = (q: QuestRow) => Boolean(req.user?.id && (q.author_id ? q.author_id === req.user.id : isAuthor));

  // Filter out drafts or archived for general travelers
  if (!isAdminOrQA) {
    quests = quests.filter((q) => ownsQuest(q) || q.status === 'published' || (!q.status && q.is_active));
  }

  // Sanitize: strip marker_code unless authorized
  const sanitized = quests.map((quest) => {
    const canManage = isAdminOrQA || ownsQuest(quest);
    const canInspectMarker = allowTest || canManage;
    const base = sanitizeQuestForViewer(quest, canInspectMarker);
    if (canManage) {
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

// v0.3.1: the author edits or deletes their note; any other signed-in traveler reports it.
const noteActionLimiter = rateLimit({
  policyId: 'spots:note-actions',
  windowMs: 60_000,
  max: 20,
  keyStrategy: 'actor',
});
const NOTE_ERRORS = {
  NOT_FOUND: [404, 'Note not found.'],
  FORBIDDEN: [403, 'You cannot do that to this note.'],
  ALREADY_REPORTED: [409, 'You already reported this note.'],
} as const;
const sendNoteError = (res: import('express').Response, code: keyof typeof NOTE_ERRORS) =>
  res.status(NOTE_ERRORS[code][0]).json({ success: false, error: { code, message: NOTE_ERRORS[code][1] } });
const findSpotForNote = (id: string) => spotStore.spots.find((s) => s.id === id || s.slug === id);

const updateNoteSchema = z.object({ body: z.object({ content: z.string().trim().min(1).max(1000) }).strict() });
router.patch(
  ['/spots/:id/comments/:logId', '/spots/:id/field-logs/:logId'],
  authenticateToken,
  noteActionLimiter,
  validateRequest(updateNoteSchema),
  (req: AuthRequest, res) => {
    const spot = findSpotForNote(req.params.id);
    if (!spot) return sendNoteError(res, 'NOT_FOUND');
    const result = fieldLogStore.update(spot.id, req.params.logId, req.user!.id, req.body.content);
    if (!result.ok) return sendNoteError(res, result.code);
    return res.json({ success: true, data: result.value });
  },
);

router.delete(
  ['/spots/:id/comments/:logId', '/spots/:id/field-logs/:logId'],
  authenticateToken,
  noteActionLimiter,
  (req: AuthRequest, res) => {
    const spot = findSpotForNote(req.params.id);
    if (!spot) return sendNoteError(res, 'NOT_FOUND');
    const result = fieldLogStore.remove(spot.id, req.params.logId, req.user!.id, req.user!.role === 'admin');
    if (!result.ok) return sendNoteError(res, result.code);
    return res.json({ success: true, data: { id: result.value, deleted: true } });
  },
);

const reportNoteSchema = z.object({
  body: z.object({ reason: z.enum(NOTE_REPORT_REASONS).default('other') }).strict(),
});
router.post(
  ['/spots/:id/comments/:logId/report', '/spots/:id/field-logs/:logId/report'],
  authenticateToken,
  noteActionLimiter,
  validateRequest(reportNoteSchema),
  (req: AuthRequest, res) => {
    const spot = findSpotForNote(req.params.id);
    if (!spot) return sendNoteError(res, 'NOT_FOUND');
    const result = fieldLogStore.reportNote(spot.id, req.params.logId, req.user!.id, req.body.reason);
    if (!result.ok) return sendNoteError(res, result.code);
    return res.status(201).json({ success: true, data: result.value });
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
