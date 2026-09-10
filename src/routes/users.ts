import { Router, Response } from 'express';
import { z } from 'zod';
import { db, InvalidCursorError } from '../db/index.js';
import { authenticateToken, AuthRequest, optionalAuthenticateToken, isAuthorizedQA, checkQAAuthorization } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';

export const usersRouter = Router();

const publicProfileLimiter = rateLimit({ policyId: 'users:public-profile', windowMs: 60 * 1000, max: 120, keyStrategy: 'ip' });
const followLimiter = rateLimit({ policyId: 'users:follow-mutation', windowMs: 60 * 1000, max: 30, keyStrategy: 'actor', coarseIpMax: 150 });

// ==========================================
// 1. Literal Routes (Must precede /users/:id)
// ==========================================

// GET /users?limit=3 — Public discovery rail (default 3, max 6)
usersRouter.get('/users', optionalAuthenticateToken, checkQAAuthorization, async (req: AuthRequest, res: Response) => {
  res.set('Cache-Control', 'no-store');
  const allowTest = isAuthorizedQA(req) && (req.query.include_test === 'true' || req.query.include_qa === 'true');
  const rawLimit = req.query.limit;
  const parsedLimit = rawLimit ? parseInt(rawLimit as string, 10) : 3;
  const limit = Math.min(6, Math.max(1, isNaN(parsedLimit) ? 3 : parsedLimit));
  const items = await db.listPublicUsers(limit, allowTest);
  return res.status(200).json({
    success: true,
    data: {
      items,
      users: items,
    },
  });
});


// GET /users/me/profile — Authenticated self profile and settings
usersRouter.get(
  '/users/me/profile',
  authenticateToken,
  async (req: AuthRequest, res: Response) => {
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
      },
    });
  }
);

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

// PATCH /users/me/profile — Update Authenticated User's Profile / Privacy Settings
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
  }
);

// Owner-only access never changes public visibility or exposes private followers.
usersRouter.get('/users/me/followers', authenticateToken, publicProfileLimiter, async (req: AuthRequest, res: Response) => {
  res.set('Cache-Control', 'private, no-store');
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Limit must be an integer from 1 to 50.' } });
  }
  try {
    const result = await db.listFollowers(req.user!.id, limit, typeof req.query.cursor === 'string' ? req.query.cursor : undefined, true);
    if (!result) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Account unavailable.' } });
    return res.json({ success: true, data: result });
  } catch (err) {
    const invalid = err instanceof InvalidCursorError;
    return res.status(invalid ? 400 : 500).json({ success: false, error: { code: invalid ? 'INVALID_CURSOR' : 'INTERNAL_ERROR', message: invalid ? 'Invalid pagination cursor.' : 'Unable to load followers.' } });
  }
});

// GET /users/me/following — Authenticated cleanup of retained outgoing edges
usersRouter.get(
  '/users/me/following',
  authenticateToken,
  async (req: AuthRequest, res: Response) => {
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
  }
);

// ==========================================
// 2. Parameterized Routes (/users/:id/...)
// ==========================================

// GET /users/:id/profile — Public Profile Lookup by User ID or Handle
usersRouter.get(
  '/users/:id/profile',
  publicProfileLimiter,
  optionalAuthenticateToken,
  checkQAAuthorization,
  async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const allowTest = isAuthorizedQA(req) && (req.query.include_test === 'true' || req.query.include_qa === 'true');
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

    const counts = await db.getFollowCounts(user.id);

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
      },
    });
  }
);

// GET /users/:id/relationship — Authenticated query for follower relationship
usersRouter.get(
  '/users/:id/relationship',
  authenticateToken,
  async (req: AuthRequest, res: Response) => {
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
  }
);

// PUT /users/:id/follow — Authenticated actor follows public target
usersRouter.put(
  '/users/:id/follow',
  authenticateToken,
  followLimiter,
  async (req: AuthRequest, res: Response) => {
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

      return res.status(200).json({
        success: true,
        data: {
          is_following: true,
          follower_count: result.follower_count ?? 0,
          following_count: result.following_count ?? 0,
        },
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to follow user.' },
      });
    }
  }
);

// DELETE /users/:id/follow — Authenticated actor unfollows target (idempotent 204)
usersRouter.delete(
  '/users/:id/follow',
  authenticateToken,
  followLimiter,
  async (req: AuthRequest, res: Response) => {
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
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to unfollow user.' },
      });
    }
  }
);

// GET /users/:id/followers — Public followers list with keyset cursor pagination
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

    const allowTest = isAuthorizedQA(req) && (req.query.include_test === 'true' || req.query.include_qa === 'true');

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
    const cursor = typeof req.query.cursor === 'string' && req.query.cursor.trim() ? req.query.cursor.trim() : undefined;

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
  }
);

// GET /users/:id/following — Public following list with keyset cursor pagination
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

    const allowTest = isAuthorizedQA(req) && (req.query.include_test === 'true' || req.query.include_qa === 'true');

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
    const cursor = typeof req.query.cursor === 'string' && req.query.cursor.trim() ? req.query.cursor.trim() : undefined;

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
  }
);
