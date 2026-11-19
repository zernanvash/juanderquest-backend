import { Router, Response } from 'express';
import { z } from 'zod';
import { db, InvalidCursorError } from '../db/index.js';
import { getPool } from '../db/pool.js';
import {
  authenticateToken,
  requireAdmin,
  AuthRequest,
  optionalAuthenticateToken,
  isAuthorizedQA,
  checkQAAuthorization,
  authorizeQAPreview,
} from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { notify } from '../social/notify.js';
import { manilaHour } from '../social/time.js';
import { safeCosmeticsFor } from '../shop/render.js';
import { forwardAsyncRouteErrors } from '../middleware/asyncRoutes.js';
import { spotStore, Spot } from '../spots/store.js';
import { buildModerationSummary, listSpotModerationEvents } from '../spots/moderation.js';
import { log } from '../utils/logger.js';
import multer from 'multer';
import { detectValidatedMediaMime } from '../utils/media-mime.js';
import { getSpotPhotoStorageProvider } from '../storage/spot-photos.js';

export const usersRouter = Router();

usersRouter.get(
  '/qa/capabilities',
  (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  },
  authenticateToken,
  authorizeQAPreview,
  (_req, res) => {
    res.json({ success: true, data: { can_preview_test_data: true, scope: 'public-test-read' } });
  },
);

const publicProfileLimiter = rateLimit({
  policyId: 'users:public-profile',
  windowMs: 60 * 1000,
  max: 120,
  keyStrategy: 'ip',
});
const followLimiter = rateLimit({
  policyId: 'users:follow-mutation',
  windowMs: 60 * 1000,
  max: 30,
  keyStrategy: 'actor',
  coarseIpMax: 150,
});

// ==========================================
// 1. Literal Routes (Must precede /users/:id)
// ==========================================

// GET /users?limit=3 â€” Public discovery rail (default 3, max 6)
usersRouter.get('/users', optionalAuthenticateToken, checkQAAuthorization, async (req: AuthRequest, res: Response) => {
  res.set('Cache-Control', 'no-store');
  const allowTest = isAuthorizedQA(req);
  if (allowTest) res.set('X-Robots-Tag', 'noindex, nofollow');
  const rawLimit = req.query.limit;
  const parsedLimit = rawLimit ? parseInt(rawLimit as string, 10) : 3;
  const limit = Math.min(6, Math.max(1, isNaN(parsedLimit) ? 3 : parsedLimit));
  const items = await db.listPublicUsers(limit, allowTest);
  const cosmetics = await safeCosmeticsFor(items.map((item: any) => item.id));
  return res.status(200).json({
    success: true,
    data: {
      items: items.map((item: any) => ({
        ...item,
        cosmetics: cosmetics.get(item.id) ?? { banner: null, frame: null, title: null, nameColor: null },
      })),
      users: items.map((item: any) => ({
        ...item,
        cosmetics: cosmetics.get(item.id) ?? { banner: null, frame: null, title: null, nameColor: null },
      })),
    },
  });
});

// GET /users/me/profile â€” Authenticated self profile and settings
usersRouter.get('/users/me/profile', authenticateToken, async (req: AuthRequest, res: Response) => {
  res.set('Cache-Control', 'private, no-store');
  const userId = req.user!.id;
  const user = (await db.findUserByIdDurable(userId)) || db.findUserById(userId);
  if (!user) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'User not found.' },
    });
  }

  const counts = await db.getFollowCounts(user.id, true);
  const cosmetics = (await safeCosmeticsFor([user.id])).get(user.id);
  return res.status(200).json({
    success: true,
    data: {
      id: user.id,
      display_name: user.display_name,
      email: user.email,
      handle: user.handle || null,
      avatar_url: user.avatar_url,
      bio: user.bio || null,
      status_text: user.status_text || null,
      scout_reputation: user.scout_reputation ?? 0,
      is_public: Boolean(user.is_public),
      follower_count: counts.follower_count,
      following_count: counts.following_count,
      created_at: user.created_at,
      updated_at: user.updated_at,
      cosmetics: cosmetics ?? { banner: null, frame: null, title: null, nameColor: null },
    },
  });
});

const updateProfileSchema = z.object({
  body: z.object({
    display_name: z.string().min(2).max(100).optional(),
    is_public: z.boolean().optional(),
    handle: z
      .string()
      .trim()
      .min(2, 'Handle must be at least 2 characters')
      .max(30, 'Handle must be at most 30 characters')
      .regex(/^[a-zA-Z0-9_]+$/, 'Handle can only contain letters, numbers, and underscores')
      .transform((val) => val.toLowerCase())
      .nullable()
      .optional(),
    bio: z.string().max(300, 'Bio cannot exceed 300 characters').nullable().optional(),
    status_text: z.string().max(120, 'Status text cannot exceed 120 characters').nullable().optional(),
  }),
});

// PATCH /users/me/profile â€” Update Authenticated User's Profile / Privacy Settings
usersRouter.patch(
  '/users/me/profile',
  authenticateToken,
  validateRequest(updateProfileSchema),
  async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { display_name, is_public, handle, bio, status_text } = req.body;

    try {
      const updated = await db.updateUserProfile(userId, {
        display_name,
        is_public,
        handle,
        bio,
        status_text,
      });

      if (!updated) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'User not found.' },
        });
      }

      res.set('Cache-Control', 'private, no-store');
      const counts = await db.getFollowCounts(updated.id, true);
      return res.status(200).json({
        success: true,
        data: {
          id: updated.id,
          display_name: updated.display_name,
          email: updated.email,
          handle: updated.handle || null,
          avatar_url: updated.avatar_url,
          bio: updated.bio || null,
          status_text: updated.status_text || null,
          scout_reputation: updated.scout_reputation ?? 0,
          is_public: updated.is_public,
          follower_count: counts.follower_count,
          following_count: counts.following_count,
          updated_at: updated.updated_at,
        },
      });
    } catch (err: any) {
      if (err?.code === 'HANDLE_TAKEN') {
        return res.status(409).json({
          success: false,
          error: { code: 'HANDLE_TAKEN', message: 'This handle is already in use by another traveler.' },
        });
      }
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update profile.' },
      });
    }
  },
);

// v0.3.10 (team review): profile picture. Same rules as spot photos: JPEG/PNG/WebP checked
// by magic bytes, 8 MB cap, stored by the spot-photo storage provider. Applied immediately
// (no review queue: that would need a column); reports go through the usual channels.
const AVATAR_MAX_BYTES = 8 * 1024 * 1024;
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: AVATAR_MAX_BYTES } });
const avatarLimiter = rateLimit({
  policyId: 'users:avatar',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 10,
  keyStrategy: 'actor',
});
const defaultAvatar = (seed: string) => `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(seed)}`;

// PUT /users/me/avatar (multipart field `photo`) - set your profile picture
usersRouter.put('/users/me/avatar', authenticateToken, avatarLimiter, (req: AuthRequest, res: Response) => {
  avatarUpload.single('photo')(req, res, async (err: any) => {
    if (err) {
      const tooLarge = err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({
        success: false,
        error: {
          code: tooLarge ? 'FILE_TOO_LARGE' : 'VALIDATION_ERROR',
          message: tooLarge ? 'Photo file size exceeds maximum limit of 8 MB.' : err.message || 'Upload failed.',
        },
      });
    }
    const file = req.file;
    if (!file?.buffer) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'No photo provided in request.' },
      });
    }
    const detected = detectValidatedMediaMime(file.buffer);
    if (!detected || detected.mediaType !== 'image') {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_IMAGE_CONTENT', message: 'Profile picture must be a JPEG, PNG or WebP image.' },
      });
    }
    try {
      const saved = await getSpotPhotoStorageProvider().savePhoto(file.buffer, detected.mime, detected.ext, 'image');
      const updated = await db.updateUserProfile(req.user!.id, { avatar_url: saved.url });
      if (!updated) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found.' } });
      }
      res.set('Cache-Control', 'private, no-store');
      return res.status(200).json({ success: true, data: { avatar_url: updated.avatar_url } });
    } catch (e: any) {
      log.error('avatar upload failed', { error: e?.message });
      return res.status(500).json({
        success: false,
        error: { code: 'UPLOAD_FAILED', message: 'Could not save your profile picture.' },
      });
    }
  });
});

/** Back to the default identicon (own DELETE and the admin Reset share this). */
async function resetAvatar(userId: string) {
  const user = (await db.findUserByIdDurable(userId)) || db.findUserById(userId);
  if (!user) return undefined;
  return db.updateUserProfile(user.id, { avatar_url: defaultAvatar(user.seed_id || user.id) });
}

/** A real picture someone chose (not empty, not the default DiceBear identicon). */
const isCustomAvatar = (url: string | null | undefined) =>
  Boolean(url && url.trim() && !/^https:\/\/api\.dicebear\.com\//.test(url.trim()));

// DELETE /users/me/avatar - back to the default avatar
usersRouter.delete('/users/me/avatar', authenticateToken, avatarLimiter, async (req: AuthRequest, res: Response) => {
  const updated = await resetAvatar(req.user!.id);
  if (!updated) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found.' } });
  }
  res.set('Cache-Control', 'private, no-store');
  return res.status(200).json({ success: true, data: { avatar_url: updated.avatar_url ?? '' } });
});

// v0.3.10 (owner): uploads stay instant; viewers can report a picture and admins reset or dismiss.
const avatarReportSchema = z.object({
  body: z.object({ reason: z.enum(['inappropriate', 'impersonation', 'spam', 'other']) }),
});

// POST /users/:id/avatar/report - report another explorer's profile picture (id or handle)
usersRouter.post(
  '/users/:id/avatar/report',
  authenticateToken,
  avatarLimiter,
  validateRequest(avatarReportSchema),
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) {
      return res
        .status(503)
        .json({ success: false, error: { code: 'UNAVAILABLE', message: 'Reports are unavailable right now.' } });
    }
    const raw = String(req.params.id || '').trim();
    const target =
      (await db.findPublicUserById(raw, false)) || (await db.findPublicUserByHandle(raw.replace(/^@/, ''), false));
    if (!target) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found.' } });
    }
    if (target.id === req.user!.id) {
      return res.status(400).json({
        success: false,
        error: { code: 'CANNOT_REPORT_SELF', message: 'You cannot report your own picture.' },
      });
    }
    if (!isCustomAvatar(target.avatar_url)) {
      return res
        .status(400)
        .json({ success: false, error: { code: 'NO_PICTURE', message: 'This explorer has no profile picture.' } });
    }
    const inserted = await pool.query(
      `INSERT INTO avatar_reports (avatar_url, user_id, reporter_id, reason)
       VALUES ($1, $2, $3, $4) ON CONFLICT (avatar_url, reporter_id) DO NOTHING`,
      [target.avatar_url, target.id, req.user!.id, req.body.reason],
    );
    if (!inserted.rowCount) {
      return res.status(409).json({
        success: false,
        error: { code: 'ALREADY_REPORTED', message: 'You already reported this picture.' },
      });
    }
    return res.status(201).json({ success: true, data: { reported: true } });
  },
);

// GET /admin/avatar-reports - open reports grouped by picture (admin)
usersRouter.get('/admin/avatar-reports', authenticateToken, requireAdmin, async (_req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return res.json({ success: true, data: { items: [] } });
  const { rows } = await pool.query(
    `SELECT r.user_id, r.avatar_url, u.display_name, u.handle,
            COUNT(*)::int AS report_count, array_agg(DISTINCT r.reason) AS reasons,
            MIN(r.created_at) AS first_reported_at,
            (u.avatar_url = r.avatar_url) AS is_current
       FROM avatar_reports r JOIN users u ON u.id = r.user_id
      WHERE r.status = 'pending'
      GROUP BY r.user_id, r.avatar_url, u.display_name, u.handle, u.avatar_url
      ORDER BY report_count DESC, first_reported_at ASC
      LIMIT 200`,
  );
  res.set('Cache-Control', 'private, no-store');
  return res.json({ success: true, data: { items: rows } });
});

const resolveAvatarReportSchema = z.object({ body: z.object({ action: z.enum(['reset', 'dismiss']) }) });

// POST /admin/avatar-reports/:userId/resolve - reset the picture or dismiss its reports (admin)
usersRouter.post(
  '/admin/avatar-reports/:userId/resolve',
  authenticateToken,
  requireAdmin,
  validateRequest(resolveAvatarReportSchema),
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) {
      return res
        .status(503)
        .json({ success: false, error: { code: 'UNAVAILABLE', message: 'Reports are unavailable right now.' } });
    }
    const userId = String(req.params.userId);
    const reset = req.body.action === 'reset';
    let avatarUrl: string | undefined;
    if (reset) {
      const updated = await resetAvatar(userId);
      if (!updated) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found.' } });
      }
      avatarUrl = updated.avatar_url;
    }
    const { rowCount } = await pool.query(
      `UPDATE avatar_reports SET status = $2, resolved_by = $3, resolved_at = NOW()
        WHERE user_id = $1 AND status = 'pending'`,
      [userId, reset ? 'reset' : 'dismissed', req.user!.id],
    );
    return res.json({ success: true, data: { resolved: rowCount ?? 0, avatar_url: avatarUrl } });
  },
);

// Owner-only access never changes public visibility or exposes private followers.
usersRouter.get(
  '/users/me/followers',
  authenticateToken,
  publicProfileLimiter,
  async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'private, no-store');
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Limit must be an integer from 1 to 50.' },
      });
    }
    try {
      const result = await db.listFollowers(
        req.user!.id,
        limit,
        typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
        true,
      );
      if (!result)
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Account unavailable.' } });
      return res.json({ success: true, data: result });
    } catch (err) {
      const invalid = err instanceof InvalidCursorError;
      return res.status(invalid ? 400 : 500).json({
        success: false,
        error: {
          code: invalid ? 'INVALID_CURSOR' : 'INTERNAL_ERROR',
          message: invalid ? 'Invalid pagination cursor.' : 'Unable to load followers.',
        },
      });
    }
  },
);

// GET /users/me/following â€” Authenticated cleanup of retained outgoing edges
usersRouter.get('/users/me/following', authenticateToken, async (req: AuthRequest, res: Response) => {
  res.set('Cache-Control', 'private, no-store');
  const userId = req.user!.id;
  const rawLimit = req.query.limit;
  const parsedLimit = rawLimit ? parseInt(rawLimit as string, 10) : 20;
  const limit = Math.min(50, Math.max(1, isNaN(parsedLimit) ? 20 : parsedLimit));
  const cursor = typeof req.query.cursor === 'string' && req.query.cursor.trim() ? req.query.cursor.trim() : undefined;

  try {
    const result = await db.listMyFollowing(userId, limit, cursor);
    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err: any) {
    if (err instanceof InvalidCursorError || err?.name === 'InvalidCursorError') {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_CURSOR', message: 'Invalid or mismatched pagination cursor.' },
      });
    }
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list following.' },
    });
  }
});

// ==========================================
// 2. Parameterized Routes (/users/:id/...)
// ==========================================

// GET /users/:handle/spots — Published destinations created by a traveler
usersRouter.get(
  '/users/:handle/spots',
  publicProfileLimiter,
  optionalAuthenticateToken,
  checkQAAuthorization,
  async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const allowTest = isAuthorizedQA(req);
    if (allowTest) res.set('X-Robots-Tag', 'noindex, nofollow');

    const rawHandle = req.params.handle;
    if (!rawHandle || rawHandle.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Handle is required.' },
      });
    }

    const trimmed = rawHandle.trim();
    const clean = trimmed.replace(/^@/, '').toLowerCase();

    // Allow user to view their own spots if authenticated
    let user = req.user ? (await db.findUserByIdDurable(req.user.id)) || db.findUserById(req.user.id) : undefined;
    if (user && user.id !== trimmed && user.handle?.toLowerCase() !== clean) {
      user = undefined;
    }

    if (!user) {
      user = await db.findPublicUserByHandle(clean, allowTest);
    }
    if (!user && (trimmed.includes('-') || trimmed.length === 36)) {
      user = await db.findPublicUserById(trimmed, allowTest);
    }
    if (!user) {
      user = await db.findUserByIdDurable(trimmed);
      if (user && !user.is_public && (!req.user || req.user.id !== user.id)) {
        user = undefined;
      }
      if (user && user.is_test && !allowTest) {
        user = undefined;
      }
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: 'User not found.' },
      });
    }

    let limit = 20;
    if (req.query.limit !== undefined) {
      const parsedLimit = parseInt(req.query.limit as string, 10);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Limit must be an integer between 1 and 50.' },
        });
      }
      limit = parsedLimit;
    }

    let offset = 0;
    if (req.query.offset !== undefined) {
      const parsedOffset = parseInt(req.query.offset as string, 10);
      if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Offset must be a non-negative integer.' },
        });
      }
      offset = parsedOffset;
    } else if (req.query.cursor !== undefined && typeof req.query.cursor === 'string') {
      const rawCursor = req.query.cursor.trim();
      const direct = parseInt(rawCursor, 10);
      if (!isNaN(direct) && direct >= 0) {
        offset = direct;
      } else {
        try {
          const decoded = Buffer.from(rawCursor, 'base64').toString('utf8');
          const decodedNum = parseInt(decoded, 10);
          if (!isNaN(decodedNum) && decodedNum >= 0) {
            offset = decodedNum;
          }
        } catch {
          // ignore invalid cursor format, default to offset 0
        }
      }
    }

    const isOwner = Boolean(req.user?.id && req.user.id === user.id);
    const allowedStatuses = isOwner ? ['published', 'held', 'hidden_pending_review'] : ['published'];
    const allowedStatusSet = new Set(allowedStatuses);

    const pool = getPool();
    let allSpots: Spot[] = [];
    if (pool) {
      try {
        const { rows } = await pool.query(
          `SELECT * FROM spots
           WHERE created_by = $1
             AND status = ANY($2)
             AND ($3 = TRUE OR COALESCE(is_test, FALSE) = FALSE)
           ORDER BY created_at DESC, id DESC`,
          [user.id, allowedStatuses, allowTest],
        );
        const rowIds = new Set(rows.map((r: any) => r.id));
        const memSpots = spotStore.spots.filter(
          (s) =>
            s.created_by === user.id &&
            allowedStatusSet.has(s.status) &&
            (allowTest || !s.is_test) &&
            !rowIds.has(s.id),
        );
        const mappedRows: Spot[] = rows.map((r: any) => ({
          ...r,
          tags: Array.isArray(r.tags) ? r.tags : typeof r.tags === 'string' ? JSON.parse(r.tags) : [],
          amenities: Array.isArray(r.amenities)
            ? r.amenities
            : typeof r.amenities === 'string'
              ? JSON.parse(r.amenities)
              : [],
          good_for: Array.isArray(r.good_for)
            ? r.good_for
            : typeof r.good_for === 'string'
              ? JSON.parse(r.good_for)
              : [],
          best_time: Array.isArray(r.best_time)
            ? r.best_time
            : typeof r.best_time === 'string'
              ? JSON.parse(r.best_time)
              : [],
          hours:
            typeof r.hours === 'object' && r.hours ? r.hours : typeof r.hours === 'string' ? JSON.parse(r.hours) : {},
          is_test: Boolean(r.is_test),
          created_at: new Date(r.created_at).toISOString(),
          updated_at: new Date(r.updated_at).toISOString(),
        }));
        allSpots = [...mappedRows, ...memSpots].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      } catch (err) {
        log.error('[users] Error querying user spots from pool:', { error: err });
        allSpots = spotStore.spots
          .filter((s) => s.created_by === user.id && allowedStatusSet.has(s.status) && (allowTest || !s.is_test))
          .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      }
    } else {
      allSpots = spotStore.spots
        .filter((s) => s.created_by === user.id && allowedStatusSet.has(s.status) && (allowTest || !s.is_test))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    }

    const total = allSpots.length;
    const paged = allSpots.slice(offset, offset + limit);
    const next = offset + limit < total ? String(offset + limit) : null;
    const actorId =
      req.user?.id || (req.headers['x-device-id'] as string) || (req.headers['x-forwarded-for'] as string) || req.ip;

    const flaggedIds = isOwner
      ? paged.filter((s) => s.status === 'held' || s.status === 'hidden_pending_review').map((s) => s.id)
      : [];
    const eventsBySpot = new Map<string, Awaited<ReturnType<typeof listSpotModerationEvents>>>();
    if (flaggedIds.length > 0) {
      const events = await listSpotModerationEvents(flaggedIds);
      for (const ev of events) {
        const list = eventsBySpot.get(ev.spot_id) ?? [];
        list.push(ev);
        eventsBySpot.set(ev.spot_id, list);
      }
    }

    const likeCounts = spotStore.likeCounts();
    const spots = paged.map((spot) => {
      const crowd = spotStore.crowd(spot);
      const moderation =
        isOwner && (spot.status === 'held' || spot.status === 'hidden_pending_review')
          ? buildModerationSummary(spot, eventsBySpot.get(spot.id) ?? [])
          : undefined;
      let sourceName = spot.source_name;
      if (
        !sourceName ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceName) ||
        /^USR-[0-9a-f]{6,}/i.test(sourceName) ||
        sourceName === spot.created_by
      ) {
        sourceName = user!.display_name || 'JuanDerQuest Community';
      }
      return {
        id: spot.id,
        slug: spot.slug,
        name: spot.name,
        description: spot.description,
        category: spot.category,
        subcategory: spot.subcategory,
        tags: spot.tags || [],
        municipality: spot.municipality,
        address: spot.address,
        gps_lat: spot.gps_lat,
        gps_lng: spot.gps_lng,
        price_level: spot.price_level,
        hours: spot.hours || {},
        amenities: spot.amenities || [],
        good_for: spot.good_for || [],
        best_time: spot.best_time || [],
        image_url: spot.image_url || '',
        source_type: spot.source_type,
        source_name: sourceName,
        source_url: spot.source_url || null,
        trust_level: spot.trust_level,
        status: spot.status,
        quest_id: spot.quest_id || null,
        created_at: spot.created_at,
        updated_at: spot.updated_at,
        is_test: Boolean(spot.is_test),
        crowd_status: crowd.crowd_status,
        crowd_confidence: crowd.crowd_confidence,
        crowd_updated_at: crowd.crowd_updated_at,
        pressure_score: crowd.pressure_score,
        saved: Boolean(spotStore.isSaved(actorId, spot.id)),
        liked: Boolean(spotStore.isLiked(actorId, spot.id)),
        like_count: spotStore.likeCount(spot.id, actorId, likeCounts),
        trend_score: spotStore.trend(spot.id),
        ...(moderation ?? {}),
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        spots,
        next,
      },
      spots,
      next,
    });
  },
);

// GET /users/:id/profile â€” Public Profile Lookup by User ID or Handle
usersRouter.get(
  '/users/:id/profile',
  publicProfileLimiter,
  optionalAuthenticateToken,
  checkQAAuthorization,
  async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const allowTest = isAuthorizedQA(req);
    const rawId = req.params.id;
    if (!rawId || rawId.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'User ID is required.' },
      });
    }

    const trimmed = rawId.trim();
    // Allow lookup by ID or @handle
    let user = await db.findPublicUserById(trimmed, allowTest);
    if (!user && (trimmed.startsWith('@') || !trimmed.includes('-'))) {
      user = await db.findPublicUserByHandle(trimmed, allowTest);
    } else if (!user) {
      user = await db.findPublicUserByHandle(trimmed, allowTest);
    }

    if (!user || !user.is_public) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found or profile is private.' },
      });
    }

    if (user.is_test) {
      res.set('X-Robots-Tag', 'noindex, nofollow');
    }

    const counts = await db.getFollowCounts(user.id, false, allowTest);
    const cosmetics = (await safeCosmeticsFor([user.id])).get(user.id);

    // Strict Privacy-Safe Projection: Never leak email, wallet address, balances, or private logs
    return res.status(200).json({
      success: true,
      data: {
        id: user.id,
        display_name: user.display_name,
        handle: user.handle || null,
        avatar_url: user.avatar_url,
        bio: user.bio || null,
        status_text: user.status_text || null,
        scout_reputation: user.scout_reputation ?? 0,
        is_public: true,
        is_test: Boolean(user.is_test),
        follower_count: counts.follower_count,
        following_count: counts.following_count,
        created_at: user.created_at,
        cosmetics: cosmetics ?? { banner: null, frame: null, title: null, nameColor: null },
      },
    });
  },
);

// GET /users/:id/relationship â€” Authenticated query for follower relationship
usersRouter.get('/users/:id/relationship', authenticateToken, async (req: AuthRequest, res: Response) => {
  res.set('Cache-Control', 'private, no-store');
  const actorId = req.user!.id;
  const rawId = req.params.id;
  if (!rawId || rawId.trim().length === 0) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'User ID is required.' },
    });
  }

  const trimmed = rawId.trim();
  let target = await db.findPublicUserById(trimmed);
  if (!target && (trimmed.startsWith('@') || !trimmed.includes('-'))) {
    target = await db.findPublicUserByHandle(trimmed);
  } else if (!target) {
    target = await db.findPublicUserByHandle(trimmed);
  }

  if (!target || !target.is_public) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'User not found or profile is private.' },
    });
  }

  const relationship = await db.getRelationship(actorId, target.id);
  return res.status(200).json({
    success: true,
    data: relationship,
  });
});

// PUT /users/:id/follow â€” Authenticated actor follows public target
usersRouter.put('/users/:id/follow', authenticateToken, followLimiter, async (req: AuthRequest, res: Response) => {
  const actorId = req.user!.id;
  const targetId = req.params.id?.trim();

  if (!targetId) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Target user ID is required.' },
    });
  }

  if (actorId === targetId) {
    return res.status(422).json({
      success: false,
      error: { code: 'CANNOT_FOLLOW_SELF', message: 'You cannot follow yourself.' },
    });
  }

  const actor = db.findUserById(actorId);
  if (!actor || !actor.is_public) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'PROFILE_VISIBILITY_REQUIRED',
        message: 'Your profile must be public before you can follow other travelers.',
      },
    });
  }

  const target = db.findUserById(targetId);
  if (!target || !target.is_public) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'User not found or profile is private.' },
    });
  }

  if (Boolean(actor.is_test) !== Boolean(target.is_test)) {
    return res.status(403).json({
      success: false,
      error: { code: 'SCOPE_MISMATCH', message: 'Simulation travelers cannot be followed by real accounts.' },
    });
  }

  try {
    const result = await db.followUser(actorId, targetId);
    if (!result.success) {
      if (result.error === 'CANNOT_FOLLOW_SELF') {
        return res.status(422).json({
          success: false,
          error: { code: 'CANNOT_FOLLOW_SELF', message: 'You cannot follow yourself.' },
        });
      }
      if (result.error === 'PROFILE_VISIBILITY_REQUIRED') {
        return res.status(403).json({
          success: false,
          error: {
            code: 'PROFILE_VISIBILITY_REQUIRED',
            message: 'Your profile must be public before you can follow other travelers.',
          },
        });
      }
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found or profile is private.' },
      });
    }

    if (result.created) {
      const pool = getPool();
      if (pool) {
        const now = new Date();
        const dStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        const hourBucket = `${dStr}${String(manilaHour(now)).padStart(2, '0')}`;
        const actorName = actor.is_public ? actor.display_name : 'Someone';
        await notify(pool, {
          userId: targetId,
          kind: 'follow',
          eventKey: `follow:${actorId}:${targetId}`,
          title: 'New follower',
          message: `${actorName} started following you.`,
          href: `/users/${actor.handle ? `@${actor.handle}` : actor.id}`,
          isTest: Boolean(actor.is_test),
          push: {
            category: 'social',
            collapseKey: `social:${targetId}:${hourBucket}`,
            actorName,
          },
        }).catch((err) => log.error('[users:follow] Failed to notify follow:', { error: err }));
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        is_following: true,
        follower_count: result.follower_count ?? 0,
        following_count: result.following_count ?? 0,
      },
    });
  } catch (_err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to follow user.' },
    });
  }
});

// DELETE /users/:id/follow â€” Authenticated actor unfollows target (idempotent 204)
usersRouter.delete('/users/:id/follow', authenticateToken, followLimiter, async (req: AuthRequest, res: Response) => {
  const actorId = req.user!.id;
  const targetId = req.params.id?.trim();

  if (!targetId) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Target user ID is required.' },
    });
  }

  try {
    await db.unfollowUser(actorId, targetId);
    return res.status(204).send();
  } catch (_err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to unfollow user.' },
    });
  }
});

// GET /users/:id/followers â€” Public followers list with keyset cursor pagination
usersRouter.get(
  '/users/:id/followers',
  publicProfileLimiter,
  optionalAuthenticateToken,
  checkQAAuthorization,
  async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const rawId = req.params.id?.trim();
    if (!rawId) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'User ID is required.' },
      });
    }

    const allowTest = isAuthorizedQA(req);

    let target = await db.findPublicUserById(rawId, allowTest);
    if (!target && (rawId.startsWith('@') || !rawId.includes('-'))) {
      target = await db.findPublicUserByHandle(rawId, allowTest);
    } else if (!target) {
      target = await db.findPublicUserByHandle(rawId, allowTest);
    }

    if (!target || !target.is_public) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found or profile is private.' },
      });
    }

    const rawLimit = req.query.limit;
    const parsedLimit = rawLimit ? parseInt(rawLimit as string, 10) : 20;
    const limit = Math.min(50, Math.max(1, isNaN(parsedLimit) ? 20 : parsedLimit));
    const cursor =
      typeof req.query.cursor === 'string' && req.query.cursor.trim() ? req.query.cursor.trim() : undefined;

    try {
      const result = await db.listFollowers(target.id, limit, cursor, false, allowTest);
      if (!result) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'User not found or profile is private.' },
        });
      }

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      if (err instanceof InvalidCursorError || err?.name === 'InvalidCursorError') {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_CURSOR', message: 'Invalid or mismatched pagination cursor.' },
        });
      }
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to list followers.' },
      });
    }
  },
);

// GET /users/:id/following â€” Public following list with keyset cursor pagination
usersRouter.get(
  '/users/:id/following',
  publicProfileLimiter,
  optionalAuthenticateToken,
  checkQAAuthorization,
  async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const rawId = req.params.id?.trim();
    if (!rawId) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'User ID is required.' },
      });
    }

    const allowTest = isAuthorizedQA(req);

    let target = await db.findPublicUserById(rawId, allowTest);
    if (!target && (rawId.startsWith('@') || !rawId.includes('-'))) {
      target = await db.findPublicUserByHandle(rawId, allowTest);
    } else if (!target) {
      target = await db.findPublicUserByHandle(rawId, allowTest);
    }

    if (!target || !target.is_public) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found or profile is private.' },
      });
    }

    const rawLimit = req.query.limit;
    const parsedLimit = rawLimit ? parseInt(rawLimit as string, 10) : 20;
    const limit = Math.min(50, Math.max(1, isNaN(parsedLimit) ? 20 : parsedLimit));
    const cursor =
      typeof req.query.cursor === 'string' && req.query.cursor.trim() ? req.query.cursor.trim() : undefined;

    try {
      const result = await db.listFollowing(target.id, limit, cursor, allowTest);
      if (!result) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'User not found or profile is private.' },
        });
      }

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      if (err instanceof InvalidCursorError || err?.name === 'InvalidCursorError') {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_CURSOR', message: 'Invalid or mismatched pagination cursor.' },
        });
      }
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to list following.' },
      });
    }
  },
);

forwardAsyncRouteErrors(usersRouter);
