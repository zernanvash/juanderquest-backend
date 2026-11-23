import { Router, type NextFunction, type Response } from 'express';
import { z } from 'zod';
import { authenticateToken, invalidateSessionScopeCache, requireAdmin, type AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { getPool } from '../db/pool.js';
import { db } from '../db/index.js';
import { writeAdminAudit } from '../admin/scope.js';
import { isDeveloper } from './developer.js';
import { getChainConfig } from '../chain/config.js';
import { RISK_RULE_NAMES, startOfManilaDay, type RiskRuleName } from '../admin/riskRules.js';
import { runRiskScan } from '../jobs/risk-scan.js';
import { log } from '../utils/logger.js';

export const adminUsersRouter = Router();

const adminReadGuard = [authenticateToken, requireAdmin] as const;

const rejectDeveloperWrites = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user && (await isDeveloper(req.user.id))) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Developer accounts have read-only access to this moderation action.' },
      });
    }
    return next();
  } catch {
    return res
      .status(503)
      .json({ success: false, error: { code: 'DATABASE_OUTAGE', message: 'Could not verify administrator scope.' } });
  }
};

const adminWriteGuard = [authenticateToken, requireAdmin, rejectDeveloperWrites] as const;

export function maskEmail(email: string | null | undefined): string {
  if (!email) return '';
  const trimmed = email.trim();
  const at = trimmed.indexOf('@');
  if (at <= 0) return '***';
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const visible = local.length <= 1 ? local : local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}

function noStore(res: Response) {
  res.setHeader('Cache-Control', 'private, no-store');
}

function dbUnavailable(res: Response) {
  return res.status(503).json({
    success: false,
    error: { code: 'DATABASE_OUTAGE', message: 'Administrative database storage is unavailable.' },
  });
}

function parseLimit(raw: unknown, fallback = 25): number | null {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) return null;
  return n;
}

function parseIncludeTest(raw: unknown): boolean {
  return raw === '1' || raw === 'true';
}

function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor<T extends Record<string, unknown>>(raw: unknown): T | null {
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as T;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

const reasonBodySchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(3, 'Reason must be 3 to 300 characters.')
      .max(300, 'Reason must be 3 to 300 characters.'),
  })
  .strict();

const reviewFlagBodySchema = z
  .object({
    status: z.enum(['dismissed', 'actioned']),
    note: z.string().trim().min(3, 'Note must be 3 to 300 characters.').max(300, 'Note must be 3 to 300 characters.'),
  })
  .strict();

type SortMode = 'newest' | 'xp' | 'points';

async function resolveEvidenceEntities(
  pool: NonNullable<ReturnType<typeof getPool>>,
  evidences: Array<Record<string, unknown>>,
): Promise<
  Record<
    string,
    {
      spots: Record<string, string>;
      quests: Record<string, string>;
      campaigns: Record<string, string>;
      users: Record<string, string>;
    }
  >
> {
  const spotIds = new Set<string>();
  const questIds = new Set<string>();
  const campaignIds = new Set<string>();
  const userIds = new Set<string>();

  for (const ev of evidences) {
    if (!ev || typeof ev !== 'object') continue;
    for (const k of ['spot_id', 'first_spot_id', 'second_spot_id']) {
      if (typeof ev[k] === 'string' && ev[k]) spotIds.add(ev[k] as string);
    }
    if (Array.isArray(ev.spot_ids)) {
      for (const s of ev.spot_ids) if (typeof s === 'string' && s) spotIds.add(s);
    }
    for (const k of ['quest_id', 'first_quest_id', 'second_quest_id']) {
      if (typeof ev[k] === 'string' && ev[k]) questIds.add(ev[k] as string);
    }
    if (Array.isArray(ev.quest_ids)) {
      for (const q of ev.quest_ids) if (typeof q === 'string' && q) questIds.add(q);
    }
    if (typeof ev.campaign_id === 'string' && ev.campaign_id) campaignIds.add(ev.campaign_id);
    if (Array.isArray(ev.granting_admin_ids)) {
      for (const a of ev.granting_admin_ids) if (typeof a === 'string' && a) userIds.add(a);
    }
  }

  const [spotsRes, questsRes, campaignsRes, usersRes] = await Promise.all([
    spotIds.size
      ? pool.query<{ id: string; name: string }>('SELECT id, name FROM spots WHERE id = ANY($1::text[])', [
          [...spotIds],
        ])
      : Promise.resolve({ rows: [] }),
    questIds.size
      ? pool.query<{ id: string; title: string }>('SELECT id, title FROM quests WHERE id = ANY($1::text[])', [
          [...questIds],
        ])
      : Promise.resolve({ rows: [] }),
    campaignIds.size
      ? pool.query<{ id: string; title: string }>(
          `SELECT id::text AS id, COALESCE(NULLIF(theme, ''), slug) AS title FROM juanchoice_campaigns WHERE id::text = ANY($1::text[])`,
          [[...campaignIds]],
        )
      : Promise.resolve({ rows: [] }),
    userIds.size
      ? pool.query<{ id: string; display_name: string }>(
          'SELECT id, display_name FROM users WHERE id = ANY($1::text[])',
          [[...userIds]],
        )
      : Promise.resolve({ rows: [] }),
  ]);

  return {
    entities: {
      spots: Object.fromEntries(spotsRes.rows.map((r) => [r.id, r.name])),
      quests: Object.fromEntries(questsRes.rows.map((r) => [r.id, r.title])),
      campaigns: Object.fromEntries(campaignsRes.rows.map((r) => [r.id, r.title])),
      users: Object.fromEntries(usersRes.rows.map((r) => [r.id, r.display_name])),
    },
  };
}

// =====================================================================
// WP-1: User management
// =====================================================================

adminUsersRouter.get('/admin/users', ...adminReadGuard, async (req: AuthRequest, res: Response) => {
  noStore(res);
  const pool = getPool();
  if (!pool) return dbUnavailable(res);

  const limit = parseLimit(req.query.limit, 25);
  if (limit === null) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'limit must be an integer from 1 to 100.' },
    });
  }

  const sortRaw = typeof req.query.sort === 'string' && req.query.sort ? req.query.sort : 'newest';
  if (!['newest', 'xp', 'points'].includes(sortRaw)) {
    return res
      .status(400)
      .json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'sort must be newest, xp, or points.' } });
  }
  const sort = sortRaw as SortMode;

  const roleRaw = typeof req.query.role === 'string' && req.query.role ? req.query.role : '';
  if (roleRaw && !['user', 'admin', 'area_admin', 'qa'].includes(roleRaw)) {
    return res
      .status(400)
      .json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid role filter.' } });
  }

  const statusRaw = typeof req.query.status === 'string' && req.query.status ? req.query.status : '';
  if (statusRaw && !['active', 'suspended'].includes(statusRaw)) {
    return res
      .status(400)
      .json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'status must be active or suspended.' } });
  }

  let cursorPredicate = '';
  const params: unknown[] = [];
  if (req.query.cursor !== undefined && req.query.cursor !== '') {
    const parsed = decodeCursor<{ k?: string; a?: unknown; id?: unknown }>(req.query.cursor);
    if (!parsed || parsed.k !== sort || typeof parsed.id !== 'string' || !parsed.id) {
      return res
        .status(400)
        .json({ success: false, error: { code: 'INVALID_CURSOR', message: 'Invalid pagination cursor.' } });
    }
    if (sort === 'newest') {
      if (typeof parsed.a !== 'string' || Number.isNaN(Date.parse(parsed.a))) {
        return res
          .status(400)
          .json({ success: false, error: { code: 'INVALID_CURSOR', message: 'Invalid pagination cursor.' } });
      }
      params.push(parsed.a, parsed.id);
      cursorPredicate = `AND (u.created_at, u.id) < ($${params.length - 1}::timestamptz, $${params.length}::text)`;
    } else {
      const numVal = Number(parsed.a);
      if (!Number.isFinite(numVal)) {
        return res
          .status(400)
          .json({ success: false, error: { code: 'INVALID_CURSOR', message: 'Invalid pagination cursor.' } });
      }
      params.push(Math.trunc(numVal), parsed.id);
      cursorPredicate =
        sort === 'points'
          ? `AND (u.demo_points, u.id) < ($${params.length - 1}::int, $${params.length}::text)`
          : `AND (COALESCE(pt.explorer_xp, 0), u.id) < ($${params.length - 1}::bigint, $${params.length}::text)`;
    }
  }

  const includeTest = parseIncludeTest(req.query.include_test);
  const filters: string[] = [];
  if (!includeTest) filters.push('COALESCE(u.is_test, FALSE) = FALSE');
  if (roleRaw) {
    params.push(roleRaw);
    filters.push(`u.role::text = $${params.length}`);
  }
  if (statusRaw === 'active') filters.push('u.suspended_at IS NULL');
  if (statusRaw === 'suspended') filters.push('u.suspended_at IS NOT NULL');

  const qRaw = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const qClean = qRaw.replace(/^@+/, '').trim();
  if (qClean) {
    const escaped = qClean.replace(/[\\%_]/g, '\\$&');
    params.push(escaped);
    filters.push(
      `f_unaccent(lower(coalesce(u.display_name, '') || ' ' || coalesce(u.handle, '') || ' ' || coalesce(u.email, ''))) LIKE '%' || f_unaccent(lower($${params.length}::text)) || '%'`,
    );
  }

  params.push(limit + 1);
  const limitParam = `$${params.length}`;
  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : 'WHERE TRUE';
  const orderClause =
    sort === 'points'
      ? 'ORDER BY u.demo_points DESC, u.id DESC'
      : sort === 'xp'
        ? 'ORDER BY COALESCE(pt.explorer_xp, 0) DESC, u.id DESC'
        : 'ORDER BY u.created_at DESC, u.id DESC';

  try {
    const { rows } = await pool.query<{
      id: string;
      display_name: string;
      handle: string | null;
      email: string;
      role: string;
      admin_scope: string | null;
      created_at: Date;
      demo_points: number;
      suspended_at: Date | null;
      explorer_xp: string | number;
      last_event_at: Date | null;
    }>(
      `SELECT u.id, u.display_name, u.handle, u.email, u.role::text AS role, u.admin_scope,
              u.created_at, u.demo_points, u.suspended_at,
              COALESCE(pt.explorer_xp, 0)::bigint AS explorer_xp,
              pt.last_event_at
         FROM users u
         LEFT JOIN progression_totals pt ON pt.user_id = u.id
        ${whereClause}
        ${cursorPredicate}
        ${orderClause}
        LIMIT ${limitParam}`,
      params,
    );

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const ids = pageRows.map((r) => r.id);

    const [devicesRes, stampsRes, badgesRes, flagsRes] = ids.length
      ? await Promise.all([
          pool.query<{ user_id: string; last_seen_at: Date }>(
            'SELECT user_id, MAX(last_seen_at) AS last_seen_at FROM user_devices WHERE user_id = ANY($1::text[]) GROUP BY user_id',
            [ids],
          ),
          pool.query<{ user_id: string; balance: number }>(
            'SELECT user_id, balance FROM stamp_balances WHERE user_id = ANY($1::text[])',
            [ids],
          ),
          pool.query<{ user_id: string; badges_count: number }>(
            `SELECT user_id, COUNT(*)::int AS badges_count
               FROM achievement_awards
              WHERE user_id = ANY($1::text[]) AND revoked_at IS NULL AND ($2 = TRUE OR is_test = FALSE)
              GROUP BY user_id`,
            [ids, includeTest],
          ),
          pool.query<{ user_id: string; open_flags: number }>(
            `SELECT user_id, COUNT(*)::int AS open_flags
               FROM risk_flags
              WHERE user_id = ANY($1::text[]) AND status = 'open'
              GROUP BY user_id`,
            [ids],
          ),
        ])
      : [{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }];

    const lastSeenMap = new Map(devicesRes.rows.map((r) => [r.user_id, new Date(r.last_seen_at)]));
    const stampsMap = new Map(stampsRes.rows.map((r) => [r.user_id, Number(r.balance)]));
    const badgesMap = new Map(badgesRes.rows.map((r) => [r.user_id, Number(r.badges_count)]));
    const flagsMap = new Map(flagsRes.rows.map((r) => [r.user_id, Number(r.open_flags)]));

    const items = pageRows.map((r) => {
      const devSeen = lastSeenMap.get(r.id);
      const evtAt = r.last_event_at ? new Date(r.last_event_at) : null;
      let lastActive: string | null = null;
      if (devSeen && evtAt) lastActive = (devSeen > evtAt ? devSeen : evtAt).toISOString();
      else if (devSeen) lastActive = devSeen.toISOString();
      else if (evtAt) lastActive = evtAt.toISOString();

      return {
        id: r.id,
        display_name: r.display_name,
        handle: r.handle ?? null,
        masked_email: maskEmail(r.email),
        role: r.role,
        admin_scope: r.admin_scope ?? null,
        created_at: new Date(r.created_at).toISOString(),
        last_active_at: lastActive,
        explorer_xp: Number(r.explorer_xp),
        points: Number(r.demo_points),
        stamps: stampsMap.get(r.id) ?? 0,
        badges_count: badgesMap.get(r.id) ?? 0,
        open_flags: flagsMap.get(r.id) ?? 0,
        suspended_at: r.suspended_at ? new Date(r.suspended_at).toISOString() : null,
      };
    });

    const last = pageRows[pageRows.length - 1];
    const next_cursor =
      hasMore && last
        ? encodeCursor(
            sort === 'points'
              ? { k: sort, a: Number(last.demo_points), id: last.id }
              : sort === 'xp'
                ? { k: sort, a: Number(last.explorer_xp), id: last.id }
                : { k: sort, a: new Date(last.created_at).toISOString(), id: last.id },
          )
        : null;

    return res.json({ success: true, data: { items, next_cursor, has_more: hasMore } });
  } catch (err) {
    log.error('[admin-users] list failed:', { error: err instanceof Error ? err.message : err });
    return dbUnavailable(res);
  }
});

adminUsersRouter.get('/admin/users/:id', ...adminReadGuard, async (req: AuthRequest, res: Response) => {
  noStore(res);
  const pool = getPool();
  if (!pool) return dbUnavailable(res);
  const userId = String(req.params.id ?? '').trim();
  if (!userId)
    return res
      .status(400)
      .json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'User id is required.' } });

  try {
    const userRes = await pool.query<{
      id: string;
      display_name: string;
      handle: string | null;
      email: string;
      avatar_url: string | null;
      role: string;
      admin_scope: string | null;
      home_municipality: string | null;
      is_public: boolean;
      is_test: boolean;
      demo_points: number;
      scout_reputation: number;
      session_epoch: number;
      suspended_at: Date | null;
      suspended_reason: string | null;
      suspended_by: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, display_name, handle, email, avatar_url, role::text AS role, admin_scope,
              home_municipality, is_public, is_test, demo_points, scout_reputation,
              COALESCE(session_epoch, 0)::int AS session_epoch,
              suspended_at, suspended_reason, suspended_by, created_at, updated_at
         FROM users
        WHERE id = $1`,
      [userId],
    );

    const userRow = userRes.rows[0];
    if (!userRow) {
      return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found.' } });
    }

    await writeAdminAudit({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      action: 'user.view',
      subjectType: 'user',
      subjectId: userId,
    });

    const [
      identitiesRes,
      passwordRes,
      areaRes,
      balancesRes,
      deviceRes,
      stampLedgerRes,
      pointsLedgerRes,
      badgesRes,
      attemptsRes,
      submissionsRes,
      reportsFiledRes,
      reportsReceivedRes,
      riskFlagsRes,
      auditRes,
    ] = await Promise.all([
      pool.query<{ provider: string }>(
        'SELECT DISTINCT provider FROM auth_identities WHERE user_id = $1 ORDER BY provider',
        [userId],
      ),
      pool.query<{ has_password: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM password_credentials WHERE user_id = $1) AS has_password',
        [userId],
      ),
      pool.query<{
        id: string;
        area_id: string;
        area_name: string;
        powers: string[];
        granted_at: Date;
        revoked_at: Date | null;
      }>(
        `SELECT aa.id, aa.area_id, a.display_name AS area_name, aa.powers, aa.granted_at, aa.revoked_at
           FROM admin_area_assignments aa
           JOIN admin_areas a ON a.id = aa.area_id
          WHERE aa.user_id = $1
          ORDER BY aa.revoked_at NULLS FIRST, a.display_name`,
        [userId],
      ),
      pool.query<{
        stamps: number;
        explorer_xp: string;
        civic_xp: string;
        last_event_at: Date | null;
      }>(
        `SELECT COALESCE((SELECT balance FROM stamp_balances WHERE user_id = $1), 0)::int AS stamps,
                COALESCE(pt.explorer_xp, 0)::bigint AS explorer_xp,
                COALESCE(pt.civic_xp, 0)::bigint AS civic_xp,
                pt.last_event_at
           FROM (SELECT 1) _
           LEFT JOIN progression_totals pt ON pt.user_id = $1`,
        [userId],
      ),
      pool.query<{ last_seen_at: Date | null }>(
        'SELECT MAX(last_seen_at) AS last_seen_at FROM user_devices WHERE user_id = $1',
        [userId],
      ),
      pool.query(
        `SELECT id, delta, source, source_key, manila_date::text AS manila_date, reason, is_test, created_at
           FROM stamp_ledger WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20`,
        [userId],
      ),
      pool.query(
        `SELECT id, type, amount_mjdq, (amount_mjdq::numeric / 1000.0)::float AS points_delta,
                reference_type, reference_id, COALESCE(metadata->>'reason', metadata->>'description', reference_type) AS reason, created_at
           FROM governance_ledger WHERE account = $1 ORDER BY created_at DESC, id DESC LIMIT 20`,
        [userId],
      ),
      pool.query(
        `SELECT a.id, a.achievement_id, d.title, d.track, d.badge_icon, a.season, a.awarded_at, a.revoked_at, a.revocation_reason
           FROM achievement_awards a
           JOIN achievement_definitions d ON d.id = a.achievement_id
          WHERE a.user_id = $1
          ORDER BY a.awarded_at DESC
          LIMIT 20`,
        [userId],
      ),
      pool.query(
        `SELECT qa.id, qa.quest_id, q.title AS quest_title, qa.status::text AS status,
                qa.current_step, qa.total_steps, qa.verified_steps, qa.required_steps, qa.created_at, qa.completed_at
           FROM quest_attempts qa
           LEFT JOIN quests q ON q.id = qa.quest_id
          WHERE qa.user_id = $1
          ORDER BY qa.created_at DESC
          LIMIT 20`,
        [userId],
      ),
      pool.query(
        `SELECT s.id, s.quest_id, q.title AS quest_title, s.status::text AS status,
                s.rejection_reason, s.reviewed_at, s.created_at
           FROM submissions s
           LEFT JOIN quests q ON q.id = s.quest_id
          WHERE s.user_id = $1
          ORDER BY s.created_at DESC
          LIMIT 20`,
        [userId],
      ),
      pool.query(
        `SELECT * FROM (
           SELECT 'spot'::text AS kind, sr.spot_id AS target_id, sr.reason, sr.status, sr.created_at
             FROM spot_reports sr WHERE sr.user_id = $1
           UNION ALL
           SELECT 'comment'::text AS kind, scr.comment_id AS target_id, scr.reason, COALESCE(scr.resolution, 'pending') AS status, scr.created_at
             FROM social_comment_reports scr WHERE scr.reporter_id = $1
           UNION ALL
           SELECT 'avatar'::text AS kind, ar.user_id AS target_id, ar.reason, ar.status, ar.created_at
             FROM avatar_reports ar WHERE ar.reporter_id = $1
         ) r ORDER BY r.created_at DESC LIMIT 20`,
        [userId],
      ),
      pool.query(
        `SELECT * FROM (
           SELECT 'spot'::text AS kind, sr.spot_id AS target_id, sr.user_id AS reporter_id, sr.reason, sr.status, sr.created_at
             FROM spot_reports sr JOIN spots sp ON sp.id = sr.spot_id WHERE sp.created_by = $1
           UNION ALL
           SELECT 'comment'::text AS kind, scr.comment_id AS target_id, scr.reporter_id, scr.reason, COALESCE(scr.resolution, 'pending') AS status, scr.created_at
             FROM social_comment_reports scr JOIN social_comments sc ON sc.id = scr.comment_id WHERE sc.author_id = $1
           UNION ALL
           SELECT 'avatar'::text AS kind, ar.user_id AS target_id, ar.reporter_id, ar.reason, ar.status, ar.created_at
             FROM avatar_reports ar WHERE ar.user_id = $1
         ) r ORDER BY r.created_at DESC LIMIT 20`,
        [userId],
      ),
      pool.query(
        `SELECT rf.id, rf.rule, rf.severity, rf.window_start, rf.window_end, rf.evidence,
                rf.status, rf.reviewed_by, rv.display_name AS reviewed_by_name, rf.reviewed_at, rf.review_note, rf.created_at
           FROM risk_flags rf
           LEFT JOIN users rv ON rv.id = rf.reviewed_by
          WHERE rf.user_id = $1
          ORDER BY rf.created_at DESC`,
        [userId],
      ),
      pool.query(
        `SELECT a.id, a.actor_id, actor.display_name AS actor_name, a.actor_role, a.action, a.before, a.after, a.created_at
           FROM admin_audit_log a
           LEFT JOIN users actor ON actor.id = a.actor_id
          WHERE a.subject_type = 'user' AND a.subject_id = $1
          ORDER BY a.created_at DESC
          LIMIT 50`,
        [userId],
      ),
    ]);

    const { entities } = await resolveEvidenceEntities(
      pool,
      riskFlagsRes.rows.map((r) => (r.evidence ?? {}) as Record<string, unknown>),
    );

    const bal = balancesRes.rows[0];
    const devSeen = deviceRes.rows[0]?.last_seen_at ? new Date(deviceRes.rows[0].last_seen_at) : null;
    const evtAt = bal?.last_event_at ? new Date(bal.last_event_at) : null;
    const lastActive =
      devSeen && evtAt
        ? (devSeen > evtAt ? devSeen : evtAt).toISOString()
        : ((devSeen ?? evtAt)?.toISOString() ?? null);

    return res.json({
      success: true,
      data: {
        profile: {
          id: userRow.id,
          display_name: userRow.display_name,
          handle: userRow.handle ?? null,
          email: userRow.email,
          avatar_url: userRow.avatar_url ?? null,
          role: userRow.role,
          admin_scope: userRow.admin_scope ?? null,
          home_municipality: userRow.home_municipality ?? null,
          is_public: Boolean(userRow.is_public),
          is_test: Boolean(userRow.is_test),
          session_epoch: Number(userRow.session_epoch ?? 0),
          suspended_at: userRow.suspended_at ? new Date(userRow.suspended_at).toISOString() : null,
          suspended_reason: userRow.suspended_reason ?? null,
          suspended_by: userRow.suspended_by ?? null,
          created_at: new Date(userRow.created_at).toISOString(),
          updated_at: new Date(userRow.updated_at).toISOString(),
          last_active_at: lastActive,
          sign_in_methods: {
            providers: identitiesRes.rows.map((r) => r.provider),
            has_password: Boolean(passwordRes.rows[0]?.has_password),
          },
          area_assignments: areaRes.rows,
          area_admin_endpoints: {
            list: '/api/v1/admin/area-admins',
            areas: '/api/v1/admin/area-admins/areas',
          },
        },
        balances: {
          points: Number(userRow.demo_points),
          stamps: Number(bal?.stamps ?? 0),
          explorer_xp: Number(bal?.explorer_xp ?? 0),
          civic_xp: Number(bal?.civic_xp ?? 0),
          scout_reputation: Number(userRow.scout_reputation ?? 0),
        },
        stamp_ledger: stampLedgerRes.rows,
        points_ledger: pointsLedgerRes.rows,
        badge_awards: badgesRes.rows,
        quest_attempts: attemptsRes.rows,
        submissions: submissionsRes.rows,
        reports_filed: reportsFiledRes.rows,
        reports_received: reportsReceivedRes.rows,
        risk_flags: riskFlagsRes.rows,
        resolved_entities: entities,
        admin_log: auditRes.rows,
      },
    });
  } catch (err) {
    log.error('[admin-users] detail failed:', { error: err instanceof Error ? err.message : err });
    return dbUnavailable(res);
  }
});

adminUsersRouter.post('/admin/users/:id/suspend', ...adminWriteGuard, async (req: AuthRequest, res: Response) => {
  noStore(res);
  const pool = getPool();
  if (!pool) return dbUnavailable(res);
  const targetId = String(req.params.id ?? '').trim();
  const parsed = reasonBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: parsed.error.issues[0]?.message ?? 'Reason must be 3 to 300 characters.',
      },
    });
  }
  if (targetId === req.user!.id) {
    return res.status(409).json({
      success: false,
      error: { code: 'CANNOT_SUSPEND_SELF', message: 'You cannot suspend your own account.' },
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{
      id: string;
      role: string;
      session_epoch: number;
      suspended_at: Date | null;
      suspended_reason: string | null;
      suspended_by: string | null;
    }>(
      'SELECT id, role::text AS role, COALESCE(session_epoch, 0)::int AS session_epoch, suspended_at, suspended_reason, suspended_by FROM users WHERE id = $1 FOR UPDATE',
      [targetId],
    );
    const target = current.rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found.' } });
    }
    if (target.role === 'admin') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        error: { code: 'CANNOT_SUSPEND_ADMIN', message: 'Administrator accounts cannot be suspended.' },
      });
    }
    if (target.suspended_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        error: { code: 'ALREADY_SUSPENDED', message: 'This user account is already suspended.' },
      });
    }

    const updated = await client.query<{ suspended_at: Date; session_epoch: number }>(
      `UPDATE users
          SET suspended_at = NOW(),
              suspended_reason = $2,
              suspended_by = $3,
              session_epoch = COALESCE(session_epoch, 0) + 1,
              updated_at = NOW()
        WHERE id = $1
        RETURNING suspended_at, session_epoch`,
      [targetId, parsed.data.reason, req.user!.id],
    );
    await client.query(
      `UPDATE user_devices
          SET disabled_at = NOW(),
              disabled_reason = 'suspended'
        WHERE user_id = $1 AND disabled_at IS NULL`,
      [targetId],
    );
    const suspendedAtIso = new Date(updated.rows[0].suspended_at).toISOString();
    const newEpoch = Number(updated.rows[0].session_epoch);
    await client.query(
      `INSERT INTO admin_audit_log (id, actor_id, actor_role, action, subject_type, subject_id, before, after)
       VALUES (gen_random_uuid()::text, $1, $2, 'user.suspend', 'user', $3, $4::jsonb, $5::jsonb)`,
      [
        req.user!.id,
        req.user!.role,
        targetId,
        JSON.stringify({ suspended_at: null, session_epoch: target.session_epoch }),
        JSON.stringify({
          suspended_at: suspendedAtIso,
          suspended_reason: parsed.data.reason,
          suspended_by: req.user!.id,
          session_epoch: newEpoch,
        }),
      ],
    );
    await client.query('COMMIT');

    const memUser = db.findUserById(targetId);
    if (memUser) {
      memUser.suspended_at = suspendedAtIso;
      memUser.suspended_reason = parsed.data.reason;
      memUser.suspended_by = req.user!.id;
      memUser.session_epoch = newEpoch;
    }
    invalidateSessionScopeCache(targetId);

    return res.json({
      success: true,
      data: {
        user_id: targetId,
        suspended_at: suspendedAtIso,
        suspended_reason: parsed.data.reason,
        suspended_by: req.user!.id,
        session_epoch: newEpoch,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    log.error('[admin-users] suspend failed:', { error: err instanceof Error ? err.message : err });
    return dbUnavailable(res);
  } finally {
    client.release();
  }
});

adminUsersRouter.post('/admin/users/:id/unsuspend', ...adminWriteGuard, async (req: AuthRequest, res: Response) => {
  noStore(res);
  const pool = getPool();
  if (!pool) return dbUnavailable(res);
  const targetId = String(req.params.id ?? '').trim();
  const parsed = reasonBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: parsed.error.issues[0]?.message ?? 'Reason must be 3 to 300 characters.',
      },
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{
      id: string;
      suspended_at: Date | null;
      suspended_reason: string | null;
      suspended_by: string | null;
    }>('SELECT id, suspended_at, suspended_reason, suspended_by FROM users WHERE id = $1 FOR UPDATE', [targetId]);
    const target = current.rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found.' } });
    }
    if (!target.suspended_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        error: { code: 'NOT_SUSPENDED', message: 'This user account is not suspended.' },
      });
    }

    await client.query(
      `UPDATE users
          SET suspended_at = NULL,
              suspended_reason = NULL,
              suspended_by = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [targetId],
    );
    await client.query(
      `INSERT INTO admin_audit_log (id, actor_id, actor_role, action, subject_type, subject_id, before, after)
       VALUES (gen_random_uuid()::text, $1, $2, 'user.unsuspend', 'user', $3, $4::jsonb, $5::jsonb)`,
      [
        req.user!.id,
        req.user!.role,
        targetId,
        JSON.stringify({
          suspended_at: new Date(target.suspended_at).toISOString(),
          suspended_reason: target.suspended_reason,
          suspended_by: target.suspended_by,
        }),
        JSON.stringify({ suspended_at: null, reason: parsed.data.reason }),
      ],
    );
    await client.query('COMMIT');

    const memUser = db.findUserById(targetId);
    if (memUser) {
      memUser.suspended_at = null;
      memUser.suspended_reason = null;
      memUser.suspended_by = null;
    }
    invalidateSessionScopeCache(targetId);

    return res.json({ success: true, data: { user_id: targetId, suspended_at: null } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    log.error('[admin-users] unsuspend failed:', { error: err instanceof Error ? err.message : err });
    return dbUnavailable(res);
  } finally {
    client.release();
  }
});

adminUsersRouter.post('/admin/users/:id/sign-out', ...adminWriteGuard, async (req: AuthRequest, res: Response) => {
  noStore(res);
  const pool = getPool();
  if (!pool) return dbUnavailable(res);
  const targetId = String(req.params.id ?? '').trim();
  const parsed = reasonBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: parsed.error.issues[0]?.message ?? 'Reason must be 3 to 300 characters.',
      },
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ id: string; session_epoch: number }>(
      'SELECT id, COALESCE(session_epoch, 0)::int AS session_epoch FROM users WHERE id = $1 FOR UPDATE',
      [targetId],
    );
    const target = current.rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found.' } });
    }

    const updated = await client.query<{ session_epoch: number }>(
      'UPDATE users SET session_epoch = COALESCE(session_epoch, 0) + 1, updated_at = NOW() WHERE id = $1 RETURNING session_epoch',
      [targetId],
    );
    const nextEpoch = Number(updated.rows[0].session_epoch);
    await client.query(
      `INSERT INTO admin_audit_log (id, actor_id, actor_role, action, subject_type, subject_id, before, after)
       VALUES (gen_random_uuid()::text, $1, $2, 'user.sign_out', 'user', $3, $4::jsonb, $5::jsonb)`,
      [
        req.user!.id,
        req.user!.role,
        targetId,
        JSON.stringify({ session_epoch: target.session_epoch }),
        JSON.stringify({ session_epoch: nextEpoch, reason: parsed.data.reason }),
      ],
    );
    await client.query('COMMIT');

    const memUser = db.findUserById(targetId);
    if (memUser) memUser.session_epoch = nextEpoch;
    invalidateSessionScopeCache(targetId);

    return res.json({ success: true, data: { user_id: targetId, session_epoch: nextEpoch } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    log.error('[admin-users] sign-out failed:', { error: err instanceof Error ? err.message : err });
    return dbUnavailable(res);
  } finally {
    client.release();
  }
});

// =====================================================================
// WP-2: Token and badge monitoring
// =====================================================================

adminUsersRouter.get('/admin/economy/monitor', ...adminReadGuard, async (req: AuthRequest, res: Response) => {
  noStore(res);
  const pool = getPool();
  if (!pool) return dbUnavailable(res);

  const daysParam = req.query.days === undefined || req.query.days === '' ? 30 : Number(req.query.days);
  if (![7, 30, 90].includes(daysParam)) {
    return res
      .status(400)
      .json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'days must be 7, 30, or 90.' } });
  }
  const includeTest = parseIncludeTest(req.query.include_test);

  try {
    const clockRes = await pool.query<{ db_now: Date }>('SELECT NOW() AS db_now');
    const now = new Date(clockRes.rows[0].db_now);
    const manilaToday = startOfManilaDay(now);
    const fromDate = new Date(manilaToday.getTime() - (daysParam - 1) * 86_400_000);
    const fromIso = fromDate.toISOString();
    const toIso = now.toISOString();

    const [
      pointsSeriesRes,
      stampsSeriesRes,
      xpSeriesRes,
      badgesAwardedSeriesRes,
      badgesRevokedSeriesRes,
      grantsSeriesRes,
      topPointsRes,
      topStampsRes,
      topXpRes,
      pointsSourceRes,
      stampsSourceRes,
      daysGridRes,
    ] = await Promise.all([
      pool.query<{ day: string; issued: number; spent: number }>(
        `SELECT to_char((gl.created_at AT TIME ZONE 'Asia/Manila')::date, 'YYYY-MM-DD') AS day,
                ROUND(COALESCE(SUM(CASE WHEN gl.amount_mjdq > 0 THEN gl.amount_mjdq ELSE 0 END), 0)::numeric / 1000.0, 2)::float AS issued,
                ROUND(COALESCE(SUM(CASE WHEN gl.amount_mjdq < 0 THEN -gl.amount_mjdq ELSE 0 END), 0)::numeric / 1000.0, 2)::float AS spent
           FROM governance_ledger gl
           JOIN users u ON u.id = gl.account
          WHERE ($3 = TRUE OR COALESCE(u.is_test, FALSE) = FALSE)
            AND gl.created_at >= $1::timestamptz AND gl.created_at <= $2::timestamptz
          GROUP BY 1`,
        [fromIso, toIso, includeTest],
      ),
      pool.query<{ day: string; issued: number; spent: number }>(
        `SELECT to_char((sl.created_at AT TIME ZONE 'Asia/Manila')::date, 'YYYY-MM-DD') AS day,
                COALESCE(SUM(CASE WHEN sl.delta > 0 THEN sl.delta ELSE 0 END), 0)::bigint::float AS issued,
                COALESCE(SUM(CASE WHEN sl.delta < 0 THEN -sl.delta ELSE 0 END), 0)::bigint::float AS spent
           FROM stamp_ledger sl
           JOIN users u ON u.id = sl.user_id
          WHERE ($3 = TRUE OR (NOT sl.is_test AND COALESCE(u.is_test, FALSE) = FALSE))
            AND sl.created_at >= $1::timestamptz AND sl.created_at <= $2::timestamptz
          GROUP BY 1`,
        [fromIso, toIso, includeTest],
      ),
      pool.query<{ day: string; awarded: number }>(
        `SELECT to_char((pe.created_at AT TIME ZONE 'Asia/Manila')::date, 'YYYY-MM-DD') AS day,
                COALESCE(SUM(CASE WHEN pe.delta > 0 THEN pe.delta ELSE 0 END), 0)::bigint::float AS awarded
           FROM progression_events pe
           JOIN users u ON u.id = pe.user_id
          WHERE pe.track = 'explorer'
            AND ($3 = TRUE OR (NOT pe.is_test AND COALESCE(u.is_test, FALSE) = FALSE))
            AND pe.created_at >= $1::timestamptz AND pe.created_at <= $2::timestamptz
          GROUP BY 1`,
        [fromIso, toIso, includeTest],
      ),
      pool.query<{ day: string; count: number }>(
        `SELECT to_char((aa.awarded_at AT TIME ZONE 'Asia/Manila')::date, 'YYYY-MM-DD') AS day,
                COUNT(*)::int AS count
           FROM achievement_awards aa
           JOIN users u ON u.id = aa.user_id
          WHERE ($3 = TRUE OR (NOT aa.is_test AND COALESCE(u.is_test, FALSE) = FALSE))
            AND aa.awarded_at >= $1::timestamptz AND aa.awarded_at <= $2::timestamptz
          GROUP BY 1`,
        [fromIso, toIso, includeTest],
      ),
      pool.query<{ day: string; count: number }>(
        `SELECT to_char((aa.revoked_at AT TIME ZONE 'Asia/Manila')::date, 'YYYY-MM-DD') AS day,
                COUNT(*)::int AS count
           FROM achievement_awards aa
           JOIN users u ON u.id = aa.user_id
          WHERE aa.revoked_at IS NOT NULL
            AND ($3 = TRUE OR (NOT aa.is_test AND COALESCE(u.is_test, FALSE) = FALSE))
            AND aa.revoked_at >= $1::timestamptz AND aa.revoked_at <= $2::timestamptz
          GROUP BY 1`,
        [fromIso, toIso, includeTest],
      ),
      pool.query<{ day: string; count: number; total_points: number }>(
        `SELECT to_char((g.created_at AT TIME ZONE 'Asia/Manila')::date, 'YYYY-MM-DD') AS day,
                COUNT(*)::int AS count,
                COALESCE(SUM(g.points), 0)::bigint::float AS total_points
           FROM admin_point_grants g
           JOIN users u ON u.id = g.user_id
          WHERE ($3 = TRUE OR (NOT g.is_test AND COALESCE(u.is_test, FALSE) = FALSE))
            AND g.created_at >= $1::timestamptz AND g.created_at <= $2::timestamptz
          GROUP BY 1`,
        [fromIso, toIso, includeTest],
      ),
      pool.query<{ user_id: string; display_name: string; handle: string | null; amount: number }>(
        `SELECT u.id AS user_id, u.display_name, u.handle,
                ROUND(SUM(gl.amount_mjdq)::numeric / 1000.0, 2)::float AS amount
           FROM governance_ledger gl
           JOIN users u ON u.id = gl.account
          WHERE gl.amount_mjdq > 0
            AND ($3 = TRUE OR COALESCE(u.is_test, FALSE) = FALSE)
            AND gl.created_at >= $1::timestamptz AND gl.created_at <= $2::timestamptz
          GROUP BY u.id, u.display_name, u.handle
          ORDER BY amount DESC, u.id ASC
          LIMIT 20`,
        [fromIso, toIso, includeTest],
      ),
      pool.query<{ user_id: string; display_name: string; handle: string | null; amount: number }>(
        `SELECT u.id AS user_id, u.display_name, u.handle,
                SUM(sl.delta)::bigint::float AS amount
           FROM stamp_ledger sl
           JOIN users u ON u.id = sl.user_id
          WHERE sl.delta > 0
            AND ($3 = TRUE OR (NOT sl.is_test AND COALESCE(u.is_test, FALSE) = FALSE))
            AND sl.created_at >= $1::timestamptz AND sl.created_at <= $2::timestamptz
          GROUP BY u.id, u.display_name, u.handle
          ORDER BY amount DESC, u.id ASC
          LIMIT 20`,
        [fromIso, toIso, includeTest],
      ),
      pool.query<{ user_id: string; display_name: string; handle: string | null; amount: number }>(
        `SELECT u.id AS user_id, u.display_name, u.handle,
                SUM(pe.delta)::bigint::float AS amount
           FROM progression_events pe
           JOIN users u ON u.id = pe.user_id
          WHERE pe.track = 'explorer' AND pe.delta > 0
            AND ($3 = TRUE OR (NOT pe.is_test AND COALESCE(u.is_test, FALSE) = FALSE))
            AND pe.created_at >= $1::timestamptz AND pe.created_at <= $2::timestamptz
          GROUP BY u.id, u.display_name, u.handle
          ORDER BY amount DESC, u.id ASC
          LIMIT 20`,
        [fromIso, toIso, includeTest],
      ),
      pool.query<{ source: string; issued: number; count: number }>(
        `SELECT COALESCE(NULLIF(gl.type, ''), gl.reference_type) AS source,
                ROUND(COALESCE(SUM(gl.amount_mjdq), 0)::numeric / 1000.0, 2)::float AS issued,
                COUNT(*)::int AS count
           FROM governance_ledger gl
           JOIN users u ON u.id = gl.account
          WHERE gl.amount_mjdq > 0
            AND ($3 = TRUE OR COALESCE(u.is_test, FALSE) = FALSE)
            AND gl.created_at >= $1::timestamptz AND gl.created_at <= $2::timestamptz
          GROUP BY 1
          ORDER BY issued DESC, source ASC`,
        [fromIso, toIso, includeTest],
      ),
      pool.query<{ source: string; issued: number; count: number }>(
        `SELECT sl.source,
                COALESCE(SUM(sl.delta), 0)::bigint::float AS issued,
                COUNT(*)::int AS count
           FROM stamp_ledger sl
           JOIN users u ON u.id = sl.user_id
          WHERE sl.delta > 0
            AND ($3 = TRUE OR (NOT sl.is_test AND COALESCE(u.is_test, FALSE) = FALSE))
            AND sl.created_at >= $1::timestamptz AND sl.created_at <= $2::timestamptz
          GROUP BY 1
          ORDER BY issued DESC, sl.source ASC`,
        [fromIso, toIso, includeTest],
      ),
      pool.query<{ day: string }>(
        `SELECT to_char(gs::date, 'YYYY-MM-DD') AS day
           FROM generate_series(
             ($1::timestamptz AT TIME ZONE 'Asia/Manila')::date,
             ($2::timestamptz AT TIME ZONE 'Asia/Manila')::date,
             interval '1 day'
           ) AS gs`,
        [fromIso, toIso],
      ),
    ]);

    const pByDay = new Map(pointsSeriesRes.rows.map((r) => [r.day, r]));
    const sByDay = new Map(stampsSeriesRes.rows.map((r) => [r.day, r]));
    const xByDay = new Map(xpSeriesRes.rows.map((r) => [r.day, r]));
    const baByDay = new Map(badgesAwardedSeriesRes.rows.map((r) => [r.day, r.count]));
    const brByDay = new Map(badgesRevokedSeriesRes.rows.map((r) => [r.day, r.count]));
    const gByDay = new Map(grantsSeriesRes.rows.map((r) => [r.day, r]));

    const daily_series = daysGridRes.rows.map(({ day }) => {
      const p = pByDay.get(day);
      const s = sByDay.get(day);
      const x = xByDay.get(day);
      const g = gByDay.get(day);
      return {
        date: day,
        points_issued: Number(p?.issued ?? 0),
        points_spent: Number(p?.spent ?? 0),
        stamps_issued: Number(s?.issued ?? 0),
        stamps_spent: Number(s?.spent ?? 0),
        explorer_xp_awarded: Number(x?.awarded ?? 0),
        badges_awarded: Number(baByDay.get(day) ?? 0),
        badges_revoked: Number(brByDay.get(day) ?? 0),
        admin_point_grants_count: Number(g?.count ?? 0),
        admin_point_grants_sum: Number(g?.total_points ?? 0),
      };
    });

    const totals = daily_series.reduce(
      (acc, d) => ({
        points_issued: Number((acc.points_issued + d.points_issued).toFixed(2)),
        points_spent: Number((acc.points_spent + d.points_spent).toFixed(2)),
        stamps_issued: acc.stamps_issued + d.stamps_issued,
        stamps_spent: acc.stamps_spent + d.stamps_spent,
        explorer_xp_awarded: acc.explorer_xp_awarded + d.explorer_xp_awarded,
        badges_awarded: acc.badges_awarded + d.badges_awarded,
        badges_revoked: acc.badges_revoked + d.badges_revoked,
        admin_point_grants_count: acc.admin_point_grants_count + d.admin_point_grants_count,
        admin_point_grants_sum: acc.admin_point_grants_sum + d.admin_point_grants_sum,
      }),
      {
        points_issued: 0,
        points_spent: 0,
        stamps_issued: 0,
        stamps_spent: 0,
        explorer_xp_awarded: 0,
        badges_awarded: 0,
        badges_revoked: 0,
        admin_point_grants_count: 0,
        admin_point_grants_sum: 0,
      },
    );

    return res.json({
      success: true,
      data: {
        window: { days: daysParam, from: fromIso, to: toIso },
        totals,
        daily_series,
        top_earners: {
          points: topPointsRes.rows,
          stamps: topStampsRes.rows,
          xp: topXpRes.rows,
        },
        issuance_by_source: {
          points: pointsSourceRes.rows,
          stamps: stampsSourceRes.rows,
        },
      },
    });
  } catch (err) {
    log.error('[admin-economy] monitor failed:', { error: err instanceof Error ? err.message : err });
    return dbUnavailable(res);
  }
});

adminUsersRouter.get('/admin/economy/ledger', ...adminReadGuard, async (req: AuthRequest, res: Response) => {
  noStore(res);
  const pool = getPool();
  if (!pool) return dbUnavailable(res);

  const kindRaw = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : 'points';
  if (!['points', 'stamps', 'xp', 'badges'].includes(kindRaw)) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'kind must be points, stamps, xp, or badges.' },
    });
  }
  const kind = kindRaw as 'points' | 'stamps' | 'xp' | 'badges';

  const limit = parseLimit(req.query.limit, 25);
  if (limit === null) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'limit must be an integer from 1 to 100.' },
    });
  }

  const userIdFilter = typeof req.query.user_id === 'string' ? req.query.user_id.trim() : '';
  const sourceFilter = typeof req.query.source === 'string' ? req.query.source.trim() : '';
  const fromRaw = typeof req.query.from === 'string' ? req.query.from.trim() : '';
  const toRaw = typeof req.query.to === 'string' ? req.query.to.trim() : '';
  if ((fromRaw && Number.isNaN(Date.parse(fromRaw))) || (toRaw && Number.isNaN(Date.parse(toRaw)))) {
    return res
      .status(400)
      .json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'from/to must be valid ISO timestamps.' } });
  }

  let cursorAt: string | null = null;
  let cursorId: string | null = null;
  if (req.query.cursor !== undefined && req.query.cursor !== '') {
    const parsed = decodeCursor<{ k?: string; at?: string; id?: string }>(req.query.cursor);
    if (!parsed || parsed.k !== kind || !parsed.at || Number.isNaN(Date.parse(parsed.at)) || !parsed.id) {
      return res
        .status(400)
        .json({ success: false, error: { code: 'INVALID_CURSOR', message: 'Invalid ledger cursor.' } });
    }
    cursorAt = parsed.at;
    cursorId = String(parsed.id);
  }

  const includeTest = parseIncludeTest(req.query.include_test);

  try {
    const params: unknown[] = [includeTest];
    const conds: string[] = [];

    const addParam = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };

    let sql = '';
    if (kind === 'points') {
      conds.push('($1 = TRUE OR COALESCE(u.is_test, FALSE) = FALSE)');
      if (userIdFilter) conds.push(`gl.account = ${addParam(userIdFilter)}::text`);
      if (sourceFilter)
        conds.push(`COALESCE(NULLIF(gl.type, ''), gl.reference_type) = ${addParam(sourceFilter)}::text`);
      if (fromRaw) conds.push(`gl.created_at >= ${addParam(fromRaw)}::timestamptz`);
      if (toRaw) conds.push(`gl.created_at <= ${addParam(toRaw)}::timestamptz`);
      if (cursorAt && cursorId) {
        const pAt = addParam(cursorAt);
        const pId = addParam(cursorId);
        conds.push(`(gl.created_at, gl.id) < (${pAt}::timestamptz, ${pId}::text)`);
      }
      const pLim = addParam(limit + 1);
      sql = `SELECT gl.id, gl.account AS user_id, u.display_name,
                    ROUND(gl.amount_mjdq::numeric / 1000.0, 2)::float AS delta,
                    NULL::text AS award,
                    COALESCE(NULLIF(gl.type, ''), gl.reference_type) AS source,
                    COALESCE(gl.metadata->>'reason', gl.metadata->>'description', gl.reference_type) AS reason,
                    gl.created_at
               FROM governance_ledger gl
               JOIN users u ON u.id = gl.account
              WHERE ${conds.join(' AND ')}
              ORDER BY gl.created_at DESC, gl.id DESC
              LIMIT ${pLim}`;
    } else if (kind === 'stamps') {
      conds.push('($1 = TRUE OR (NOT sl.is_test AND COALESCE(u.is_test, FALSE) = FALSE))');
      if (userIdFilter) conds.push(`sl.user_id = ${addParam(userIdFilter)}::text`);
      if (sourceFilter) conds.push(`sl.source = ${addParam(sourceFilter)}::text`);
      if (fromRaw) conds.push(`sl.created_at >= ${addParam(fromRaw)}::timestamptz`);
      if (toRaw) conds.push(`sl.created_at <= ${addParam(toRaw)}::timestamptz`);
      if (cursorAt && cursorId) {
        const pAt = addParam(cursorAt);
        const pId = addParam(cursorId);
        conds.push(`(sl.created_at, sl.id::text) < (${pAt}::timestamptz, ${pId}::text)`);
      }
      const pLim = addParam(limit + 1);
      sql = `SELECT sl.id::text AS id, sl.user_id, u.display_name,
                    sl.delta::int AS delta,
                    NULL::text AS award,
                    sl.source,
                    COALESCE(sl.reason, sl.source_key) AS reason,
                    sl.created_at
               FROM stamp_ledger sl
               JOIN users u ON u.id = sl.user_id
              WHERE ${conds.join(' AND ')}
              ORDER BY sl.created_at DESC, sl.id DESC
              LIMIT ${pLim}`;
    } else if (kind === 'xp') {
      conds.push(`pe.track = 'explorer'`);
      conds.push('($1 = TRUE OR (NOT pe.is_test AND COALESCE(u.is_test, FALSE) = FALSE))');
      if (userIdFilter) conds.push(`pe.user_id = ${addParam(userIdFilter)}::text`);
      if (sourceFilter) conds.push(`pe.source_type = ${addParam(sourceFilter)}::text`);
      if (fromRaw) conds.push(`pe.created_at >= ${addParam(fromRaw)}::timestamptz`);
      if (toRaw) conds.push(`pe.created_at <= ${addParam(toRaw)}::timestamptz`);
      if (cursorAt && cursorId) {
        const pAt = addParam(cursorAt);
        const pId = addParam(cursorId);
        conds.push(`(pe.created_at, pe.id::text) < (${pAt}::timestamptz, ${pId}::text)`);
      }
      const pLim = addParam(limit + 1);
      sql = `SELECT pe.id::text AS id, pe.user_id, u.display_name,
                    pe.delta::bigint::float AS delta,
                    NULL::text AS award,
                    pe.source_type AS source,
                    pe.award_kind AS reason,
                    pe.created_at
               FROM progression_events pe
               JOIN users u ON u.id = pe.user_id
              WHERE ${conds.join(' AND ')}
              ORDER BY pe.created_at DESC, pe.id DESC
              LIMIT ${pLim}`;
    } else {
      conds.push('($1 = TRUE OR (NOT aa.is_test AND COALESCE(u.is_test, FALSE) = FALSE))');
      if (userIdFilter) conds.push(`aa.user_id = ${addParam(userIdFilter)}::text`);
      if (sourceFilter) conds.push(`d.track = ${addParam(sourceFilter)}::text`);
      if (fromRaw) conds.push(`aa.awarded_at >= ${addParam(fromRaw)}::timestamptz`);
      if (toRaw) conds.push(`aa.awarded_at <= ${addParam(toRaw)}::timestamptz`);
      if (cursorAt && cursorId) {
        const pAt = addParam(cursorAt);
        const pId = addParam(cursorId);
        conds.push(`(aa.awarded_at, aa.id::text) < (${pAt}::timestamptz, ${pId}::text)`);
      }
      const pLim = addParam(limit + 1);
      sql = `SELECT aa.id::text AS id, aa.user_id, u.display_name,
                    NULL::float AS delta,
                    d.title AS award,
                    d.track AS source,
                    CASE WHEN aa.revoked_at IS NOT NULL THEN COALESCE(aa.revocation_reason, 'revoked') ELSE aa.season END AS reason,
                    aa.awarded_at AS created_at
               FROM achievement_awards aa
               JOIN users u ON u.id = aa.user_id
               JOIN achievement_definitions d ON d.id = aa.achievement_id
              WHERE ${conds.join(' AND ')}
              ORDER BY aa.awarded_at DESC, aa.id DESC
              LIMIT ${pLim}`;
    }

    const { rows } = await pool.query(sql, params);
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit).map((r: any) => ({
      id: String(r.id),
      user_id: String(r.user_id),
      display_name: String(r.display_name),
      delta: r.delta === null || r.delta === undefined ? null : Number(r.delta),
      award: r.award ?? null,
      source: String(r.source),
      reason: r.reason ? String(r.reason) : null,
      created_at: new Date(r.created_at).toISOString(),
    }));
    const last = pageRows[pageRows.length - 1];
    const next_cursor = hasMore && last ? encodeCursor({ k: kind, at: last.created_at, id: last.id }) : null;

    return res.json({ success: true, data: { items: pageRows, next_cursor, has_more: hasMore } });
  } catch (err) {
    log.error('[admin-economy] ledger failed:', { error: err instanceof Error ? err.message : err });
    return dbUnavailable(res);
  }
});

adminUsersRouter.get('/admin/badges', ...adminReadGuard, async (req: AuthRequest, res: Response) => {
  noStore(res);
  const pool = getPool();
  if (!pool) return dbUnavailable(res);
  const includeTest = parseIncludeTest(req.query.include_test);
  const config = getChainConfig();

  try {
    const { rows } = await pool.query<{
      id: string;
      track: string;
      title: string;
      description: string;
      badge_icon: string;
      category: string;
      threshold: number;
      is_active: boolean;
      award_count: number;
      revoked_count: number;
      minted_on_chain_count: number;
      last_awarded_at: Date | null;
    }>(
      `SELECT d.id, d.track, d.title, d.description, d.badge_icon, d.category, d.threshold, d.is_active,
              COUNT(a.id) FILTER (
                WHERE a.id IS NOT NULL AND a.revoked_at IS NULL
                  AND ($1 = TRUE OR (NOT a.is_test AND COALESCE(u.is_test, FALSE) = FALSE))
              )::int AS award_count,
              COUNT(a.id) FILTER (
                WHERE a.id IS NOT NULL AND a.revoked_at IS NOT NULL
                  AND ($1 = TRUE OR (NOT a.is_test AND COALESCE(u.is_test, FALSE) = FALSE))
              )::int AS revoked_count,
              COUNT(c.id) FILTER (
                WHERE c.id IS NOT NULL AND c.status = 'finalized' AND a.revoked_at IS NULL
                  AND ($1 = TRUE OR (NOT a.is_test AND COALESCE(u.is_test, FALSE) = FALSE))
              )::int AS minted_on_chain_count,
              MAX(a.awarded_at) FILTER (
                WHERE a.id IS NOT NULL
                  AND ($1 = TRUE OR (NOT a.is_test AND COALESCE(u.is_test, FALSE) = FALSE))
              ) AS last_awarded_at
         FROM achievement_definitions d
         LEFT JOIN achievement_awards a ON a.achievement_id = d.id
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN chain_commands c ON c.chain_id = $2 AND c.operation = 'badge_claim' AND c.source_award_id = a.id
        GROUP BY d.id, d.track, d.title, d.description, d.badge_icon, d.category, d.threshold, d.is_active
        ORDER BY d.track ASC, d.threshold ASC, d.title ASC`,
      [includeTest, config.chainId],
    );

    return res.json({
      success: true,
      data: {
        items: rows.map((r) => ({
          ...r,
          last_awarded_at: r.last_awarded_at ? new Date(r.last_awarded_at).toISOString() : null,
        })),
      },
    });
  } catch (err) {
    log.error('[admin-economy] badges failed:', { error: err instanceof Error ? err.message : err });
    return dbUnavailable(res);
  }
});

// =====================================================================
// WP-3: Suspicious activity
// =====================================================================

const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

adminUsersRouter.get('/admin/risk/flags', ...adminReadGuard, async (req: AuthRequest, res: Response) => {
  noStore(res);
  const pool = getPool();
  if (!pool) return dbUnavailable(res);

  const limit = parseLimit(req.query.limit, 25);
  if (limit === null) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'limit must be an integer from 1 to 100.' },
    });
  }

  const statusRaw = typeof req.query.status === 'string' && req.query.status ? req.query.status : 'open';
  if (!['open', 'dismissed', 'actioned', 'all'].includes(statusRaw)) {
    return res
      .status(400)
      .json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid status filter.' } });
  }

  const sevRaw = typeof req.query.severity === 'string' && req.query.severity ? req.query.severity : '';
  if (sevRaw && !['low', 'medium', 'high'].includes(sevRaw)) {
    return res
      .status(400)
      .json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid severity filter.' } });
  }

  const ruleRaw = typeof req.query.rule === 'string' && req.query.rule ? req.query.rule : '';
  if (ruleRaw && !(RISK_RULE_NAMES as readonly string[]).includes(ruleRaw)) {
    return res
      .status(400)
      .json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid rule filter.' } });
  }

  const includeTest = parseIncludeTest(req.query.include_test);
  const conds: string[] = ['($1 = TRUE OR (NOT rf.is_test AND COALESCE(u.is_test, FALSE) = FALSE))'];
  const params: unknown[] = [includeTest];

  if (statusRaw !== 'all') {
    params.push(statusRaw);
    conds.push(`rf.status = $${params.length}`);
  }
  if (sevRaw) {
    params.push(sevRaw);
    conds.push(`rf.severity = $${params.length}`);
  }
  if (ruleRaw) {
    params.push(ruleRaw);
    conds.push(`rf.rule = $${params.length}`);
  }

  if (req.query.cursor !== undefined && req.query.cursor !== '') {
    const parsed = decodeCursor<{ sevRank?: number; at?: string; id?: string }>(req.query.cursor);
    if (
      !parsed ||
      !Number.isInteger(parsed.sevRank) ||
      !parsed.at ||
      Number.isNaN(Date.parse(parsed.at)) ||
      !parsed.id
    ) {
      return res
        .status(400)
        .json({ success: false, error: { code: 'INVALID_CURSOR', message: 'Invalid flags cursor.' } });
    }
    params.push(parsed.sevRank, parsed.at, parsed.id);
    const pR = `$${params.length - 2}`;
    const pAt = `$${params.length - 1}`;
    const pId = `$${params.length}`;
    conds.push(
      `(CASE rf.severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END, rf.created_at, rf.id) < (${pR}::int, ${pAt}::timestamptz, ${pId}::text)`,
    );
  }

  params.push(limit + 1);
  const pLim = `$${params.length}`;

  try {
    const [flagsRes, summaryRes] = await Promise.all([
      pool.query(
        `SELECT rf.id, rf.user_id, rf.rule, rf.severity, rf.window_start, rf.window_end, rf.evidence,
                rf.status, rf.reviewed_by, rv.display_name AS reviewed_by_name, rf.reviewed_at, rf.review_note, rf.created_at,
                u.display_name AS user_display_name, u.handle AS user_handle, u.email AS user_email,
                u.role::text AS user_role, u.suspended_at AS user_suspended_at
           FROM risk_flags rf
           JOIN users u ON u.id = rf.user_id
           LEFT JOIN users rv ON rv.id = rf.reviewed_by
          WHERE ${conds.join(' AND ')}
          ORDER BY CASE rf.severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
                   rf.created_at DESC, rf.id DESC
          LIMIT ${pLim}`,
        params,
      ),
      pool.query<{ rule: RiskRuleName; count: number }>(
        `SELECT rf.rule, COUNT(*)::int AS count
           FROM risk_flags rf
           JOIN users u ON u.id = rf.user_id
          WHERE ($1 = TRUE OR (NOT rf.is_test AND COALESCE(u.is_test, FALSE) = FALSE))
            AND rf.created_at >= NOW() - interval '30 days'
          GROUP BY rf.rule`,
        [includeTest],
      ),
    ]);

    const hasMore = flagsRes.rows.length > limit;
    const pageRows = flagsRes.rows.slice(0, limit);
    const { entities } = await resolveEvidenceEntities(
      pool,
      pageRows.map((r: any) => (r.evidence ?? {}) as Record<string, unknown>),
    );

    const summary_30d = Object.fromEntries(RISK_RULE_NAMES.map((r) => [r, 0])) as Record<RiskRuleName, number>;
    for (const row of summaryRes.rows) {
      if (row.rule in summary_30d) summary_30d[row.rule] = Number(row.count);
    }

    const items = pageRows.map((r: any) => ({
      id: r.id,
      user_id: r.user_id,
      user: {
        id: r.user_id,
        display_name: r.user_display_name,
        handle: r.user_handle ?? null,
        masked_email: maskEmail(r.user_email),
        role: r.user_role,
        suspended_at: r.user_suspended_at ? new Date(r.user_suspended_at).toISOString() : null,
      },
      rule: r.rule,
      severity: r.severity,
      window_start: new Date(r.window_start).toISOString(),
      window_end: new Date(r.window_end).toISOString(),
      evidence: r.evidence ?? {},
      status: r.status,
      reviewed_by: r.reviewed_by ?? null,
      reviewed_by_name: r.reviewed_by_name ?? null,
      reviewed_at: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
      review_note: r.review_note ?? null,
      created_at: new Date(r.created_at).toISOString(),
    }));

    const last = items[items.length - 1];
    const next_cursor =
      hasMore && last
        ? encodeCursor({ sevRank: SEVERITY_RANK[last.severity] ?? 1, at: last.created_at, id: last.id })
        : null;

    return res.json({
      success: true,
      data: {
        items,
        next_cursor,
        has_more: hasMore,
        summary_30d,
        resolved_entities: entities,
      },
    });
  } catch (err) {
    log.error('[admin-risk] list flags failed:', { error: err instanceof Error ? err.message : err });
    return dbUnavailable(res);
  }
});

adminUsersRouter.post('/admin/risk/flags/:id/review', ...adminWriteGuard, async (req: AuthRequest, res: Response) => {
  noStore(res);
  const pool = getPool();
  if (!pool) return dbUnavailable(res);
  const flagId = String(req.params.id ?? '').trim();
  const parsed = reviewFlagBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid review body.' },
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{
      id: string;
      user_id: string;
      rule: string;
      status: string;
      review_note: string | null;
    }>('SELECT id, user_id, rule, status, review_note FROM risk_flags WHERE id = $1 FOR UPDATE', [flagId]);
    const existing = current.rows[0];
    if (!existing) {
      await client.query('ROLLBACK');
      return res
        .status(404)
        .json({ success: false, error: { code: 'FLAG_NOT_FOUND', message: 'Risk flag not found.' } });
    }

    const updated = await client.query<{ status: string; reviewed_by: string; reviewed_at: Date; review_note: string }>(
      `UPDATE risk_flags
          SET status = $2,
              reviewed_by = $3,
              reviewed_at = NOW(),
              review_note = $4
        WHERE id = $1
        RETURNING status, reviewed_by, reviewed_at, review_note`,
      [flagId, parsed.data.status, req.user!.id, parsed.data.note],
    );

    await client.query(
      `INSERT INTO admin_audit_log (id, actor_id, actor_role, action, subject_type, subject_id, before, after)
       VALUES (gen_random_uuid()::text, $1, $2, 'risk_flag.review', 'risk_flag', $3, $4::jsonb, $5::jsonb)`,
      [
        req.user!.id,
        req.user!.role,
        flagId,
        JSON.stringify({
          status: existing.status,
          review_note: existing.review_note,
          user_id: existing.user_id,
          rule: existing.rule,
        }),
        JSON.stringify({
          status: parsed.data.status,
          review_note: parsed.data.note,
          user_id: existing.user_id,
          rule: existing.rule,
        }),
      ],
    );
    await client.query('COMMIT');

    const row = updated.rows[0];
    return res.json({
      success: true,
      data: {
        id: flagId,
        status: row.status,
        reviewed_by: row.reviewed_by,
        reviewed_at: new Date(row.reviewed_at).toISOString(),
        review_note: row.review_note,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    log.error('[admin-risk] review failed:', { error: err instanceof Error ? err.message : err });
    return dbUnavailable(res);
  } finally {
    client.release();
  }
});

adminUsersRouter.post(
  '/admin/risk/scan',
  ...adminWriteGuard,
  rateLimit({ policyId: 'admin:risk-scan', windowMs: 60_000, max: 1, keyStrategy: 'actor' }),
  async (req: AuthRequest, res: Response) => {
    noStore(res);
    const pool = getPool();
    if (!pool) return dbUnavailable(res);

    try {
      const result = await runRiskScan(pool);
      if (!result.acquired) {
        return res.status(409).json({
          success: false,
          error: { code: 'SCAN_IN_PROGRESS', message: 'A suspicious-activity scan is already running.' },
        });
      }
      await writeAdminAudit({
        actorId: req.user!.id,
        actorRole: req.user!.role,
        action: 'risk.scan',
        subjectType: 'system',
        subjectId: 'risk_scan',
        after: result,
      });
      return res.json({ success: true, data: result });
    } catch (err) {
      log.error('[admin-risk] manual scan failed:', { error: err instanceof Error ? err.message : err });
      return dbUnavailable(res);
    }
  },
);
