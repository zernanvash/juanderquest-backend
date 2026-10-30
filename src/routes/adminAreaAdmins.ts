import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { ADMIN_POWERS, loadAdminScope } from '../admin/scope.js';
import { getPool } from '../db/pool.js';
import { AuthRequest, authenticateToken, requireAdmin } from '../middleware/auth.js';

const router = Router();
router.get('/admin/me/scope', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const scope = await loadAdminScope(req.user!.id);
    return res.json({ success: true, data: scope.platform ? { platform: true, grants: [] } : {
      platform: false, grants: scope.grants.map((grant) => ({ area_id: grant.areaId, area_name: grant.areaName,
        area_ids: [...grant.areaIds], powers: [...grant.powers] })),
    } });
  } catch {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'No active administrator scope.' } });
  }
});

router.use('/admin/area-admins', authenticateToken, requireAdmin);
router.get('/admin/area-admins', async (_req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_OUTAGE', message: 'Area administrator storage is unavailable.' } });
  const [assignments, audit] = await Promise.all([
    pool.query(`SELECT aa.id, aa.user_id, u.display_name, u.email, aa.area_id, a.display_name AS area_name,
                       aa.powers, aa.granted_by, aa.granted_at, aa.revoked_at
                  FROM admin_area_assignments aa JOIN users u ON u.id = aa.user_id JOIN admin_areas a ON a.id = aa.area_id
                 ORDER BY aa.revoked_at NULLS FIRST, a.display_name, u.display_name`),
    pool.query(`SELECT id, actor_id, actor_role, area_id, action, subject_type, subject_id, before, after, created_at
                  FROM admin_audit_log ORDER BY created_at DESC LIMIT 100`),
  ]);
  return res.json({ success: true, data: { assignments: assignments.rows, audit: audit.rows, powers: ADMIN_POWERS } });
});
router.get('/admin/area-admins/areas', async (_req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_OUTAGE', message: 'Area data is unavailable.' } });
  const result = await pool.query('SELECT id, level, name, display_name, parent_id FROM admin_areas ORDER BY level, display_name');
  return res.json({ success: true, data: result.rows });
});

const grantSchema = z.object({ user_id: z.string().min(1), area_id: z.string().min(1), powers: z.array(z.enum(ADMIN_POWERS)).min(1) });
router.post('/admin/area-admins', async (req: AuthRequest, res) => {
  const parsed = grantSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Choose a user, area, and at least one permission.' } });
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_OUTAGE', message: 'Area administrator storage is unavailable.' } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userResult = await client.query('SELECT id, role FROM users WHERE id = $1 FOR UPDATE', [parsed.data.user_id]);
    if (!userResult.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found.' } }); }
    const target = userResult.rows[0];
    if (target.role === 'admin' || target.role === 'qa') { await client.query('ROLLBACK'); return res.status(409).json({ success: false, error: { code: 'ROLE_CONFLICT', message: 'Platform administrators and QA users cannot be converted to area admins.' } }); }
    const before = await client.query('SELECT * FROM admin_area_assignments WHERE user_id=$1 AND area_id=$2 FOR UPDATE', [parsed.data.user_id, parsed.data.area_id]);
    const assignment = await client.query(
      `INSERT INTO admin_area_assignments(id,user_id,area_id,powers,granted_by,revoked_at)
       VALUES ($1,$2,$3,$4,$5,NULL)
       ON CONFLICT(user_id,area_id) DO UPDATE SET powers=EXCLUDED.powers, granted_by=EXCLUDED.granted_by, granted_at=NOW(), revoked_at=NULL
       RETURNING *`, [randomUUID(), parsed.data.user_id, parsed.data.area_id, parsed.data.powers, req.user!.id]);
    await client.query("UPDATE users SET role='area_admin' WHERE id=$1", [parsed.data.user_id]);
    await client.query(`INSERT INTO admin_audit_log(id,actor_id,actor_role,area_id,action,subject_type,subject_id,before,after)
      VALUES($1,$2,'admin',$3,$4,'area_admin_assignment',$5,$6::jsonb,$7::jsonb)`,
      [randomUUID(), req.user!.id, parsed.data.area_id, before.rowCount ? 'area_admin.assignment_updated' : 'area_admin.granted', assignment.rows[0].id,
        before.rowCount ? JSON.stringify(before.rows[0]) : null, JSON.stringify(assignment.rows[0])]);
    await client.query('COMMIT');
    return res.status(before.rowCount ? 200 : 201).json({ success: true, data: assignment.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const message = error instanceof Error ? error.message : 'Grant failed.';
    return res.status(message.includes('admin_areas') ? 404 : 500).json({ success: false, error: { code: 'AREA_ADMIN_GRANT_FAILED', message: 'Could not save this area assignment.' } });
  } finally { client.release(); }
});

const powersSchema = z.object({ powers: z.array(z.enum(ADMIN_POWERS)).min(1) });
router.patch('/admin/area-admins/:id', async (req: AuthRequest, res) => {
  const parsed = powersSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'At least one permission is required.' } });
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_OUTAGE', message: 'Area administrator storage is unavailable.' } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query('SELECT * FROM admin_area_assignments WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!before.rowCount || before.rows[0].revoked_at) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Active assignment not found.' } }); }
    const after = await client.query('UPDATE admin_area_assignments SET powers=$1 WHERE id=$2 RETURNING *', [parsed.data.powers, req.params.id]);
    await client.query(`INSERT INTO admin_audit_log(id,actor_id,actor_role,area_id,action,subject_type,subject_id,before,after)
      VALUES($1,$2,'admin',$3,'area_admin.powers_changed','area_admin_assignment',$4,$5::jsonb,$6::jsonb)`,
      [randomUUID(), req.user!.id, before.rows[0].area_id, req.params.id, JSON.stringify(before.rows[0]), JSON.stringify(after.rows[0])]);
    await client.query('COMMIT'); return res.json({ success: true, data: after.rows[0] });
  } catch { await client.query('ROLLBACK').catch(() => undefined); return res.status(500).json({ success: false, error: { code: 'AREA_ADMIN_UPDATE_FAILED', message: 'Could not update this assignment.' } }); }
  finally { client.release(); }
});

router.delete('/admin/area-admins/:id', async (req: AuthRequest, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_OUTAGE', message: 'Area administrator storage is unavailable.' } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query('SELECT * FROM admin_area_assignments WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!before.rowCount || before.rows[0].revoked_at) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Active assignment not found.' } }); }
    const after = await client.query('UPDATE admin_area_assignments SET revoked_at=NOW() WHERE id=$1 RETURNING *', [req.params.id]);
    const remaining = await client.query('SELECT 1 FROM admin_area_assignments WHERE user_id=$1 AND revoked_at IS NULL LIMIT 1', [before.rows[0].user_id]);
    if (!remaining.rowCount) await client.query("UPDATE users SET role='user' WHERE id=$1 AND role='area_admin'", [before.rows[0].user_id]);
    await client.query(`INSERT INTO admin_audit_log(id,actor_id,actor_role,area_id,action,subject_type,subject_id,before,after)
      VALUES($1,$2,'admin',$3,'area_admin.revoked','area_admin_assignment',$4,$5::jsonb,$6::jsonb)`,
      [randomUUID(), req.user!.id, before.rows[0].area_id, req.params.id, JSON.stringify(before.rows[0]), JSON.stringify(after.rows[0])]);
    await client.query('COMMIT'); return res.json({ success: true, data: { ...after.rows[0], demoted: !remaining.rowCount } });
  } catch { await client.query('ROLLBACK').catch(() => undefined); return res.status(500).json({ success: false, error: { code: 'AREA_ADMIN_REVOKE_FAILED', message: 'Could not revoke this assignment.' } }); }
  finally { client.release(); }
});

export default router;
