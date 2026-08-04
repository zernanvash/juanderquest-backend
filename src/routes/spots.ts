import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authenticateToken, optionalAuthenticateToken, AuthRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { env } from '../config/env.js';
import { spotStore, taxonomy } from '../spots/store.js';
import { assetStore } from '../spots/asset-store.js';
import { getSpotPhotoStorageProvider } from '../storage/spot-photos.js';
import { detectValidatedImageMime } from '../utils/image-mime.js';

const router = Router();
const csv = (value: unknown) => typeof value === 'string' && value ? value.split(',').map(v => v.trim()).filter(Boolean) : [];
const numeric = (value: unknown) => typeof value === 'string' && value !== '' ? Number(value) : undefined;

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 + 1024 }, // Allowed up to 8 MB
});

const uploadRateLimiter = rateLimit({ windowMs: 60 * 1000, max: env.NODE_ENV === 'test' ? 1000 : 20 });

router.get('/spot-taxonomy', (_req, res) => res.json({ success: true, data: {
  categories: taxonomy,
  tags: ['coffee', 'local_food', 'family', 'friends', 'quiet', 'work_friendly', 'scenic', 'running', 'sports', 'hidden_gem', 'free'],
  amenities: ['parking', 'restroom', 'wifi', 'wheelchair_accessible', 'pet_friendly', 'child_friendly'],
} }));

router.get('/spots', optionalAuthenticateToken, (req: AuthRequest, res) => {
  const lat = numeric(req.query.lat), lng = numeric(req.query.lng), radius = numeric(req.query.radius_km);
  if ((lat !== undefined) !== (lng !== undefined) || [lat, lng, radius].some(v => v !== undefined && !Number.isFinite(v))) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Valid lat/lng and radius values are required.' } });
  }
  const data = spotStore.list({ search: req.query.q as string | undefined, categories: csv(req.query.categories), tags: csv(req.query.tags), municipality: req.query.municipality as string | undefined, lat, lng, radius, intent: req.query.intent as string | undefined, sort: req.query.sort as string | undefined, hasQuest: req.query.has_quest === 'true', userId: req.user?.id });
  return res.json({ success: true, data, meta: { count: data.length, sort: req.query.sort || 'recommended' } });
});

router.get('/spots/trending', optionalAuthenticateToken, (req: AuthRequest, res) => res.json({ success: true, data: spotStore.list({ municipality: req.query.municipality as string | undefined, sort: 'trending', userId: req.user?.id }).slice(0, 10) }));

router.get('/spots/:slug', optionalAuthenticateToken, (req: AuthRequest, res) => {
  const spot = spotStore.spots.find(s => s.slug === req.params.slug && s.status === 'published');
  if (!spot) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Spot not found.' } });
  const attached = Array.from(assetStore.assets.values()).filter(a => a.spot_id === spot.id && a.status === 'attached');
  return res.json({ success: true, data: { ...spot, saved: spotStore.isSaved(req.user?.id, spot.id), trend_score: spotStore.trend(spot.id), attached_assets: attached } });
});

router.get('/me/discovery-preferences', authenticateToken, (req: AuthRequest, res) => res.json({ success: true, data: spotStore.getPreferences(req.user!.id) }));
const preferencesSchema = z.object({ body: z.object({ categories: z.array(z.string()).max(10).default([]), tags: z.array(z.string()).max(20).default([]), occasions: z.array(z.string()).max(10).default([]), price_levels: z.array(z.number().int().min(0).max(4)).max(5).default([]), radius_km: z.number().int().min(1).max(200).default(25), onboarding_state: z.enum(['pending', 'completed', 'skipped']).default('completed') }) });
router.put('/me/discovery-preferences', authenticateToken, validateRequest(preferencesSchema), (req: AuthRequest, res) => res.json({ success: true, data: spotStore.setPreferences(req.user!.id, req.body) }));

router.put('/spots/:id/save', authenticateToken, (req: AuthRequest, res) => res.json({ success: true, data: { saved: spotStore.interact(req.user!.id, req.params.id, 'save', true) } }));
router.delete('/spots/:id/save', authenticateToken, (req: AuthRequest, res) => res.json({ success: true, data: { saved: spotStore.interact(req.user!.id, req.params.id, 'save', false) } }));
router.post('/spots/:id/interactions', authenticateToken, validateRequest(z.object({ body: z.object({ type: z.enum(['view', 'directions', 'helpful', 'visit']) }) })), (req: AuthRequest, res) => res.status(201).json({ success: true, data: { recorded: spotStore.interact(req.user!.id, req.params.id, req.body.type, true) } }));

// POST /api/v1/spot-photos - Authenticated photo upload
router.post('/spot-photos', authenticateToken, uploadRateLimiter, (req: AuthRequest, res) => {
  photoUpload.single('photo')(req, res, async (err: any) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          error: { code: 'FILE_TOO_LARGE', message: 'File size exceeds maximum limit of 8 MB.' },
        });
      }
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: err.message || 'File upload failed.' },
      });
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'No photo file provided in request.' },
      });
    }

    if (req.file.size > 8 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        error: { code: 'FILE_TOO_LARGE', message: 'File size exceeds maximum limit of 8 MB.' },
      });
    }

    // Validate actual file signatures / magic bytes
    const detected = detectValidatedImageMime(req.file.buffer);
    if (!detected) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_IMAGE_CONTENT', message: 'File content does not match a valid image signature (JPEG, PNG, WebP).' },
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
      const saveResult = await storageProvider.savePhoto(req.file.buffer, detected.mime, detected.ext);
      const assetRecord = await assetStore.createPendingAsset(req.user!.id, saveResult, storageProvider.name);

      return res.status(201).json({
        success: true,
        data: {
          asset_id: assetRecord.id,
          url: assetRecord.url,
          mime_type: assetRecord.mime_type,
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
});

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

export default router;
