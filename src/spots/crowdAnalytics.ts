import type { Pool } from 'pg';
import { type AdminScope } from '../admin/scope.js';
import { calculateCrowdMetrics, type ActivityEventInput, type CrowdCapacityBand } from './crowd.js';

export type CrowdGranularity = 'day' | 'week' | 'month';

export interface CrowdQueryOptions {
  from?: string;
  to?: string;
  granularity?: CrowdGranularity;
  municipality?: string;
  category?: string;
  q?: string;
  spotId?: string;
  onsiteHours?: number;
  includeTest?: boolean;
}

const BUSY_THRESHOLD: Record<CrowdCapacityBand, number> = {
  low: 8,
  medium: 15,
  high: 30,
};

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function maskSmallCount(value: number, isPlatform: boolean): number | '<3' {
  if (isPlatform) return value;
  return value > 0 && value < 3 ? '<3' : value;
}

function manilaTodayDateString(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function shiftDateDays(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function daysBetweenInclusive(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}

function normalizeDateYmd(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return fallback;
  return manilaTodayDateString(new Date(parsed));
}

function resolveWindow(options: CrowdQueryOptions) {
  const today = manilaTodayDateString();
  const defaultFrom = shiftDateDays(today, -29);
  const fromYmd = normalizeDateYmd(options.from, defaultFrom);
  let toYmd = normalizeDateYmd(options.to, today);
  if (toYmd < fromYmd) toYmd = fromYmd;
  const spanDays = Math.min(366, daysBetweenInclusive(fromYmd, toYmd));
  const clampedFrom = daysBetweenInclusive(fromYmd, toYmd) > 366 ? shiftDateDays(toYmd, -365) : fromYmd;
  const prevTo = shiftDateDays(clampedFrom, -1);
  const prevFrom = shiftDateDays(prevTo, -(spanDays - 1));
  const granularity: CrowdGranularity =
    options.granularity ?? (spanDays > 120 ? 'month' : spanDays > 45 ? 'week' : 'day');
  const onsiteHours = Math.max(1, Math.min(6, Math.round(options.onsiteHours ?? 2)));
  return { fromYmd: clampedFrom, toYmd, prevFrom, prevTo, spanDays, granularity, onsiteHours };
}

function analyticsAreaIds(scope: AdminScope): string[] {
  if (scope.platform) return [];
  return [
    ...new Set(scope.grants.filter((grant) => grant.powers.has('analytics')).flatMap((grant) => [...grant.areaIds])),
  ];
}

async function loadScopedSpots(pool: Pool, scope: AdminScope, options: CrowdQueryOptions, includeTest: boolean) {
  const areaIds = analyticsAreaIds(scope);
  if (!scope.platform && areaIds.length === 0) return [];

  const result = await pool.query(
    `SELECT id, name, slug, category, municipality, crowd_capacity_band,
            recommendation_suppressed, recommendation_suppressed_until, is_test, status
       FROM spots
      WHERE ($1::boolean = TRUE OR is_test = FALSE)
        AND ($2::boolean = TRUE OR town_area_id = ANY($3::text[]) OR barangay_area_id = ANY($3::text[]))
        AND ($4::text IS NULL OR LOWER(municipality) = LOWER($4))
        AND ($5::text IS NULL OR category = $5)
        AND ($6::text IS NULL OR id = $6 OR slug = $6)
        AND ($7::text IS NULL OR name ILIKE '%' || $7 || '%' OR municipality ILIKE '%' || $7 || '%')
      ORDER BY name, id`,
    [
      includeTest,
      scope.platform,
      areaIds,
      options.municipality?.trim() || null,
      options.category?.trim() || null,
      options.spotId?.trim() || null,
      options.q?.trim() || null,
    ],
  );
  return result.rows;
}

function bucketExpression(granularity: CrowdGranularity, col: string): string {
  if (granularity === 'month') {
    return `TO_CHAR(DATE_TRUNC('month', ${col} AT TIME ZONE 'Asia/Manila'), 'YYYY-MM-DD')`;
  }
  if (granularity === 'week') {
    return `TO_CHAR(DATE_TRUNC('week', ${col} AT TIME ZONE 'Asia/Manila'), 'YYYY-MM-DD')`;
  }
  return `TO_CHAR((${col} AT TIME ZONE 'Asia/Manila')::date, 'YYYY-MM-DD')`;
}

function pctDelta(current: number, previous: number): number | null {
  if (previous <= 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export async function getCrowdOverview(pool: Pool, scope: AdminScope, options: CrowdQueryOptions) {
  const includeTest = scope.platform && Boolean(options.includeTest);
  const isPlatform = scope.platform;
  const win = resolveWindow(options);
  const spots = await loadScopedSpots(pool, scope, options, includeTest);
  const spotIds = spots.map((s: any) => String(s.id));

  if (!spotIds.length) {
    return {
      window: win,
      filters_applied: {
        municipality: options.municipality ?? null,
        category: options.category ?? null,
        q: options.q ?? null,
        spot_id: options.spotId ?? null,
        include_test: includeTest,
      },
      privacy_masked: !isPlatform,
      kpis: {
        unique_visitors: 0,
        verified_visits: 0,
        on_site_now: 0,
        interactions: 0,
        planning_to_go: 0,
        trail_checkins: 0,
        proofs: { approved: 0, pending: 0, rejected: 0 },
        busiest_hour: null,
        busiest_day: null,
      },
      previous_period: {
        unique_visitors: 0,
        verified_visits: 0,
        interactions: 0,
        delta_pct: { unique_visitors: 0, verified_visits: 0, interactions: 0 },
      },
      new_vs_returning: { new_visitors: 0, returning_visitors: 0 },
      locals_vs_visitors: { locals: 0, visitors: 0, unknown: 0 },
      conversion_funnel: {
        views: 0,
        directions: 0,
        verified_visits: 0,
        view_to_directions_pct: 0,
        directions_to_visit_pct: 0,
        view_to_visit_pct: 0,
      },
      average_dwell_minutes: 0,
      peak_capacity_alerts: [],
      timeseries: [],
      category_breakdown: [],
      top_destinations: [],
      filter_options: { municipalities: [], categories: [] },
    };
  }

  const fromBound = `($2::date::timestamp AT TIME ZONE 'Asia/Manila')`;
  const toBound = `(($3::date + 1)::timestamp AT TIME ZONE 'Asia/Manila')`;
  const bucketVv = bucketExpression(win.granularity, 'vv.occurred_at');
  const bucketEv = bucketExpression(win.granularity, 'sae.created_at');
  const bucketTc = bucketExpression(win.granularity, 'tc.verified_at');
  const bucketSub = bucketExpression(win.granularity, 'sub.created_at');

  const [
    visitsRes,
    eventsRes,
    trailRes,
    proofsRes,
    onsiteRes,
    recent24hRes,
    prevRes,
    newReturnRes,
    localsRes,
    dwellRes,
    hourlyPeakRes,
    filterOptsRes,
  ] = await Promise.all([
    pool.query(
      `SELECT vv.spot_id, ${bucketVv} AS bucket,
              EXTRACT(HOUR FROM vv.occurred_at AT TIME ZONE 'Asia/Manila')::int AS m_hour,
              EXTRACT(DOW FROM vv.occurred_at AT TIME ZONE 'Asia/Manila')::int AS m_dow,
              vv.user_id
         FROM verified_visits vv
        WHERE vv.spot_id = ANY($1::text[])
          AND vv.revoked_at IS NULL
          AND ($4::boolean = TRUE OR vv.is_test = FALSE)
          AND vv.occurred_at >= ${fromBound}
          AND vv.occurred_at < ${toBound}`,
      [spotIds, win.fromYmd, win.toYmd, includeTest],
    ),
    pool.query(
      `SELECT sae.spot_id, sae.activity_type, ${bucketEv} AS bucket,
              EXTRACT(HOUR FROM sae.created_at AT TIME ZONE 'Asia/Manila')::int AS m_hour,
              EXTRACT(DOW FROM sae.created_at AT TIME ZONE 'Asia/Manila')::int AS m_dow,
              sae.user_id
         FROM spot_activity_events sae
        WHERE sae.spot_id = ANY($1::text[])
          AND ($4::boolean = TRUE OR sae.is_test = FALSE)
          AND sae.created_at >= ${fromBound}
          AND sae.created_at < ${toBound}`,
      [spotIds, win.fromYmd, win.toYmd, includeTest],
    ),
    pool.query(
      `SELECT ts.spot_id, ${bucketTc} AS bucket,
              EXTRACT(HOUR FROM tc.verified_at AT TIME ZONE 'Asia/Manila')::int AS m_hour,
              EXTRACT(DOW FROM tc.verified_at AT TIME ZONE 'Asia/Manila')::int AS m_dow,
              tc.user_id
         FROM trail_checkins tc
         JOIN trail_stops ts ON ts.trail_id = tc.trail_id AND ts.position = tc.position
         JOIN trails t ON t.id = tc.trail_id
        WHERE ts.spot_id = ANY($1::text[])
          AND ($4::boolean = TRUE OR t.is_test = FALSE)
          AND tc.verified_at >= ${fromBound}
          AND tc.verified_at < ${toBound}`,
      [spotIds, win.fromYmd, win.toYmd, includeTest],
    ),
    pool.query(
      `WITH quest_spots AS (
         SELECT quest_id, id AS spot_id FROM spots WHERE id = ANY($1::text[]) AND quest_id IS NOT NULL
         UNION
         SELECT quest_id, spot_id FROM reviewed_quest_spot_bindings WHERE spot_id = ANY($1::text[]) AND status = 'active'
       )
       SELECT qs.spot_id, sub.status, ${bucketSub} AS bucket, COUNT(*)::int AS cnt
         FROM submissions sub
         JOIN quest_spots qs ON qs.quest_id = sub.quest_id
         JOIN users u ON u.id = sub.user_id
        WHERE ($4::boolean = TRUE OR u.is_test = FALSE)
          AND sub.created_at >= ${fromBound}
          AND sub.created_at < ${toBound}
        GROUP BY qs.spot_id, sub.status, ${bucketSub}`,
      [spotIds, win.fromYmd, win.toYmd, includeTest],
    ),
    pool.query(
      `WITH quest_spots AS (
         SELECT quest_id, id AS spot_id FROM spots WHERE id = ANY($1::text[]) AND quest_id IS NOT NULL
         UNION
         SELECT quest_id, spot_id FROM reviewed_quest_spot_bindings WHERE spot_id = ANY($1::text[]) AND status = 'active'
       )
       SELECT spot_id, user_id FROM (
         SELECT vv.spot_id, vv.user_id
           FROM verified_visits vv
          WHERE vv.spot_id = ANY($1::text[]) AND vv.revoked_at IS NULL
            AND ($3::boolean = TRUE OR vv.is_test = FALSE)
            AND vv.occurred_at >= NOW() - ($2::int * INTERVAL '1 hour')
         UNION
         SELECT ts.spot_id, tc.user_id
           FROM trail_checkins tc
           JOIN trail_stops ts ON ts.trail_id = tc.trail_id AND ts.position = tc.position
           JOIN trails t ON t.id = tc.trail_id
          WHERE ts.spot_id = ANY($1::text[])
            AND ($3::boolean = TRUE OR t.is_test = FALSE)
            AND tc.verified_at >= NOW() - ($2::int * INTERVAL '1 hour')
         UNION
         SELECT qs.spot_id, qa.user_id
           FROM quest_attempts qa
           JOIN quest_spots qs ON qs.quest_id = qa.quest_id
           JOIN users u ON u.id = qa.user_id
          WHERE ($3::boolean = TRUE OR u.is_test = FALSE)
            AND GREATEST(qa.created_at, qa.updated_at) >= NOW() - ($2::int * INTERVAL '1 hour')
         UNION
         SELECT qs.spot_id, h.user_id
           FROM quest_funding_holds h
           JOIN quest_funding_plans p ON p.id = h.plan_id
           JOIN quest_spots qs ON qs.quest_id = p.quest_id
          WHERE h.status = 'held'
            AND ($3::boolean = TRUE OR p.is_test = FALSE)
            AND h.created_at >= NOW() - ($2::int * INTERVAL '1 hour')
       ) onsite`,
      [spotIds, win.onsiteHours, includeTest],
    ),
    pool.query(
      `SELECT id, user_id, spot_id, activity_type, created_at, is_test
         FROM spot_activity_events
        WHERE spot_id = ANY($1::text[])
          AND ($2::boolean = TRUE OR is_test = FALSE)
          AND created_at >= NOW() - INTERVAL '24 hours'`,
      [spotIds, includeTest],
    ),
    pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM verified_visits vv
           WHERE vv.spot_id = ANY($1::text[]) AND vv.revoked_at IS NULL
             AND ($4::boolean = TRUE OR vv.is_test = FALSE)
             AND vv.occurred_at >= ${fromBound} AND vv.occurred_at < ${toBound}) AS prev_visits,
         (SELECT COUNT(DISTINCT vv.user_id)::int FROM verified_visits vv
           WHERE vv.spot_id = ANY($1::text[]) AND vv.revoked_at IS NULL
             AND ($4::boolean = TRUE OR vv.is_test = FALSE)
             AND vv.occurred_at >= ${fromBound} AND vv.occurred_at < ${toBound}) AS prev_unique,
         (SELECT COUNT(*)::int FROM spot_activity_events sae
           WHERE sae.spot_id = ANY($1::text[])
             AND ($4::boolean = TRUE OR sae.is_test = FALSE)
             AND sae.created_at >= ${fromBound} AND sae.created_at < ${toBound}) AS prev_interactions`,
      [spotIds, win.prevFrom, win.prevTo, includeTest],
    ),
    pool.query(
      `WITH first_seen AS (
         SELECT user_id, MIN(ts) AS first_at FROM (
           SELECT user_id, occurred_at AS ts FROM verified_visits
            WHERE spot_id = ANY($1::text[]) AND revoked_at IS NULL AND ($4::boolean = TRUE OR is_test = FALSE)
           UNION ALL
           SELECT tc.user_id, tc.verified_at AS ts FROM trail_checkins tc
             JOIN trail_stops ts ON ts.trail_id = tc.trail_id AND ts.position = tc.position
             JOIN trails t ON t.id = tc.trail_id
            WHERE ts.spot_id = ANY($1::text[]) AND ($4::boolean = TRUE OR t.is_test = FALSE)
         ) all_v
         GROUP BY user_id
       )
       SELECT
         COUNT(*) FILTER (WHERE first_at >= ${fromBound} AND first_at < ${toBound})::int AS new_visitors,
         COUNT(*) FILTER (WHERE first_at < ${fromBound} AND EXISTS (
           SELECT 1 FROM verified_visits vv2
            WHERE vv2.user_id = first_seen.user_id AND vv2.spot_id = ANY($1::text[])
              AND vv2.revoked_at IS NULL AND ($4::boolean = TRUE OR vv2.is_test = FALSE)
              AND vv2.occurred_at >= ${fromBound} AND vv2.occurred_at < ${toBound}
           UNION ALL
           SELECT 1 FROM trail_checkins tc2
             JOIN trail_stops ts2 ON ts2.trail_id = tc2.trail_id AND ts2.position = tc2.position
             JOIN trails t2 ON t2.id = tc2.trail_id
            WHERE tc2.user_id = first_seen.user_id AND ts2.spot_id = ANY($1::text[])
              AND ($4::boolean = TRUE OR t2.is_test = FALSE)
              AND tc2.verified_at >= ${fromBound} AND tc2.verified_at < ${toBound}
         ))::int AS returning_visitors
       FROM first_seen`,
      [spotIds, win.fromYmd, win.toYmd, includeTest],
    ),
    pool.query(
      `WITH visitors AS (
         SELECT DISTINCT vv.user_id, s.municipality AS spot_municipality, u.home_municipality
           FROM verified_visits vv
           JOIN spots s ON s.id = vv.spot_id
           JOIN users u ON u.id = vv.user_id
          WHERE vv.spot_id = ANY($1::text[]) AND vv.revoked_at IS NULL
            AND ($4::boolean = TRUE OR vv.is_test = FALSE)
            AND vv.occurred_at >= ${fromBound} AND vv.occurred_at < ${toBound}
       )
       SELECT
         COUNT(*) FILTER (WHERE home_municipality IS NOT NULL AND TRIM(home_municipality) <> '' AND LOWER(TRIM(home_municipality)) = LOWER(TRIM(spot_municipality)))::int AS locals,
         COUNT(*) FILTER (WHERE home_municipality IS NOT NULL AND TRIM(home_municipality) <> '' AND LOWER(TRIM(home_municipality)) <> LOWER(TRIM(spot_municipality)))::int AS visitors,
         COUNT(*) FILTER (WHERE home_municipality IS NULL OR TRIM(home_municipality) = '')::int AS unknown
       FROM visitors`,
      [spotIds, win.fromYmd, win.toYmd, includeTest],
    ),
    pool.query(
      `WITH events AS (
         SELECT user_id, spot_id, (created_at AT TIME ZONE 'Asia/Manila')::date AS m_day, created_at AS ts
           FROM spot_activity_events
          WHERE spot_id = ANY($1::text[]) AND ($4::boolean = TRUE OR is_test = FALSE)
            AND created_at >= ${fromBound} AND created_at < ${toBound}
         UNION ALL
         SELECT user_id, spot_id, (occurred_at AT TIME ZONE 'Asia/Manila')::date AS m_day, occurred_at AS ts
           FROM verified_visits
          WHERE spot_id = ANY($1::text[]) AND revoked_at IS NULL AND ($4::boolean = TRUE OR is_test = FALSE)
            AND occurred_at >= ${fromBound} AND occurred_at < ${toBound}
       ),
       per_day AS (
         SELECT spot_id, user_id, m_day, EXTRACT(EPOCH FROM (MAX(ts) - MIN(ts))) / 60.0 AS mins, COUNT(*) AS cnt
           FROM events
          GROUP BY spot_id, user_id, m_day
         HAVING COUNT(*) > 1
       )
       SELECT spot_id, ROUND(AVG(mins)::numeric, 1) AS avg_mins
         FROM per_day
        GROUP BY spot_id`,
      [spotIds, win.fromYmd, win.toYmd, includeTest],
    ),
    pool.query(
      `SELECT spot_id, hour_bucket, SUM(weight)::numeric AS pressure
         FROM (
           SELECT sae.spot_id,
                  TO_CHAR(DATE_TRUNC('hour', sae.created_at AT TIME ZONE 'Asia/Manila'), 'YYYY-MM-DD HH24:00') AS hour_bucket,
                  CASE sae.activity_type
                    WHEN 'view' THEN 0.25
                    WHEN 'directions' THEN 3
                    WHEN 'save' THEN 2
                    WHEN 'visit' THEN 5
                    ELSE 0
                  END AS weight
             FROM spot_activity_events sae
            WHERE sae.spot_id = ANY($1::text[]) AND ($4::boolean = TRUE OR sae.is_test = FALSE)
              AND sae.created_at >= ${fromBound} AND sae.created_at < ${toBound}
           UNION ALL
           SELECT vv.spot_id,
                  TO_CHAR(DATE_TRUNC('hour', vv.occurred_at AT TIME ZONE 'Asia/Manila'), 'YYYY-MM-DD HH24:00') AS hour_bucket,
                  5 AS weight
             FROM verified_visits vv
            WHERE vv.spot_id = ANY($1::text[]) AND vv.revoked_at IS NULL AND ($4::boolean = TRUE OR vv.is_test = FALSE)
              AND vv.occurred_at >= ${fromBound} AND vv.occurred_at < ${toBound}
         ) w
        GROUP BY spot_id, hour_bucket
        ORDER BY hour_bucket DESC`,
      [spotIds, win.fromYmd, win.toYmd, includeTest],
    ),
    pool.query(
      `SELECT DISTINCT municipality, category FROM spots WHERE id = ANY($1::text[]) ORDER BY municipality, category`,
      [spotIds],
    ),
  ]);

  const spotById = new Map<string, any>(spots.map((s: any) => [String(s.id), s]));
  const events24BySpot = new Map<string, ActivityEventInput[]>();
  for (const row of recent24hRes.rows) {
    const list = events24BySpot.get(row.spot_id) ?? [];
    list.push({
      id: row.id,
      user_id: row.user_id,
      spot_id: row.spot_id,
      activity_type: row.activity_type,
      created_at: row.created_at,
      is_test: Boolean(row.is_test),
    });
    events24BySpot.set(row.spot_id, list);
  }

  const uniqueVisitorsAll = new Set<string>();
  const uniqueVisitorsBySpot = new Map<string, Set<string>>();
  const onsiteAll = new Set<string>();
  const onsiteBySpot = new Map<string, Set<string>>();
  const hourCounts = new Array(24).fill(0);
  const dowCounts = new Array(7).fill(0);

  const tsMap = new Map<
    string,
    {
      bucket: string;
      verified_visits: number;
      visitors: Set<string>;
      interactions: number;
      planning_to_go: number;
      trail_checkins: number;
      proofs: number;
    }
  >();
  const ensureBucket = (bucket: string) => {
    let entry = tsMap.get(bucket);
    if (!entry) {
      entry = {
        bucket,
        verified_visits: 0,
        visitors: new Set<string>(),
        interactions: 0,
        planning_to_go: 0,
        trail_checkins: 0,
        proofs: 0,
      };
      tsMap.set(bucket, entry);
    }
    return entry;
  };

  const spotStats = new Map<
    string,
    {
      verified_visits: number;
      interactions: number;
      views: number;
      directions: number;
      saves: number;
      planning_to_go: number;
      trail_checkins: number;
      proofs_approved: number;
      proofs_pending: number;
      proofs_rejected: number;
    }
  >();
  const ensureSpotStats = (spotId: string) => {
    let entry = spotStats.get(spotId);
    if (!entry) {
      entry = {
        verified_visits: 0,
        interactions: 0,
        views: 0,
        directions: 0,
        saves: 0,
        planning_to_go: 0,
        trail_checkins: 0,
        proofs_approved: 0,
        proofs_pending: 0,
        proofs_rejected: 0,
      };
      spotStats.set(spotId, entry);
    }
    return entry;
  };

  for (const row of visitsRes.rows) {
    const sid = String(row.spot_id);
    const uid = String(row.user_id);
    uniqueVisitorsAll.add(uid);
    const sSet = uniqueVisitorsBySpot.get(sid) ?? new Set<string>();
    sSet.add(uid);
    uniqueVisitorsBySpot.set(sid, sSet);

    const st = ensureSpotStats(sid);
    st.verified_visits += 1;

    const b = ensureBucket(row.bucket);
    b.verified_visits += 1;
    b.visitors.add(uid);

    if (row.m_hour >= 0 && row.m_hour < 24) hourCounts[row.m_hour] += 1;
    if (row.m_dow >= 0 && row.m_dow < 7) dowCounts[row.m_dow] += 1;
  }

  let totalViews = 0;
  let totalDirections = 0;
  let totalPlanning = 0;
  for (const row of eventsRes.rows) {
    const sid = String(row.spot_id);
    const st = ensureSpotStats(sid);
    st.interactions += 1;
    const b = ensureBucket(row.bucket);
    b.interactions += 1;
    if (row.activity_type === 'view') {
      st.views += 1;
      totalViews += 1;
    } else if (row.activity_type === 'directions') {
      st.directions += 1;
      st.planning_to_go += 1;
      totalDirections += 1;
      totalPlanning += 1;
      b.planning_to_go += 1;
    } else if (row.activity_type === 'save') {
      st.saves += 1;
      st.planning_to_go += 1;
      totalPlanning += 1;
      b.planning_to_go += 1;
    }
    if (row.m_hour >= 0 && row.m_hour < 24) hourCounts[row.m_hour] += 1;
    if (row.m_dow >= 0 && row.m_dow < 7) dowCounts[row.m_dow] += 1;
  }

  for (const row of trailRes.rows) {
    const sid = String(row.spot_id);
    const uid = String(row.user_id);
    uniqueVisitorsAll.add(uid);
    const sSet = uniqueVisitorsBySpot.get(sid) ?? new Set<string>();
    sSet.add(uid);
    uniqueVisitorsBySpot.set(sid, sSet);

    const st = ensureSpotStats(sid);
    st.trail_checkins += 1;

    const b = ensureBucket(row.bucket);
    b.trail_checkins += 1;
    b.visitors.add(uid);

    if (row.m_hour >= 0 && row.m_hour < 24) hourCounts[row.m_hour] += 1;
    if (row.m_dow >= 0 && row.m_dow < 7) dowCounts[row.m_dow] += 1;
  }

  let proofsApproved = 0;
  let proofsPending = 0;
  let proofsRejected = 0;
  for (const row of proofsRes.rows) {
    const sid = String(row.spot_id);
    const cnt = Number(row.cnt);
    const st = ensureSpotStats(sid);
    const b = ensureBucket(row.bucket);
    b.proofs += cnt;
    if (row.status === 'approved') {
      st.proofs_approved += cnt;
      proofsApproved += cnt;
    } else if (row.status === 'pending') {
      st.proofs_pending += cnt;
      proofsPending += cnt;
    } else if (row.status === 'rejected') {
      st.proofs_rejected += cnt;
      proofsRejected += cnt;
    }
  }

  for (const row of onsiteRes.rows) {
    const sid = String(row.spot_id);
    const uid = String(row.user_id);
    onsiteAll.add(uid);
    const sSet = onsiteBySpot.get(sid) ?? new Set<string>();
    sSet.add(uid);
    onsiteBySpot.set(sid, sSet);
  }

  const dwellBySpot = new Map<string, number>();
  let dwellSum = 0;
  let dwellCount = 0;
  for (const row of dwellRes.rows) {
    const mins = Number(row.avg_mins ?? 0);
    dwellBySpot.set(row.spot_id, mins);
    dwellSum += mins;
    dwellCount += 1;
  }

  const peakCapacityAlerts: Array<{
    spot_id: string;
    spot_name: string;
    hour_bucket: string;
    pressure_score: number;
    threshold: number;
    capacity_band: CrowdCapacityBand;
  }> = [];
  for (const row of hourlyPeakRes.rows) {
    const spot = spotById.get(row.spot_id);
    if (!spot) continue;
    const band = (spot.crowd_capacity_band || 'medium') as CrowdCapacityBand;
    const threshold = BUSY_THRESHOLD[band] ?? 15;
    const pressure = Number(row.pressure);
    if (pressure >= threshold) {
      peakCapacityAlerts.push({
        spot_id: spot.id,
        spot_name: spot.name,
        hour_bucket: row.hour_bucket,
        pressure_score: Math.round(pressure * 100) / 100,
        threshold,
        capacity_band: band,
      });
    }
  }

  const maxHourVal = Math.max(...hourCounts);
  const busiestHour = maxHourVal > 0 ? hourCounts.indexOf(maxHourVal) : null;
  const maxDowVal = Math.max(...dowCounts);
  const busiestDay = maxDowVal > 0 ? DOW_LABELS[dowCounts.indexOf(maxDowVal)] : null;

  const timeseries = [...tsMap.values()]
    .sort((a, b) => a.bucket.localeCompare(b.bucket))
    .map((b) => ({
      bucket: b.bucket,
      verified_visits: maskSmallCount(b.verified_visits, isPlatform),
      unique_visitors: maskSmallCount(b.visitors.size, isPlatform),
      interactions: maskSmallCount(b.interactions, isPlatform),
      planning_to_go: maskSmallCount(b.planning_to_go, isPlatform),
      trail_checkins: maskSmallCount(b.trail_checkins, isPlatform),
      proofs: maskSmallCount(b.proofs, isPlatform),
    }));

  const categoryAgg = new Map<
    string,
    { spots: number; verified_visits: number; interactions: number; onsite: Set<string> }
  >();
  const topDestinations = spots.map((s: any) => {
    const st = ensureSpotStats(s.id);
    const band = (s.crowd_capacity_band || 'medium') as CrowdCapacityBand;
    const crowdNow = calculateCrowdMetrics(events24BySpot.get(s.id) ?? [], band, Date.now(), includeTest);
    const onsiteCount = onsiteBySpot.get(s.id)?.size ?? 0;
    const uniqueCount = uniqueVisitorsBySpot.get(s.id)?.size ?? 0;

    const catEntry = categoryAgg.get(s.category) ?? {
      spots: 0,
      verified_visits: 0,
      interactions: 0,
      onsite: new Set<string>(),
    };
    catEntry.spots += 1;
    catEntry.verified_visits += st.verified_visits;
    catEntry.interactions += st.interactions;
    for (const u of onsiteBySpot.get(s.id) ?? []) catEntry.onsite.add(u);
    categoryAgg.set(s.category, catEntry);

    return {
      spot_id: s.id,
      name: s.name,
      municipality: s.municipality,
      category: s.category,
      crowd_capacity_band: band,
      crowd_status: crowdNow.crowd_status,
      crowd_confidence: crowdNow.crowd_confidence,
      pressure_score: crowdNow.pressure_score,
      recommendation_suppressed: Boolean(s.recommendation_suppressed),
      recommendation_suppressed_until: s.recommendation_suppressed_until
        ? new Date(s.recommendation_suppressed_until).toISOString()
        : null,
      verified_visits: maskSmallCount(st.verified_visits, isPlatform),
      unique_visitors: maskSmallCount(uniqueCount, isPlatform),
      on_site_now: maskSmallCount(onsiteCount, isPlatform),
      interactions: maskSmallCount(st.interactions, isPlatform),
      planning_to_go: maskSmallCount(st.planning_to_go, isPlatform),
      proofs_approved: maskSmallCount(st.proofs_approved, isPlatform),
      proofs_pending: maskSmallCount(st.proofs_pending, isPlatform),
      proofs_rejected: maskSmallCount(st.proofs_rejected, isPlatform),
      trail_checkins: maskSmallCount(st.trail_checkins, isPlatform),
      dwell_minutes: dwellBySpot.get(s.id) ?? 0,
      _sort_visits: st.verified_visits,
    };
  });

  topDestinations.sort((a: any, b: any) => b._sort_visits - a._sort_visits || a.name.localeCompare(b.name));
  const cleanedDestinations = topDestinations.map(({ _sort_visits, ...rest }: any) => rest);

  const categoryBreakdown = [...categoryAgg.entries()]
    .map(([category, agg]) => ({
      category,
      spots: agg.spots,
      verified_visits: maskSmallCount(agg.verified_visits, isPlatform),
      interactions: maskSmallCount(agg.interactions, isPlatform),
      on_site_now: maskSmallCount(agg.onsite.size, isPlatform),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));

  const prevRow = prevRes.rows[0] ?? { prev_visits: 0, prev_unique: 0, prev_interactions: 0 };
  const prevVisits = Number(prevRow.prev_visits ?? 0);
  const prevUnique = Number(prevRow.prev_unique ?? 0);
  const prevInteractions = Number(prevRow.prev_interactions ?? 0);

  const newRetRow = newReturnRes.rows[0] ?? { new_visitors: 0, returning_visitors: 0 };
  const locRow = localsRes.rows[0] ?? { locals: 0, visitors: 0, unknown: 0 };

  const totalVerifiedVisits = visitsRes.rows.length;
  const totalInteractions = eventsRes.rows.length;

  return {
    window: win,
    filters_applied: {
      municipality: options.municipality ?? null,
      category: options.category ?? null,
      q: options.q ?? null,
      spot_id: options.spotId ?? null,
      include_test: includeTest,
    },
    privacy_masked: !isPlatform,
    kpis: {
      unique_visitors: maskSmallCount(uniqueVisitorsAll.size, isPlatform),
      verified_visits: maskSmallCount(totalVerifiedVisits, isPlatform),
      on_site_now: maskSmallCount(onsiteAll.size, isPlatform),
      interactions: maskSmallCount(totalInteractions, isPlatform),
      planning_to_go: maskSmallCount(totalPlanning, isPlatform),
      trail_checkins: maskSmallCount(trailRes.rows.length, isPlatform),
      proofs: {
        approved: maskSmallCount(proofsApproved, isPlatform),
        pending: maskSmallCount(proofsPending, isPlatform),
        rejected: maskSmallCount(proofsRejected, isPlatform),
      },
      busiest_hour: busiestHour,
      busiest_day: busiestDay,
    },
    previous_period: {
      unique_visitors: maskSmallCount(prevUnique, isPlatform),
      verified_visits: maskSmallCount(prevVisits, isPlatform),
      interactions: maskSmallCount(prevInteractions, isPlatform),
      delta_pct: {
        unique_visitors: pctDelta(uniqueVisitorsAll.size, prevUnique),
        verified_visits: pctDelta(totalVerifiedVisits, prevVisits),
        interactions: pctDelta(totalInteractions, prevInteractions),
      },
    },
    new_vs_returning: {
      new_visitors: maskSmallCount(Number(newRetRow.new_visitors ?? 0), isPlatform),
      returning_visitors: maskSmallCount(Number(newRetRow.returning_visitors ?? 0), isPlatform),
    },
    locals_vs_visitors: {
      locals: maskSmallCount(Number(locRow.locals ?? 0), isPlatform),
      visitors: maskSmallCount(Number(locRow.visitors ?? 0), isPlatform),
      unknown: maskSmallCount(Number(locRow.unknown ?? 0), isPlatform),
    },
    conversion_funnel: {
      views: maskSmallCount(totalViews, isPlatform),
      directions: maskSmallCount(totalDirections, isPlatform),
      verified_visits: maskSmallCount(totalVerifiedVisits, isPlatform),
      view_to_directions_pct: totalViews > 0 ? Math.round((totalDirections / totalViews) * 1000) / 10 : 0,
      directions_to_visit_pct:
        totalDirections > 0 ? Math.round((totalVerifiedVisits / totalDirections) * 1000) / 10 : 0,
      view_to_visit_pct: totalViews > 0 ? Math.round((totalVerifiedVisits / totalViews) * 1000) / 10 : 0,
    },
    average_dwell_minutes: dwellCount > 0 ? Math.round((dwellSum / dwellCount) * 10) / 10 : 0,
    peak_capacity_alerts: peakCapacityAlerts.slice(0, 50),
    timeseries,
    category_breakdown: categoryBreakdown,
    top_destinations: cleanedDestinations,
    filter_options: {
      municipalities: [...new Set(filterOptsRes.rows.map((r: any) => String(r.municipality)).filter(Boolean))].sort(),
      categories: [...new Set(filterOptsRes.rows.map((r: any) => String(r.category)).filter(Boolean))].sort(),
    },
  };
}

export async function getCrowdHeatmap(pool: Pool, scope: AdminScope, options: CrowdQueryOptions) {
  const includeTest = scope.platform && Boolean(options.includeTest);
  const isPlatform = scope.platform;
  const win = resolveWindow(options);
  const spots = await loadScopedSpots(pool, scope, options, includeTest);
  const spotIds = spots.map((s: any) => String(s.id));

  const grid: Array<{ dow: number; day_label: string; hour: number; count: number | '<3' }> = [];
  if (!spotIds.length) {
    for (let dow = 0; dow < 7; dow++) {
      for (let hour = 0; hour < 24; hour++) {
        grid.push({ dow, day_label: DOW_LABELS[dow], hour, count: 0 });
      }
    }
    return { window: win, privacy_masked: !isPlatform, cells: grid };
  }

  const fromBound = `($2::date::timestamp AT TIME ZONE 'Asia/Manila')`;
  const toBound = `(($3::date + 1)::timestamp AT TIME ZONE 'Asia/Manila')`;

  const result = await pool.query(
    `SELECT m_dow, m_hour, COUNT(*)::int AS cnt
       FROM (
         SELECT EXTRACT(DOW FROM vv.occurred_at AT TIME ZONE 'Asia/Manila')::int AS m_dow,
                EXTRACT(HOUR FROM vv.occurred_at AT TIME ZONE 'Asia/Manila')::int AS m_hour
           FROM verified_visits vv
          WHERE vv.spot_id = ANY($1::text[]) AND vv.revoked_at IS NULL
            AND ($4::boolean = TRUE OR vv.is_test = FALSE)
            AND vv.occurred_at >= ${fromBound} AND vv.occurred_at < ${toBound}
         UNION ALL
         SELECT EXTRACT(DOW FROM sae.created_at AT TIME ZONE 'Asia/Manila')::int AS m_dow,
                EXTRACT(HOUR FROM sae.created_at AT TIME ZONE 'Asia/Manila')::int AS m_hour
           FROM spot_activity_events sae
          WHERE sae.spot_id = ANY($1::text[])
            AND ($4::boolean = TRUE OR sae.is_test = FALSE)
            AND sae.created_at >= ${fromBound} AND sae.created_at < ${toBound}
         UNION ALL
         SELECT EXTRACT(DOW FROM tc.verified_at AT TIME ZONE 'Asia/Manila')::int AS m_dow,
                EXTRACT(HOUR FROM tc.verified_at AT TIME ZONE 'Asia/Manila')::int AS m_hour
           FROM trail_checkins tc
           JOIN trail_stops ts ON ts.trail_id = tc.trail_id AND ts.position = tc.position
           JOIN trails t ON t.id = tc.trail_id
          WHERE ts.spot_id = ANY($1::text[])
            AND ($4::boolean = TRUE OR t.is_test = FALSE)
            AND tc.verified_at >= ${fromBound} AND tc.verified_at < ${toBound}
       ) combined
      GROUP BY m_dow, m_hour`,
    [spotIds, win.fromYmd, win.toYmd, includeTest],
  );

  const counts = new Map<string, number>();
  for (const row of result.rows) {
    counts.set(`${row.m_dow}:${row.m_hour}`, Number(row.cnt));
  }
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      const val = counts.get(`${dow}:${hour}`) ?? 0;
      grid.push({ dow, day_label: DOW_LABELS[dow], hour, count: maskSmallCount(val, isPlatform) });
    }
  }
  return { window: win, privacy_masked: !isPlatform, cells: grid };
}

export async function getCrowdSpotDetail(pool: Pool, scope: AdminScope, spotId: string, options: CrowdQueryOptions) {
  const includeTest = scope.platform && Boolean(options.includeTest);
  const scopedSpots = await loadScopedSpots(pool, scope, { ...options, spotId }, includeTest);
  const spot = scopedSpots[0];
  if (!spot) return null;

  const [overview, heatmap, timelineRes] = await Promise.all([
    getCrowdOverview(pool, scope, { ...options, spotId: spot.id }),
    getCrowdHeatmap(pool, scope, { ...options, spotId: spot.id }),
    pool.query(
      `SELECT bucket, SUM(weight)::numeric AS pressure_score
         FROM (
           SELECT TO_CHAR((sae.created_at AT TIME ZONE 'Asia/Manila')::date, 'YYYY-MM-DD') AS bucket,
                  CASE sae.activity_type
                    WHEN 'view' THEN 0.25
                    WHEN 'directions' THEN 3
                    WHEN 'save' THEN 2
                    WHEN 'visit' THEN 5
                    ELSE 0
                  END AS weight
             FROM spot_activity_events sae
            WHERE sae.spot_id = $1 AND ($4::boolean = TRUE OR sae.is_test = FALSE)
              AND sae.created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Manila')
              AND sae.created_at < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Manila')
           UNION ALL
           SELECT TO_CHAR((vv.occurred_at AT TIME ZONE 'Asia/Manila')::date, 'YYYY-MM-DD') AS bucket,
                  5 AS weight
             FROM verified_visits vv
            WHERE vv.spot_id = $1 AND vv.revoked_at IS NULL AND ($4::boolean = TRUE OR vv.is_test = FALSE)
              AND vv.occurred_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Manila')
              AND vv.occurred_at < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Manila')
         ) pts
        GROUP BY bucket
        ORDER BY bucket`,
      [spot.id, resolveWindow(options).fromYmd, resolveWindow(options).toYmd, includeTest],
    ),
  ]);

  const band = (spot.crowd_capacity_band || 'medium') as CrowdCapacityBand;
  const busyThreshold = BUSY_THRESHOLD[band] ?? 15;

  return {
    spot: overview.top_destinations[0] ?? spot,
    ...overview,
    heatmap: heatmap.cells,
    crowd_status_timeline: timelineRes.rows.map((r: any) => {
      const score = Math.round(Number(r.pressure_score) * 100) / 100;
      return {
        bucket: r.bucket,
        pressure_score: score,
        threshold: busyThreshold,
        status: score >= busyThreshold ? 'estimated_busy' : score >= busyThreshold * 0.4 ? 'moderate' : 'quiet',
      };
    }),
  };
}
