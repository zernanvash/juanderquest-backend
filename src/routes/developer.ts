import { Router, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { getPool } from '../db/pool.js';
import { db } from '../db/index.js';
import { forwardAsyncRouteErrors } from '../middleware/asyncRoutes.js';

// Developer dashboard (owner 2026-10-29): developers are admins with admin_scope='developer'.
// They can see every account's role and change it; every change is audited with a reason.
export const developerRouter = Router();

const ROLES = ['user', 'admin', 'qa'] as const;
const SCOPES = ['platform', 'area', 'developer'] as const;

export async function isDeveloper(userId: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const row = (await pool.query('SELECT role, admin_scope FROM users WHERE id=$1', [userId])).rows[0];
  return row?.role === 'admin' && row?.admin_scope === 'developer';
}

const requireDeveloper = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user && await isDeveloper(req.user.id)) return next();
    return res.status(403).json({ success: false, error: { code: 'DEVELOPER_ONLY', message: 'Only developers can manage account roles.' } });
  } catch {
    return res.status(503).json({ success: false, error: { code: 'DATABASE_OUTAGE', message: 'Could not verify developer access.' } });
  }
};

const unavailable = (res: Response) =>
  res.status(503).json({ success: false, error: { code: 'STORAGE_UNAVAILABLE', message: 'Role management needs the database.' } });

developerRouter.get('/admin/developer/access', authenticateToken, async (req: AuthRequest, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    return res.json({ success: true, data: { developer: await isDeveloper(req.user!.id) } });
  } catch {
    return res.json({ success: true, data: { developer: false } });
  }
});

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  role: z.enum(['all', 'staff', ...ROLES]).optional(),
});

developerRouter.get('/admin/developer/users', authenticateToken, requireAdmin, requireDeveloper, async (req: AuthRequest, res) => {
  const pool = getPool();
  if (!pool) return unavailable(res);
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'Invalid filters.' } });
  const { q = '', role = 'all' } = parsed.data;
  res.setHeader('Cache-Control', 'private, no-store');
  const rows = (await pool.query(
    `SELECT id, display_name, email, handle, wallet_address, role, admin_scope, created_at
       FROM users
      WHERE COALESCE(is_test, FALSE) = FALSE
        AND ($1::text = '' OR display_name ILIKE '%' || $1::text || '%' OR email ILIKE '%' || $1::text || '%'
             OR handle ILIKE '%' || $1::text || '%' OR LOWER(COALESCE(wallet_address, '')) = LOWER($1::text))
        AND ($2::text = 'all' OR ($2::text = 'staff' AND role::text <> 'user') OR role::text = $2::text)
      ORDER BY (role::text <> 'user') DESC, (admin_scope = 'developer') DESC NULLS LAST, created_at DESC
      LIMIT 50`,
    [q, role],
  )).rows;
  return res.json({ success: true, data: rows });
});

const roleBody = z.object({
  role: z.enum(ROLES),
  admin_scope: z.enum(SCOPES).nullable(),
  reason: z.string().trim().min(5).max(500),
}).strict();

const roleWrites = rateLimit({ policyId: 'developer:roles', windowMs: 60_000, max: 30, keyStrategy: 'actor' });

developerRouter.put('/admin/developer/users/:id/role', authenticateToken, requireAdmin, requireDeveloper, roleWrites, async (req: AuthRequest, res) => {
  const pool = getPool();
  if (!pool) return unavailable(res);
  const parsed = roleBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid role change.' } });
  }
  const { role, reason } = parsed.data;
  // Scopes only mean something for admins.
  const scope = role === 'admin' ? parsed.data.admin_scope : null;
  if (req.params.id === req.user!.id) {
    return res.status(409).json({ success: false, error: { code: 'CANNOT_CHANGE_SELF', message: 'Ask another developer to change your own role.' } });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = (await client.query('SELECT id, role, admin_scope FROM users WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'Account not found.' } });
    }
    const updated = (await client.query(
      `UPDATE users SET role=$2, admin_scope=$3, updated_at=NOW() WHERE id=$1
       RETURNING id, display_name, email, handle, wallet_address, role, admin_scope, created_at`,
      [req.params.id, role, scope],
    )).rows[0];
    await client.query(
      `INSERT INTO user_role_audit(id, actor_id, target_id, old_role, new_role, old_scope, new_scope, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), req.user!.id, req.params.id, current.role, role, current.admin_scope, scope, reason],
    );
    await client.query('COMMIT');
    // Keep the in-memory mirror honest for routes that still read it.
    const mirror = db.findUserById(req.params.id);
    if (mirror) mirror.role = role;
    return res.json({ success: true, data: updated });
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(503).json({ success: false, error: { code: 'STORAGE_UNAVAILABLE', message: 'Role change could not be saved.' } });
  } finally {
    client.release();
  }
});

developerRouter.get('/admin/developer/role-audit', authenticateToken, requireAdmin, requireDeveloper, async (_req: AuthRequest, res) => {
  const pool = getPool();
  if (!pool) return unavailable(res);
  res.setHeader('Cache-Control', 'private, no-store');
  const rows = (await pool.query(
    `SELECT a.created_at, a.old_role, a.new_role, a.old_scope, a.new_scope, a.reason, a.actor_id,
            actor.display_name AS actor_name, target.display_name AS target_name, target.email AS target_email
       FROM user_role_audit a
       LEFT JOIN users actor ON actor.id::text = a.actor_id
       LEFT JOIN users target ON target.id::text = a.target_id
      ORDER BY a.created_at DESC LIMIT 50`,
  )).rows;
  return res.json({ success: true, data: rows });
});

forwardAsyncRouteErrors(developerRouter);

export default developerRouter;
