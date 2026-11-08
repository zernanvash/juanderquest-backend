import { Router, Response } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { authenticateToken, optionalAuthenticateToken, AuthRequest, checkQAAuthorization, isAuthorizedQA } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
import { forwardAsyncRouteErrors } from '../middleware/asyncRoutes.js';
import { MAX_FEATURED_BADGES, buildShowcase, earnedBadges } from '../social/showcase.js';

// Profile showcase (owner 2026-11-08): see src/social/showcase.ts.
export const profileShowcaseRouter = Router();

const unavailable = (res: Response) =>
  res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'Profiles are unavailable right now.' } });

profileShowcaseRouter.get('/me/showcase', authenticateToken, async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return unavailable(res);
  res.setHeader('Cache-Control', 'private, no-store');
  const data = await buildShowcase(pool, req.user!.id, { includeActivity: true });
  if (!data) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Account unavailable.' } });
  return res.json({ success: true, data });
});

profileShowcaseRouter.get(
  '/users/:handle/showcase',
  optionalAuthenticateToken,
  checkQAAuthorization,
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) return unavailable(res);
    res.setHeader('Cache-Control', 'no-store');
    const { rows } = await pool.query(
      `SELECT id, share_activity FROM users
        WHERE LOWER(handle) = $1 AND is_public = TRUE AND ($2 OR COALESCE(is_test, FALSE) = FALSE)`,
      [req.params.handle.replace(/^@/, '').toLowerCase().trim(), isAuthorizedQA(req)],
    );
    const target = rows[0];
    if (!target) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found or profile is private.' } });
    }
    const self = req.user?.id === target.id;
    const data = await buildShowcase(pool, target.id, { includeActivity: self || target.share_activity !== false });
    if (!data) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found or profile is private.' } });
    return res.json({ success: true, data });
  },
);

const featuredSchema = z.object({
  body: z.object({ badge_ids: z.array(z.string().min(1).max(100)).max(MAX_FEATURED_BADGES) }),
});

profileShowcaseRouter.put(
  '/me/featured-badges',
  authenticateToken,
  validateRequest(featuredSchema),
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) return unavailable(res);
    const ids: string[] = [...new Set<string>(req.body.badge_ids)];
    const earned = new Set((await earnedBadges(pool, req.user!.id)).map((b) => b.id));
    const missing = ids.filter((id) => !earned.has(id));
    if (missing.length) {
      return res.status(400).json({ success: false, error: { code: 'BADGE_NOT_EARNED', message: 'You can only equip badges you have earned.' } });
    }
    await pool.query('UPDATE users SET featured_badges = $2 WHERE id = $1', [req.user!.id, ids]);
    return res.json({ success: true, data: { featured_badges: ids } });
  },
);

const favoriteSchema = z.object({ body: z.object({ spot_id: z.string().min(1).max(200).nullable() }) });

profileShowcaseRouter.put(
  '/me/favorite-spot',
  authenticateToken,
  validateRequest(favoriteSchema),
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) return unavailable(res);
    const spotId: string | null = req.body.spot_id;
    if (spotId) {
      const { rows } = await pool.query(`SELECT 1 FROM spots WHERE id = $1 AND status = 'published'`, [spotId]);
      if (!rows[0]) {
        return res.status(400).json({ success: false, error: { code: 'SPOT_NOT_FOUND', message: 'Choose a published destination.' } });
      }
    }
    await pool.query('UPDATE users SET favorite_spot_id = $2 WHERE id = $1', [req.user!.id, spotId]);
    return res.json({ success: true, data: { favorite_spot_id: spotId } });
  },
);

forwardAsyncRouteErrors(profileShowcaseRouter);
