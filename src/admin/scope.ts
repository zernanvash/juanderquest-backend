import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import { db } from '../db/index.js';
import { getPool } from '../db/pool.js';
import type { AuthRequest } from '../middleware/auth.js';
import { spotStore } from '../spots/store.js';

export const ADMIN_POWERS = ['destinations', 'quests_quizzes', 'merchants_vouchers', 'analytics'] as const;
export type AdminPower = typeof ADMIN_POWERS[number];
export interface AdminGrant { areaId: string; areaName: string; powers: Set<AdminPower>; areaIds: Set<string>; }
export type AdminScope = { platform: true } | { platform: false; grants: AdminGrant[] };

export async function loadAdminScope(userId: string): Promise<AdminScope> {
  const pool = getPool();
  if (!pool) {
    const user = db.findUserById(userId);
    if (user?.role === 'admin') return { platform: true };
    // Area grants live only in PostgreSQL; anyone else is simply not an administrator.
    if (user?.role === 'area_admin') throw new Error('Durable area-admin scope is unavailable.');
    throw new Error('Administrative privileges are required.');
  }
  const user = await db.usersRepo.findById(userId);
  if (!user) throw new Error('Account no longer exists.');
  if (user.role === 'admin') return { platform: true };
  if (user.role !== 'area_admin') throw new Error('Administrative privileges have been revoked.');

  const assignments = await pool.query(
    `SELECT aa.id, aa.area_id, a.display_name, aa.powers
       FROM admin_area_assignments aa JOIN admin_areas a ON a.id = aa.area_id
      WHERE aa.user_id = $1 AND aa.revoked_at IS NULL ORDER BY a.display_name`, [userId]);
  const grants: AdminGrant[] = [];
  for (const row of assignments.rows) {
    const tree = await pool.query(
      `WITH RECURSIVE area_tree(id, path) AS (
         SELECT id, ARRAY[id]::text[] FROM admin_areas WHERE id = $1
         UNION ALL
         SELECT child.id, tree.path || child.id
           FROM admin_areas child JOIN area_tree tree ON child.parent_id = tree.id
          WHERE NOT child.id = ANY(tree.path)
       ) SELECT id FROM area_tree`, [row.area_id]);
    grants.push({ areaId: String(row.area_id), areaName: String(row.display_name),
      powers: new Set((row.powers as string[]).filter((power): power is AdminPower => ADMIN_POWERS.includes(power as AdminPower))),
      areaIds: new Set(tree.rows.map((item) => String(item.id))) });
  }
  if (!grants.length) throw new Error('No active area assignments.');
  return { platform: false, grants };
}

export const hasAdminPower = (scope: AdminScope, power: AdminPower) =>
  scope.platform || scope.grants.some((grant) => grant.powers.has(power));

export const assertInScope = (scope: AdminScope, power: AdminPower, areaId: string | null | undefined) =>
  scope.platform || (areaId != null && scope.grants.some((grant) => grant.powers.has(power) && grant.areaIds.has(areaId)));

export function scopeFilterSql(scope: AdminScope, power: AdminPower, column: string, parameter = 1): { sql: string; values: unknown[] } {
  if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(column)) throw new Error('Unsafe SQL column name.');
  if (scope.platform) return { sql: 'TRUE', values: [] as string[] };
  const ids = [...new Set(scope.grants.filter((grant) => grant.powers.has(power)).flatMap((grant) => [...grant.areaIds]))];
  return ids.length
    ? { sql: `${column} = ANY($${parameter}::text[])`, values: [ids] }
    : { sql: 'FALSE', values: [] };
}

export async function writeAdminAudit(input: {
  actorId: string; actorRole: string; areaId?: string | null; action: string;
  subjectType: string; subjectId: string; before?: unknown; after?: unknown;
}) {
  const pool = getPool();
  if (!pool) throw new Error('Audit storage is unavailable.');
  await pool.query(
    `INSERT INTO admin_audit_log(id, actor_id, actor_role, area_id, action, subject_type, subject_id, before, after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
    [randomUUID(), input.actorId, input.actorRole, input.areaId ?? null, input.action,
      input.subjectType, input.subjectId, input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after)]);
}

export function requireAreaAdmin(power: AdminPower) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Sign in is required.' } });
    try {
      const scope = await loadAdminScope(req.user.id);
      if (!hasAdminPower(scope, power)) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: `The ${power} permission is required.` } });
      req.adminScope = scope;
      next();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Administrative scope could not be loaded.';
      const code = message.includes('unavailable') ? 'DATABASE_OUTAGE' : 'FORBIDDEN';
      return res.status(code === 'DATABASE_OUTAGE' ? 503 : 403).json({ success: false, error: { code, message } });
    }
  };
}

// ---- Plan 59 phase 3: area lookups for quizzes, merchants, applications and vouchers ----

/** A destination's areas for scope checks: its town and, when known, its barangay. */
export const spotAreaIds = (spotId: string | null | undefined): string[] => {
  const spot = spotId ? spotStore.spots.find((item) => item.id === spotId) : undefined;
  return spot ? [spot.town_area_id, spot.barangay_area_id].filter((id): id is string => Boolean(id)) : [];
};

export const spotInScope = (scope: AdminScope, power: AdminPower, spotId: string | null | undefined) =>
  scope.platform || spotAreaIds(spotId).some((areaId) => assertInScope(scope, power, areaId));

/** merchants.town_area_id by merchant id (the in-memory merchant mirror does not carry it). */
export async function merchantTownAreas(merchantIds?: string[]): Promise<Map<string, string | null>> {
  const pool = getPool();
  if (!pool) throw new Error('Merchant area storage is unavailable.');
  const result = merchantIds
    ? await pool.query('SELECT id, town_area_id FROM merchants WHERE id = ANY($1::text[])', [merchantIds])
    : await pool.query('SELECT id, town_area_id FROM merchants');
  return new Map(result.rows.map((row) => [String(row.id), row.town_area_id ? String(row.town_area_id) : null]));
}

/**
 * The town an application or merchant belongs to, by the migration 066 rule: the municipality and the
 * province together must name exactly one town. Anything else is unassigned (platform admins only).
 */
export async function resolveTownAreaId(municipality: string | null | undefined, province: string | null | undefined): Promise<string | null> {
  const pool = getPool();
  if (!pool || !municipality?.trim() || !province?.trim()) return null;
  const result = await pool.query(
    `SELECT town.id
       FROM admin_areas town
       JOIN admin_areas province ON province.id = town.parent_id AND province.level = 'province'
      WHERE town.level = 'town'
        AND lower(regexp_replace(trim(town.name), '\s+', ' ', 'g')) = lower(regexp_replace(trim($1), '\s+', ' ', 'g'))
        AND lower(regexp_replace(trim(province.name), '\s+', ' ', 'g')) = lower(regexp_replace(trim($2), '\s+', ' ', 'g'))
      LIMIT 2`,
    [municipality, province]);
  return result.rowCount === 1 ? String(result.rows[0].id) : null;
}

/** Writes an audit row once a scoped write succeeds (status < 400); a failed audit is logged, not thrown. */
export function auditOnSuccess(req: AuthRequest, res: Response, entry: {
  action: string; subjectType: string; subjectId: string; areaId?: string | null; before?: unknown;
}) {
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    void writeAdminAudit({ actorId: req.user!.id, actorRole: req.user!.role, ...entry })
      .catch((error) => console.error('[admin-audit] write failed:', error instanceof Error ? error.message : error));
  });
}

/**
 * Paths under /admin that area admins may reach. Everything else under /admin stays platform-only through
 * the blanket guard in routes/admin.ts; each listed route enforces requireAreaAdmin and its own area check.
 */
export const AREA_SCOPED_ADMIN_ROUTES: Array<{ methods: string[]; path: RegExp }> = [
  { methods: ['GET', 'POST'], path: /^\/quizzes\/?$/ },
  { methods: ['GET', 'PATCH'], path: /^\/quizzes\/[^/]+\/?$/ },
  { methods: ['POST'], path: /^\/quizzes\/[^/]+\/(publish|pause|archive|revoke)\/?$/ },
  { methods: ['GET'], path: /^\/merchants\/?$/ },
  { methods: ['GET'], path: /^\/merchants\/[^/]+\/?$/ },
  { methods: ['GET'], path: /^\/affiliate\/applications\/?$/ },
  { methods: ['GET', 'PATCH'], path: /^\/affiliate\/applications\/[^/]+\/?$/ },
  { methods: ['GET'], path: /^\/vouchers\/?$/ },
  { methods: ['PATCH'], path: /^\/vouchers\/[^/]+\/availability\/?$/ },
];

export const isAreaScopedAdminRoute = (method: string, pathUnderAdmin: string) =>
  AREA_SCOPED_ADMIN_ROUTES.some((route) => route.methods.includes(method) && route.path.test(pathUnderAdmin));
