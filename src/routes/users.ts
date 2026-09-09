import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { authenticateToken, AuthRequest, optionalAuthenticateToken } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';

export const usersRouter = Router();

const publicProfileLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });

// Public Profile Lookup by User ID or Handle
usersRouter.get(
  '/users/:id/profile',
  publicProfileLimiter,
  optionalAuthenticateToken,
  (req: AuthRequest, res: Response) => {
    const rawId = req.params.id;
    if (!rawId || rawId.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'User ID is required.' },
      });
    }

    const trimmed = rawId.trim();
    // Allow lookup by ID or @handle
    let user = db.findPublicUserById(trimmed);
    if (!user && trimmed.startsWith('@')) {
      user = db.findPublicUserByHandle(trimmed);
    } else if (!user) {
      user = db.findPublicUserByHandle(trimmed);
    }

    if (!user || !user.is_public) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found or profile is private.' },
      });
    }

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
        created_at: user.created_at,
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

// Update Authenticated User's Profile / Privacy Settings
usersRouter.patch(
  '/users/me/profile',
  authenticateToken,
  validateRequest(updateProfileSchema),
  (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { display_name, is_public, handle, bio, status_text } = req.body;

    // Check handle uniqueness if changed
    if (handle) {
      const existing = db.users.find(
        (u) => u.id !== userId && u.handle?.toLowerCase() === handle.toLowerCase()
      );
      if (existing) {
        return res.status(409).json({
          success: false,
          error: { code: 'HANDLE_TAKEN', message: 'This handle is already in use by another traveler.' },
        });
      }
    }

    const updated = db.updateUserProfile(userId, {
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

    return res.status(200).json({
      success: true,
      data: {
        id: updated.id,
        display_name: updated.display_name,
        handle: updated.handle || null,
        avatar_url: updated.avatar_url,
        bio: updated.bio || null,
        status_text: updated.status_text || null,
        scout_reputation: updated.scout_reputation ?? 0,
        is_public: updated.is_public,
        updated_at: updated.updated_at,
      },
    });
  }
);
