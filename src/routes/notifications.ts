import { Router, type Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { getPool } from '../db/pool.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validateRequest } from '../middleware/validate.js';

export const notificationsRouter = Router();

function available(res: Response) {
  if (!env.QUEST_FUNDING_ENABLED) {
    res.status(404).json({ success: false, error: { code: 'NOT_AVAILABLE', message: 'Funding notifications are unavailable.' } });
    return null;
  }
  const pool = getPool();
  if (!pool) {
    res.status(503).json({ success: false, error: { code: 'DATABASE_REQUIRED', message: 'Durable storage is required for notifications.' } });
    return null;
  }
  return pool;
}

notificationsRouter.get('/notifications', authenticateToken,
  rateLimit({ policyId: 'notifications:list', windowMs: 60_000, max: 120, keyStrategy: 'actor' }),
  validateRequest(z.object({ query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(30) }) })),
  async (req: AuthRequest, res: Response) => {
    const pool = available(res); if (!pool) return;
    try {
      const [items, unread] = await Promise.all([
        pool.query(
          `SELECT n.id,n.kind,n.title,n.message,n.href,n.created_at,n.read_at
             FROM user_notifications n JOIN users u ON u.id=n.user_id AND u.is_test=n.is_test
            WHERE n.user_id=$1 ORDER BY n.created_at DESC,n.id DESC LIMIT $2`, [req.user!.id,req.query.limit]),
        pool.query(
          `SELECT COUNT(*)::int AS count FROM user_notifications n JOIN users u ON u.id=n.user_id AND u.is_test=n.is_test
            WHERE n.user_id=$1 AND n.read_at IS NULL`, [req.user!.id]),
      ]);
      res.setHeader('Cache-Control','private, no-store');
      return res.json({ success: true, data: { items: items.rows.map(row => ({ ...row, read: row.read_at !== null })), unread_count: unread.rows[0]?.count ?? 0 } });
    } catch (error) {
      console.error('[notifications] list failed:', error);
      return res.status(503).json({ success: false, error: { code: 'NOTIFICATIONS_UNAVAILABLE', message: 'Notifications are temporarily unavailable.' } });
    }
  });

const markSchema = z.object({ params: z.object({ id: z.string().uuid() }) });
notificationsRouter.patch('/notifications/:id/read', authenticateToken,
  rateLimit({ policyId: 'notifications:read', windowMs: 60_000, max: 120, keyStrategy: 'actor' }),
  validateRequest(markSchema),
  async (req: AuthRequest, res: Response) => {
    const pool = available(res); if (!pool) return;
    try {
      const updated = await pool.query(
        `UPDATE user_notifications n SET read_at=COALESCE(n.read_at,NOW())
          FROM users u WHERE n.id=$1 AND n.user_id=$2 AND u.id=n.user_id AND u.is_test=n.is_test
          RETURNING n.id,n.read_at`, [req.params.id,req.user!.id]);
      if (!updated.rows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Notification not found.' } });
      res.setHeader('Cache-Control','private, no-store');
      return res.json({ success: true, data: { id: updated.rows[0].id, read_at: updated.rows[0].read_at } });
    } catch (error) {
      console.error('[notifications] mark-read failed:', error);
      return res.status(503).json({ success: false, error: { code: 'NOTIFICATIONS_UNAVAILABLE', message: 'Notifications are temporarily unavailable.' } });
    }
  });

notificationsRouter.post('/notifications/read-all', authenticateToken,
  rateLimit({ policyId: 'notifications:read-all', windowMs: 60_000, max: 20, keyStrategy: 'actor' }),
  async (req: AuthRequest, res: Response) => {
    const pool = available(res); if (!pool) return;
    try {
      const updated = await pool.query(
        `UPDATE user_notifications n SET read_at=NOW()
          FROM users u WHERE n.user_id=$1 AND n.read_at IS NULL AND u.id=n.user_id AND u.is_test=n.is_test`, [req.user!.id]);
      res.setHeader('Cache-Control','private, no-store');
      return res.json({ success: true, data: { marked_read: updated.rowCount ?? 0 } });
    } catch (error) {
      console.error('[notifications] mark-all-read failed:', error);
      return res.status(503).json({ success: false, error: { code: 'NOTIFICATIONS_UNAVAILABLE', message: 'Notifications are temporarily unavailable.' } });
    }
  });
