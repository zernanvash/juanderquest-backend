import type { Pool, PoolClient } from 'pg';

export const RISK_RULE_NAMES = [
  'stamp_spike',
  'points_spike',
  'impossible_travel',
  'gps_fail_burst',
  'proof_rejections',
  'report_target',
  'vote_burst',
  'admin_grant_large',
] as const;

export type RiskRuleName = (typeof RISK_RULE_NAMES)[number];
export type RiskSeverity = 'low' | 'medium' | 'high';

export interface RiskThresholds {
  stamp_spike_multiplier: number;
  stamp_spike_medium_min: number;
  stamp_spike_high_min: number;
  points_spike_multiplier: number;
  points_spike_medium_min: number;
  impossible_travel_kmh: number;
  gps_fail_burst_count: number;
  proof_rejections_count: number;
  report_target_medium_count: number;
  report_target_high_count: number;
  vote_burst_account_age_hours: number;
  vote_burst_min_accounts: number;
  admin_grant_large_points: number;
}

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  stamp_spike_multiplier: 5,
  stamp_spike_medium_min: 50,
  stamp_spike_high_min: 200,
  points_spike_multiplier: 5,
  points_spike_medium_min: 500,
  impossible_travel_kmh: 250,
  gps_fail_burst_count: 15,
  proof_rejections_count: 5,
  report_target_medium_count: 3,
  report_target_high_count: 6,
  vote_burst_account_age_hours: 48,
  vote_burst_min_accounts: 10,
  admin_grant_large_points: 2000,
};

export interface RiskCandidate {
  user_id: string;
  rule: RiskRuleName;
  severity: RiskSeverity;
  window_start: Date;
  window_end: Date;
  is_test: boolean;
  evidence: Record<string, unknown>;
}

export type RiskQueryClient = Pool | PoolClient;

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

export function startOfManilaDay(now: Date): Date {
  const shifted = new Date(now.getTime() + MANILA_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - MANILA_OFFSET_MS);
}

export function startOfUtcHour(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
}

function posNum(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function loadRiskThresholds(client: RiskQueryClient): Promise<RiskThresholds> {
  try {
    const { rows } = await client.query<{ raw: Record<string, unknown> | null }>(
      `SELECT values->'risk_thresholds' AS raw FROM system_settings_document WHERE id = 1`,
    );
    const raw = rows[0]?.raw;
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_RISK_THRESHOLDS };
    return {
      stamp_spike_multiplier: posNum(raw.stamp_spike_multiplier, DEFAULT_RISK_THRESHOLDS.stamp_spike_multiplier),
      stamp_spike_medium_min: posNum(raw.stamp_spike_medium_min, DEFAULT_RISK_THRESHOLDS.stamp_spike_medium_min),
      stamp_spike_high_min: posNum(raw.stamp_spike_high_min, DEFAULT_RISK_THRESHOLDS.stamp_spike_high_min),
      points_spike_multiplier: posNum(raw.points_spike_multiplier, DEFAULT_RISK_THRESHOLDS.points_spike_multiplier),
      points_spike_medium_min: posNum(raw.points_spike_medium_min, DEFAULT_RISK_THRESHOLDS.points_spike_medium_min),
      impossible_travel_kmh: posNum(raw.impossible_travel_kmh, DEFAULT_RISK_THRESHOLDS.impossible_travel_kmh),
      gps_fail_burst_count: posNum(raw.gps_fail_burst_count, DEFAULT_RISK_THRESHOLDS.gps_fail_burst_count),
      proof_rejections_count: posNum(raw.proof_rejections_count, DEFAULT_RISK_THRESHOLDS.proof_rejections_count),
      report_target_medium_count: posNum(
        raw.report_target_medium_count,
        DEFAULT_RISK_THRESHOLDS.report_target_medium_count,
      ),
      report_target_high_count: posNum(raw.report_target_high_count, DEFAULT_RISK_THRESHOLDS.report_target_high_count),
      vote_burst_account_age_hours: posNum(
        raw.vote_burst_account_age_hours,
        DEFAULT_RISK_THRESHOLDS.vote_burst_account_age_hours,
      ),
      vote_burst_min_accounts: posNum(raw.vote_burst_min_accounts, DEFAULT_RISK_THRESHOLDS.vote_burst_min_accounts),
      admin_grant_large_points: posNum(raw.admin_grant_large_points, DEFAULT_RISK_THRESHOLDS.admin_grant_large_points),
    };
  } catch {
    return { ...DEFAULT_RISK_THRESHOLDS };
  }
}

export async function detectStampSpike(
  client: RiskQueryClient,
  now: Date,
  t: RiskThresholds,
): Promise<RiskCandidate[]> {
  const windowStart = startOfManilaDay(now);
  const { rows } = await client.query<{
    user_id: string;
    is_test: boolean;
    earned_24h: number;
    median_14d: number;
    active_days_14d: number;
  }>(
    `WITH baseline AS (
       SELECT d.user_id,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY d.daily_total)::float AS median_14d,
              COUNT(*)::int AS active_days_14d
         FROM (
           SELECT sl.user_id, sl.manila_date, SUM(sl.delta)::float AS daily_total
             FROM stamp_ledger sl
            WHERE sl.delta > 0
              AND sl.created_at > ($1::timestamptz - interval '15 days')
              AND sl.created_at <= ($1::timestamptz - interval '24 hours')
            GROUP BY sl.user_id, sl.manila_date
         ) d
        GROUP BY d.user_id
     ),
     recent AS (
       SELECT sl.user_id,
              SUM(sl.delta)::int AS earned_24h,
              BOOL_OR(COALESCE(sl.is_test, FALSE) OR COALESCE(u.is_test, FALSE)) AS is_test
         FROM stamp_ledger sl
         JOIN users u ON u.id = sl.user_id
        WHERE sl.delta > 0
          AND sl.created_at > ($1::timestamptz - interval '24 hours')
          AND sl.created_at <= $1::timestamptz
        GROUP BY sl.user_id
     )
     SELECT r.user_id, r.is_test, r.earned_24h,
            COALESCE(b.median_14d, 0)::float AS median_14d,
            COALESCE(b.active_days_14d, 0)::int AS active_days_14d
       FROM recent r
       LEFT JOIN baseline b ON b.user_id = r.user_id
      WHERE r.earned_24h > $2::float8 * COALESCE(b.median_14d, 0)
        AND r.earned_24h >= $3::int`,
    [now.toISOString(), t.stamp_spike_multiplier, t.stamp_spike_medium_min],
  );
  return rows.map((row) => ({
    user_id: row.user_id,
    rule: 'stamp_spike',
    severity: Number(row.earned_24h) >= t.stamp_spike_high_min ? 'high' : 'medium',
    window_start: windowStart,
    window_end: now,
    is_test: Boolean(row.is_test),
    evidence: {
      earned_24h: Number(row.earned_24h),
      median_14d: Number(row.median_14d),
      active_days_14d: Number(row.active_days_14d),
      multiplier: t.stamp_spike_multiplier,
    },
  }));
}

export async function detectPointsSpike(
  client: RiskQueryClient,
  now: Date,
  t: RiskThresholds,
): Promise<RiskCandidate[]> {
  const windowStart = startOfManilaDay(now);
  const { rows } = await client.query<{
    user_id: string;
    is_test: boolean;
    earned_24h: number;
    median_14d: number;
    active_days_14d: number;
  }>(
    `WITH baseline AS (
       SELECT d.user_id,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY d.daily_total)::float AS median_14d,
              COUNT(*)::int AS active_days_14d
         FROM (
           SELECT gl.account AS user_id,
                  (gl.created_at AT TIME ZONE 'Asia/Manila')::date AS manila_day,
                  (SUM(gl.amount_mjdq)::numeric / 1000.0)::float AS daily_total
             FROM governance_ledger gl
             JOIN users u ON u.id = gl.account
            WHERE gl.amount_mjdq > 0
              AND gl.created_at > ($1::timestamptz - interval '15 days')
              AND gl.created_at <= ($1::timestamptz - interval '24 hours')
            GROUP BY gl.account, (gl.created_at AT TIME ZONE 'Asia/Manila')::date
         ) d
        GROUP BY d.user_id
     ),
     recent AS (
       SELECT gl.account AS user_id,
              ROUND(SUM(gl.amount_mjdq)::numeric / 1000.0, 2)::float AS earned_24h,
              BOOL_OR(COALESCE(u.is_test, FALSE)) AS is_test
         FROM governance_ledger gl
         JOIN users u ON u.id = gl.account
        WHERE gl.amount_mjdq > 0
          AND gl.created_at > ($1::timestamptz - interval '24 hours')
          AND gl.created_at <= $1::timestamptz
        GROUP BY gl.account
     )
     SELECT r.user_id, r.is_test, r.earned_24h,
            COALESCE(b.median_14d, 0)::float AS median_14d,
            COALESCE(b.active_days_14d, 0)::int AS active_days_14d
       FROM recent r
       LEFT JOIN baseline b ON b.user_id = r.user_id
      WHERE r.earned_24h > $2::float8 * COALESCE(b.median_14d, 0)
        AND r.earned_24h >= $3::float8`,
    [now.toISOString(), t.points_spike_multiplier, t.points_spike_medium_min],
  );
  return rows.map((row) => ({
    user_id: row.user_id,
    rule: 'points_spike',
    severity: 'medium',
    window_start: windowStart,
    window_end: now,
    is_test: Boolean(row.is_test),
    evidence: {
      earned_24h: Number(row.earned_24h),
      median_14d: Number(row.median_14d),
      active_days_14d: Number(row.active_days_14d),
      multiplier: t.points_spike_multiplier,
    },
  }));
}

export async function detectImpossibleTravel(
  client: RiskQueryClient,
  now: Date,
  t: RiskThresholds,
): Promise<RiskCandidate[]> {
  const windowStart = startOfManilaDay(now);
  const { rows } = await client.query<{
    user_id: string;
    is_test: boolean;
    first_spot_id: string | null;
    second_spot_id: string | null;
    first_quest_id: string | null;
    second_quest_id: string | null;
    first_at: Date;
    second_at: Date;
    distance_km: number;
    dt_seconds: number;
    speed_kmh: number;
  }>(
    `WITH checkins AS (
       SELECT vv.user_id,
              vv.spot_id,
              NULL::text AS quest_id,
              s.gps_lat AS lat,
              s.gps_lng AS lng,
              vv.occurred_at AS event_at,
              (vv.is_test OR COALESCE(u.is_test, FALSE)) AS is_test
         FROM verified_visits vv
         JOIN spots s ON s.id = vv.spot_id
         JOIN users u ON u.id = vv.user_id
        WHERE vv.revoked_at IS NULL
          AND vv.occurred_at >= ($1::timestamptz - interval '48 hours')
          AND vv.occurred_at <= $1::timestamptz
       UNION ALL
       SELECT sub.user_id,
              (SELECT sp.id FROM spots sp WHERE sp.quest_id = sub.quest_id ORDER BY sp.created_at ASC LIMIT 1) AS spot_id,
              sub.quest_id,
              sub.captured_lat AS lat,
              sub.captured_lng AS lng,
              sub.created_at AS event_at,
              (COALESCE(sub.is_test, FALSE) OR COALESCE(u.is_test, FALSE)) AS is_test
         FROM submissions sub
         JOIN users u ON u.id = sub.user_id
        WHERE sub.status <> 'rejected'
          AND sub.created_at >= ($1::timestamptz - interval '48 hours')
          AND sub.created_at <= $1::timestamptz
          AND NOT EXISTS (SELECT 1 FROM verified_visits vv2 WHERE vv2.source_submission_id = sub.id)
     ),
     paired AS (
       SELECT user_id,
              is_test,
              LAG(spot_id) OVER w AS first_spot_id,
              spot_id AS second_spot_id,
              LAG(quest_id) OVER w AS first_quest_id,
              quest_id AS second_quest_id,
              LAG(lat) OVER w AS lat1,
              LAG(lng) OVER w AS lng1,
              lat AS lat2,
              lng AS lng2,
              LAG(event_at) OVER w AS first_at,
              event_at AS second_at
         FROM checkins
       WINDOW w AS (PARTITION BY user_id ORDER BY event_at ASC, COALESCE(spot_id, quest_id, '') ASC)
     ),
     speeds AS (
       SELECT user_id,
              is_test,
              first_spot_id,
              second_spot_id,
              first_quest_id,
              second_quest_id,
              first_at,
              second_at,
              (6371.0 * 2.0 * asin(sqrt(least(1.0,
                power(sin(radians((lat2 - lat1) / 2.0)), 2) +
                cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians((lng2 - lng1) / 2.0)), 2)
              )))) AS distance_km,
              EXTRACT(EPOCH FROM (second_at - first_at)) AS dt_seconds
         FROM paired
        WHERE first_at IS NOT NULL
          AND second_at > ($1::timestamptz - interval '24 hours')
          AND lat1 IS NOT NULL AND lng1 IS NOT NULL AND lat2 IS NOT NULL AND lng2 IS NOT NULL
     )
     SELECT DISTINCT ON (user_id)
            user_id,
            is_test,
            first_spot_id,
            second_spot_id,
            first_quest_id,
            second_quest_id,
            first_at,
            second_at,
            ROUND(distance_km::numeric, 2)::float AS distance_km,
            ROUND(dt_seconds::numeric, 1)::float AS dt_seconds,
            ROUND((CASE WHEN dt_seconds <= 0 THEN 999999.0 ELSE distance_km / (dt_seconds / 3600.0) END)::numeric, 1)::float AS speed_kmh
       FROM speeds
      WHERE distance_km >= 1.0
        AND (CASE WHEN dt_seconds <= 0 THEN 999999.0 ELSE distance_km / (dt_seconds / 3600.0) END) > $2::float8
      ORDER BY user_id, speed_kmh DESC`,
    [now.toISOString(), t.impossible_travel_kmh],
  );
  return rows.map((row) => ({
    user_id: row.user_id,
    rule: 'impossible_travel',
    severity: 'high',
    window_start: windowStart,
    window_end: now,
    is_test: Boolean(row.is_test),
    evidence: {
      ...(row.first_spot_id ? { first_spot_id: row.first_spot_id } : {}),
      ...(row.second_spot_id ? { second_spot_id: row.second_spot_id } : {}),
      ...(row.first_quest_id ? { first_quest_id: row.first_quest_id } : {}),
      ...(row.second_quest_id ? { second_quest_id: row.second_quest_id } : {}),
      distance_km: Number(row.distance_km),
      minutes_apart: Math.round((Number(row.dt_seconds) / 60) * 10) / 10,
      speed_kmh: Number(row.speed_kmh),
      first_at: new Date(row.first_at).toISOString(),
      second_at: new Date(row.second_at).toISOString(),
    },
  }));
}

export async function detectGpsFailBurst(
  client: RiskQueryClient,
  now: Date,
  t: RiskThresholds,
): Promise<RiskCandidate[]> {
  const windowStart = startOfUtcHour(now);
  const { rows } = await client.query<{
    user_id: string;
    is_test: boolean;
    failed_tries_1h: number;
    task_count: number;
    quest_ids: string[];
  }>(
    `SELECT qse.user_id,
            BOOL_OR(COALESCE(u.is_test, FALSE)) AS is_test,
            SUM(qse.failed_tries)::int AS failed_tries_1h,
            COUNT(*)::int AS task_count,
            COALESCE(ARRAY_AGG(DISTINCT qse.quest_id), ARRAY[]::text[]) AS quest_ids
       FROM quest_step_evidence qse
       JOIN users u ON u.id = qse.user_id
      WHERE qse.failed_tries > 0
        AND qse.checkpoint_type IN ('location', 'qr')
        AND qse.updated_at > ($1::timestamptz - interval '1 hour')
        AND qse.updated_at <= $1::timestamptz
      GROUP BY qse.user_id
     HAVING SUM(qse.failed_tries) >= $2::int`,
    [now.toISOString(), t.gps_fail_burst_count],
  );
  return rows.map((row) => ({
    user_id: row.user_id,
    rule: 'gps_fail_burst',
    severity: 'medium',
    window_start: windowStart,
    window_end: now,
    is_test: Boolean(row.is_test),
    evidence: {
      failed_tries_1h: Number(row.failed_tries_1h),
      task_count: Number(row.task_count),
      quest_ids: Array.isArray(row.quest_ids) ? row.quest_ids.slice(0, 10) : [],
    },
  }));
}

export async function detectProofRejections(
  client: RiskQueryClient,
  now: Date,
  t: RiskThresholds,
): Promise<RiskCandidate[]> {
  const windowStart = startOfManilaDay(now);
  const { rows } = await client.query<{
    user_id: string;
    is_test: boolean;
    rejected_count_7d: number;
    quest_ids: string[];
  }>(
    `SELECT s.user_id,
            BOOL_OR(COALESCE(s.is_test, FALSE) OR COALESCE(u.is_test, FALSE)) AS is_test,
            COUNT(*)::int AS rejected_count_7d,
            COALESCE(ARRAY_AGG(DISTINCT s.quest_id), ARRAY[]::text[]) AS quest_ids
       FROM submissions s
       JOIN users u ON u.id = s.user_id
      WHERE s.status = 'rejected'
        AND COALESCE(s.reviewed_at, s.updated_at, s.created_at) > ($1::timestamptz - interval '7 days')
        AND COALESCE(s.reviewed_at, s.updated_at, s.created_at) <= $1::timestamptz
      GROUP BY s.user_id
     HAVING COUNT(*) >= $2::int`,
    [now.toISOString(), t.proof_rejections_count],
  );
  return rows.map((row) => ({
    user_id: row.user_id,
    rule: 'proof_rejections',
    severity: 'medium',
    window_start: windowStart,
    window_end: now,
    is_test: Boolean(row.is_test),
    evidence: {
      rejected_count_7d: Number(row.rejected_count_7d),
      quest_ids: Array.isArray(row.quest_ids) ? row.quest_ids.slice(0, 10) : [],
    },
  }));
}

export async function detectReportTarget(
  client: RiskQueryClient,
  now: Date,
  t: RiskThresholds,
): Promise<RiskCandidate[]> {
  const windowStart = startOfManilaDay(now);
  const { rows } = await client.query<{
    user_id: string;
    is_test: boolean;
    distinct_reporters: number;
    spot_reports: number;
    comment_reports: number;
    avatar_reports: number;
    spot_ids: string[];
  }>(
    `WITH reports AS (
       SELECT sp.created_by AS target_user_id,
              sr.user_id AS reporter_id,
              'spot'::text AS kind,
              sp.id AS entity_id
         FROM spot_reports sr
         JOIN spots sp ON sp.id = sr.spot_id
        WHERE sp.created_by IS NOT NULL
          AND sr.user_id IS NOT NULL
          AND sr.user_id <> sp.created_by
          AND sr.created_at > ($1::timestamptz - interval '7 days')
          AND sr.created_at <= $1::timestamptz
       UNION ALL
       SELECT sc.author_id AS target_user_id,
              scr.reporter_id,
              'comment'::text AS kind,
              NULL::text AS entity_id
         FROM social_comment_reports scr
         JOIN social_comments sc ON sc.id = scr.comment_id
        WHERE scr.reporter_id <> sc.author_id
          AND scr.created_at > ($1::timestamptz - interval '7 days')
          AND scr.created_at <= $1::timestamptz
       UNION ALL
       SELECT ar.user_id AS target_user_id,
              ar.reporter_id,
              'avatar'::text AS kind,
              NULL::text AS entity_id
         FROM avatar_reports ar
        WHERE ar.reporter_id <> ar.user_id
          AND ar.created_at > ($1::timestamptz - interval '7 days')
          AND ar.created_at <= $1::timestamptz
     )
     SELECT r.target_user_id AS user_id,
            COALESCE(u.is_test, FALSE) AS is_test,
            COUNT(DISTINCT r.reporter_id)::int AS distinct_reporters,
            COUNT(*) FILTER (WHERE r.kind = 'spot')::int AS spot_reports,
            COUNT(*) FILTER (WHERE r.kind = 'comment')::int AS comment_reports,
            COUNT(*) FILTER (WHERE r.kind = 'avatar')::int AS avatar_reports,
            COALESCE(ARRAY_AGG(DISTINCT r.entity_id) FILTER (WHERE r.entity_id IS NOT NULL), ARRAY[]::text[]) AS spot_ids
       FROM reports r
       JOIN users u ON u.id = r.target_user_id
      GROUP BY r.target_user_id, u.is_test
     HAVING COUNT(DISTINCT r.reporter_id) >= $2::int`,
    [now.toISOString(), t.report_target_medium_count],
  );
  return rows.map((row) => ({
    user_id: row.user_id,
    rule: 'report_target',
    severity: Number(row.distinct_reporters) >= t.report_target_high_count ? 'high' : 'medium',
    window_start: windowStart,
    window_end: now,
    is_test: Boolean(row.is_test),
    evidence: {
      distinct_reporters: Number(row.distinct_reporters),
      spot_reports: Number(row.spot_reports),
      comment_reports: Number(row.comment_reports),
      avatar_reports: Number(row.avatar_reports),
      spot_ids: Array.isArray(row.spot_ids) ? row.spot_ids.slice(0, 10) : [],
    },
  }));
}

export async function detectVoteBurst(client: RiskQueryClient, now: Date, t: RiskThresholds): Promise<RiskCandidate[]> {
  const windowStart = startOfUtcHour(now);
  const { rows } = await client.query<{
    user_id: string;
    is_test: boolean;
    campaign_id: string;
    candidate_id: string;
    cluster_accounts_count: number;
    account_age_hours: number;
    voted_at: Date;
  }>(
    `WITH young_ballots AS (
       SELECT jb.user_id,
              jb.campaign_id::text AS campaign_id,
              jb.candidate_id::text AS candidate_id,
              jb.created_at AS voted_at,
              (COALESCE(jb.is_test, FALSE) OR COALESCE(u.is_test, FALSE)) AS is_test,
              (EXTRACT(EPOCH FROM (jb.created_at - u.created_at)) / 3600.0) AS account_age_hours
         FROM juanchoice_ballots jb
         JOIN users u ON u.id = jb.user_id
        WHERE jb.created_at > ($1::timestamptz - interval '1 hour')
          AND jb.created_at <= $1::timestamptz
          AND (jb.created_at - u.created_at) < ($2::numeric * interval '1 hour')
     ),
     burst_clusters AS (
       SELECT campaign_id, candidate_id, COUNT(DISTINCT user_id)::int AS cluster_accounts_count
         FROM young_ballots
        GROUP BY campaign_id, candidate_id
       HAVING COUNT(DISTINCT user_id) >= $3::int
     )
     SELECT DISTINCT ON (yb.user_id)
            yb.user_id,
            yb.is_test,
            yb.campaign_id,
            yb.candidate_id,
            bc.cluster_accounts_count,
            ROUND(GREATEST(yb.account_age_hours, 0)::numeric, 2)::float AS account_age_hours,
            yb.voted_at
       FROM young_ballots yb
       JOIN burst_clusters bc ON bc.campaign_id = yb.campaign_id AND bc.candidate_id = yb.candidate_id
      ORDER BY yb.user_id, bc.cluster_accounts_count DESC, yb.voted_at DESC`,
    [now.toISOString(), t.vote_burst_account_age_hours, t.vote_burst_min_accounts],
  );
  return rows.map((row) => ({
    user_id: row.user_id,
    rule: 'vote_burst',
    severity: 'high',
    window_start: windowStart,
    window_end: now,
    is_test: Boolean(row.is_test),
    evidence: {
      campaign_id: row.campaign_id,
      candidate_id: row.candidate_id,
      cluster_accounts_count: Number(row.cluster_accounts_count),
      account_age_hours: Number(row.account_age_hours),
      voted_at: new Date(row.voted_at).toISOString(),
    },
  }));
}

export async function detectAdminGrantLarge(
  client: RiskQueryClient,
  now: Date,
  t: RiskThresholds,
): Promise<RiskCandidate[]> {
  const windowStart = startOfManilaDay(now);
  const { rows } = await client.query<{
    user_id: string;
    is_test: boolean;
    total_points_7d: number;
    grant_count_7d: number;
    granting_admin_ids: string[];
    grant_ids: string[];
  }>(
    `SELECT g.user_id,
            BOOL_OR(COALESCE(g.is_test, FALSE) OR COALESCE(u.is_test, FALSE)) AS is_test,
            SUM(g.points)::int AS total_points_7d,
            COUNT(*)::int AS grant_count_7d,
            COALESCE(ARRAY_AGG(DISTINCT g.admin_id), ARRAY[]::text[]) AS granting_admin_ids,
            COALESCE(ARRAY_AGG(g.id ORDER BY g.created_at DESC), ARRAY[]::text[]) AS grant_ids
       FROM admin_point_grants g
       JOIN users u ON u.id = g.user_id
      WHERE g.created_at > ($1::timestamptz - interval '7 days')
        AND g.created_at <= $1::timestamptz
      GROUP BY g.user_id
     HAVING SUM(g.points) >= $2::int`,
    [now.toISOString(), t.admin_grant_large_points],
  );
  return rows.map((row) => ({
    user_id: row.user_id,
    rule: 'admin_grant_large',
    severity: 'low',
    window_start: windowStart,
    window_end: now,
    is_test: Boolean(row.is_test),
    evidence: {
      total_points_7d: Number(row.total_points_7d),
      grant_count_7d: Number(row.grant_count_7d),
      granting_admin_ids: Array.isArray(row.granting_admin_ids) ? row.granting_admin_ids.slice(0, 10) : [],
      grant_ids: Array.isArray(row.grant_ids) ? row.grant_ids.slice(0, 10) : [],
    },
  }));
}

export const ALL_RISK_RULE_DETECTORS = [
  detectStampSpike,
  detectPointsSpike,
  detectImpossibleTravel,
  detectGpsFailBurst,
  detectProofRejections,
  detectReportTarget,
  detectVoteBurst,
  detectAdminGrantLarge,
] as const;

export async function evaluateAllRiskRules(
  client: RiskQueryClient,
  now: Date,
  thresholds: RiskThresholds,
): Promise<RiskCandidate[]> {
  const candidates: RiskCandidate[] = [];
  for (const detector of ALL_RISK_RULE_DETECTORS) {
    const found = await detector(client, now, thresholds);
    candidates.push(...found);
  }
  return candidates;
}
