import { randomUUID } from 'crypto';
import { getPool } from '../db/pool.js';
import { db } from '../db/index.js';
import { ensureAreaCache, getCachedAreas, hasSpatialAreas, resolveSpotAreas } from '../maps/areas-service.js';
import { textBlocked } from '../social/blocklist.js';
import { notify } from '../social/notify.js';
import { log } from '../utils/logger.js';
import { distanceKm, spotStore, type Spot } from './store.js';
import { fieldLogStore } from './field-logs.js';

export type SpotHoldReasonCode = 'TEXT_BLOCKED' | 'OUTSIDE_BOUNDARY' | 'POSSIBLE_DUPLICATE';

export type ModerationEventDecision =
  'published' | 'held' | 'hidden_pending_review' | 'appealed' | 'removed' | 'kept_hidden';

export interface SpotModerationEvent {
  id: string;
  spot_id: string;
  actor: string;
  decision: ModerationEventDecision;
  reason_codes: string[];
  details: Record<string, unknown>;
  created_at: string;
}

export interface DuplicateSpotHint {
  id: string;
  slug: string;
  name: string;
  municipality: string;
}

export type FilterEvaluationResult =
  | {
      action: 'reject';
      httpStatus: 409 | 429;
      code: 'DUPLICATE_SPOT' | 'VELOCITY_LIMIT';
      message: string;
      retryAfterSeconds?: number;
      retryAt?: string;
      existingSpot?: DuplicateSpotHint;
    }
  | {
      action: 'publish' | 'hold';
      status: 'published' | 'held';
      reasonCodes: SpotHoldReasonCode[];
      messages: string[];
      duplicateSpot?: DuplicateSpotHint;
    };

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const REPORT_HIDE_THRESHOLD = 3;

const REASON_MESSAGES: Record<SpotHoldReasonCode, string> = {
  TEXT_BLOCKED: 'Remove web links or blocked words from the name, description, or tags.',
  OUTSIDE_BOUNDARY: 'Pin is outside Pangasinan boundaries. Move the pin inside Pangasinan for instant publishing.',
  POSSIBLE_DUPLICATE: 'A published destination already exists nearby with a similar name.',
};

const inMemoryEvents: SpotModerationEvent[] = [];

export function normalizeSpotName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function buildTrigrams(normalized: string): Set<string> {
  const padded = `  ${normalized} `;
  const set = new Set<string>();
  for (let i = 0; i <= padded.length - 3; i++) {
    set.add(padded.slice(i, i + 3));
  }
  return set;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

export function spotNameSimilarity(aRaw: string, bRaw: string): number {
  const a = normalizeSpotName(aRaw);
  const b = normalizeSpotName(bRaw);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) {
    return Math.max(0, 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1));
  }
  const ta = buildTrigrams(a);
  const tb = buildTrigrams(b);
  let overlap = 0;
  for (const gram of ta) {
    if (tb.has(gram)) overlap++;
  }
  const union = ta.size + tb.size - overlap;
  const trgm = union > 0 ? overlap / union : 0;
  return trgm;
}

async function getUserCreatedAtMs(userId: string): Promise<number | null> {
  const pool = getPool();
  if (pool) {
    try {
      const { rows } = await pool.query('SELECT created_at FROM users WHERE id = $1 LIMIT 1', [userId]);
      if (rows[0]?.created_at) {
        const ms = Date.parse(String(rows[0].created_at));
        if (Number.isFinite(ms)) return ms;
      }
    } catch {
      // Fallback to in-memory user directory
    }
  }
  const memUser = db.findUserById(userId);
  if (memUser?.created_at) {
    const ms = Date.parse(memUser.created_at);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

async function getRecentUserSpotTimestampsMs(userId: string, nowMs: number): Promise<number[]> {
  const cutoffIso = new Date(nowMs - DAY_MS).toISOString();
  const pool = getPool();
  if (pool) {
    try {
      const { rows } = await pool.query(
        `SELECT created_at FROM spots
          WHERE created_by = $1 AND created_at > $2
          ORDER BY created_at ASC`,
        [userId, cutoffIso],
      );
      return rows
        .map((r: any) => Date.parse(String(r.created_at)))
        .filter((ms: number) => Number.isFinite(ms) && nowMs - ms < DAY_MS);
    } catch {
      // Fallback below
    }
  }
  return spotStore.spots
    .filter((s) => s.created_by === userId)
    .map((s) => Date.parse(s.created_at))
    .filter((ms) => Number.isFinite(ms) && nowMs - ms < DAY_MS)
    .sort((a, b) => a - b);
}

export async function evaluateSpotSubmission(params: {
  mode: 'create' | 'edit';
  userId: string;
  editingSpotId?: string;
  name: string;
  description: string;
  tags?: string[];
  gps_lat: number;
  gps_lng: number;
  nowMs?: number;
}): Promise<FilterEvaluationResult> {
  const nowMs = params.nowMs ?? Date.now();
  const normInput = normalizeSpotName(params.name);

  if (params.mode === 'create') {
    const createdAtMs = await getUserCreatedAtMs(params.userId);
    const isNewAccount = createdAtMs === null || nowMs - createdAtMs < SEVEN_DAYS_MS;
    const dailyLimit = isNewAccount ? 3 : 10;
    const recentTimestamps = await getRecentUserSpotTimestampsMs(params.userId, nowMs);
    if (recentTimestamps.length >= dailyLimit) {
      const oldestMs = recentTimestamps[0] ?? nowMs;
      const retryAtMs = oldestMs + DAY_MS;
      const retryAfterSeconds = Math.max(1, Math.ceil((retryAtMs - nowMs) / 1000));
      return {
        action: 'reject',
        httpStatus: 429,
        code: 'VELOCITY_LIMIT',
        message: `Daily destination limit reached (${dailyLimit}/day). Try again later.`,
        retryAfterSeconds,
        retryAt: new Date(retryAtMs).toISOString(),
      };
    }
  }

  for (const existing of spotStore.spots) {
    if (params.editingSpotId && existing.id === params.editingSpotId) continue;
    if (existing.created_by !== params.userId) continue;
    if (existing.status === 'unpublished') {
      continue;
    }
    const distMeters = distanceKm(params.gps_lat, params.gps_lng, existing.gps_lat, existing.gps_lng) * 1000;
    if (distMeters <= 100 && normalizeSpotName(existing.name) === normInput) {
      return {
        action: 'reject',
        httpStatus: 409,
        code: 'DUPLICATE_SPOT',
        message: `You already submitted "${existing.name}" at this location.`,
        existingSpot: {
          id: existing.id,
          slug: existing.slug,
          name: existing.name,
          municipality: existing.municipality,
        },
      };
    }
  }

  const reasonCodes: SpotHoldReasonCode[] = [];
  const messages: string[] = [];
  let duplicateSpot: DuplicateSpotHint | undefined;

  if (
    textBlocked(params.name) ||
    textBlocked(params.description) ||
    (params.tags ?? []).some((tag) => textBlocked(tag))
  ) {
    reasonCodes.push('TEXT_BLOCKED');
    messages.push(REASON_MESSAGES.TEXT_BLOCKED);
  }

  const pool = getPool();
  await ensureAreaCache(pool);
  const areas = getCachedAreas() ?? [];
  const hasTownPolygons =
    (pool ? await hasSpatialAreas(pool) : false) || areas.some((a) => a.level === 'town' && Boolean(a.geometry));
  if (hasTownPolygons) {
    const polygonMatch = await resolveSpotAreas(pool, params.gps_lat, params.gps_lng);
    if (!polygonMatch.townAreaId) {
      reasonCodes.push('OUTSIDE_BOUNDARY');
      messages.push(REASON_MESSAGES.OUTSIDE_BOUNDARY);
    }
  }

  let bestScore = 0;
  let bestSpot: Spot | undefined;
  for (const existing of spotStore.spots) {
    if (params.editingSpotId && existing.id === params.editingSpotId) continue;
    if (existing.status !== 'published') continue;
    const distMeters = distanceKm(params.gps_lat, params.gps_lng, existing.gps_lat, existing.gps_lng) * 1000;
    if (distMeters > 100) continue;
    const score = spotNameSimilarity(params.name, existing.name);
    if (score >= 0.6 && score > bestScore) {
      bestScore = score;
      bestSpot = existing;
    }
  }
  if (bestSpot) {
    reasonCodes.push('POSSIBLE_DUPLICATE');
    duplicateSpot = {
      id: bestSpot.id,
      slug: bestSpot.slug,
      name: bestSpot.name,
      municipality: bestSpot.municipality,
    };
    messages.push(`Is this the same as ${bestSpot.name}?`);
  }

  if (reasonCodes.length > 0) {
    return {
      action: 'hold',
      status: 'held',
      reasonCodes,
      messages,
      duplicateSpot,
    };
  }

  return {
    action: 'publish',
    status: 'published',
    reasonCodes: [],
    messages: [],
  };
}

export async function recordSpotModerationEvent(input: {
  spotId: string;
  actor: string;
  decision: ModerationEventDecision;
  reasonCodes?: string[];
  details?: Record<string, unknown>;
}): Promise<SpotModerationEvent> {
  const event: SpotModerationEvent = {
    id: `sme_${randomUUID()}`,
    spot_id: input.spotId,
    actor: input.actor,
    decision: input.decision,
    reason_codes: input.reasonCodes ?? [],
    details: input.details ?? {},
    created_at: new Date().toISOString(),
  };
  inMemoryEvents.unshift(event);
  if (input.decision === 'removed' || input.decision === 'kept_hidden') {
    spotStore.recordUpheldReport(input.spotId, 1);
  }
  const pool = getPool();
  if (pool) {
    await pool.query(
      `INSERT INTO spot_moderation_events(id, spot_id, actor, decision, reason_codes, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        event.id,
        event.spot_id,
        event.actor,
        event.decision,
        event.reason_codes,
        JSON.stringify(event.details),
        event.created_at,
      ],
    );
  }
  return event;
}

function eventFromRow(row: Record<string, unknown>): SpotModerationEvent {
  return {
    id: String(row.id),
    spot_id: String(row.spot_id),
    actor: String(row.actor),
    decision: row.decision as ModerationEventDecision,
    reason_codes: Array.isArray(row.reason_codes) ? row.reason_codes.map(String) : [],
    details: typeof row.details === 'object' && row.details !== null ? (row.details as Record<string, unknown>) : {},
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

export async function listSpotModerationEvents(spotIds?: string[]): Promise<SpotModerationEvent[]> {
  const pool = getPool();
  if (pool) {
    try {
      const { rows } = spotIds?.length
        ? await pool.query(
            `SELECT * FROM spot_moderation_events WHERE spot_id = ANY($1) ORDER BY created_at DESC, id DESC`,
            [spotIds],
          )
        : await pool.query(`SELECT * FROM spot_moderation_events ORDER BY created_at DESC, id DESC`);
      return rows.map(eventFromRow);
    } catch {
      // Fallback below
    }
  }
  if (!spotIds) return [...inMemoryEvents];
  const idSet = new Set(spotIds);
  return inMemoryEvents.filter((e) => idSet.has(e.spot_id));
}

export function buildModerationSummary(spot: Spot, events: SpotModerationEvent[]) {
  const latestRelevant = events.find((e) => e.decision === spot.status) ?? events[0];
  const details = latestRelevant?.details ?? {};
  const rawMessages = Array.isArray(details.messages) ? details.messages.map(String) : [];
  const dup =
    details.duplicate_spot && typeof details.duplicate_spot === 'object'
      ? (details.duplicate_spot as DuplicateSpotHint)
      : undefined;
  const reasonCodes = latestRelevant?.reason_codes ?? [];
  const fallbackMessages = reasonCodes.map(
    (code) => REASON_MESSAGES[code as SpotHoldReasonCode] ?? code.toLowerCase().replace(/_/g, ' '),
  );
  const appealed = events.some((e) => e.decision === 'appealed');
  return {
    moderation_reasons: reasonCodes,
    moderation_messages: rawMessages.length > 0 ? rawMessages : fallbackMessages,
    duplicate_spot: dup,
    appeal_submitted: appealed,
    moderation_events: events,
  };
}

export async function computeReportWeight(spot: Spot, reporterUserId?: string, nowMs = Date.now()): Promise<number> {
  if (!reporterUserId) return 0;
  if (spot.created_by && spot.created_by === reporterUserId) return 0;
  const createdAtMs = await getUserCreatedAtMs(reporterUserId);
  if (createdAtMs === null || nowMs - createdAtMs < SEVEN_DAYS_MS) return 0;
  const alreadyReported = await fieldLogStore.hasUserReportedSpot(spot.id, reporterUserId);
  if (alreadyReported) return 0;
  return 1;
}

async function notifyAuthor(spot: Spot, title: string, message: string, eventSuffix: string) {
  const pool = getPool();
  if (!pool || !spot.created_by) return;
  try {
    await notify(pool, {
      userId: spot.created_by,
      kind: 'spot_moderation',
      eventKey: `spot_moderation:${spot.id}:${eventSuffix}`,
      title,
      message,
      href: '/profile?tab=destinations',
      isTest: Boolean(spot.is_test),
      push: {
        category: 'social',
        collapseKey: `spot_moderation:${spot.id}`,
      },
    });
  } catch (err) {
    log.error('[spots:moderation] Failed to notify spot author:', { error: err });
  }
}

export async function maybeHideSpotAfterReport(spot: Spot): Promise<{ hidden: boolean; pendingWeight: number }> {
  const pendingWeight = await fieldLogStore.sumPendingReportWeight(spot.id);
  if (pendingWeight >= REPORT_HIDE_THRESHOLD && spot.status === 'published') {
    await spotStore.setModerationStatus(spot.id, 'hidden_pending_review');
    const event = await recordSpotModerationEvent({
      spotId: spot.id,
      actor: 'system',
      decision: 'hidden_pending_review',
      reasonCodes: ['REPORT_THRESHOLD'],
      details: {
        eligible_pending_reports: pendingWeight,
        messages: ['Hidden pending moderator review after multiple community reports.'],
      },
    });
    await notifyAuthor(
      spot,
      'Destination hidden pending review',
      `"${spot.name}" was temporarily hidden after multiple traveler reports. You can submit an appeal from your profile.`,
      `hidden:${event.id}`,
    );
    return { hidden: true, pendingWeight };
  }
  return { hidden: false, pendingWeight };
}

export async function reconcileSpotAfterReportResolution(
  spot: Spot,
  resolutionStatus: 'reviewed' | 'dismissed',
  adminId: string,
  note: string,
): Promise<Spot> {
  if (spot.status !== 'hidden_pending_review') return spot;
  if (resolutionStatus === 'reviewed') {
    const updated = await spotStore.setModerationStatus(spot.id, 'unpublished');
    await recordSpotModerationEvent({
      spotId: spot.id,
      actor: adminId,
      decision: 'removed',
      reasonCodes: ['ADMIN_REPORT_REVIEWED'],
      details: { note },
    });
    await notifyAuthor(
      spot,
      'Destination removed after review',
      `"${spot.name}" was removed following a community report review: ${note}`,
      `removed:${Date.now()}`,
    );
    return updated ?? spot;
  }

  const remainingWeight = await fieldLogStore.sumPendingReportWeight(spot.id);
  if (remainingWeight < REPORT_HIDE_THRESHOLD) {
    const updated = await spotStore.setModerationStatus(spot.id, 'published');
    await recordSpotModerationEvent({
      spotId: spot.id,
      actor: adminId,
      decision: 'published',
      reasonCodes: ['REPORTS_DISMISSED'],
      details: { note },
    });
    await notifyAuthor(
      spot,
      'Destination restored',
      `Reports against "${spot.name}" were dismissed and it is now visible again.`,
      `restored:${Date.now()}`,
    );
    return updated ?? spot;
  }
  return spot;
}

export async function submitSpotAppeal(spot: Spot, userId: string, note: string): Promise<SpotModerationEvent> {
  const existingEvents = await listSpotModerationEvents([spot.id]);
  if (existingEvents.some((e) => e.decision === 'appealed' && e.actor === userId)) {
    const err: any = new Error('You have already submitted an appeal for this destination.');
    err.code = 'ALREADY_APPEALED';
    throw err;
  }
  return recordSpotModerationEvent({
    spotId: spot.id,
    actor: userId,
    decision: 'appealed',
    reasonCodes: ['AUTHOR_APPEAL'],
    details: { note },
  });
}

export async function applyAdminSpotModeration(params: {
  spot: Spot;
  adminId: string;
  action: 'publish' | 'keep_hidden' | 'remove';
  note: string;
}): Promise<Spot> {
  const { spot, adminId, action, note } = params;
  if (action === 'publish') {
    await spotStore.setModerationStatus(spot.id, 'published');
    await fieldLogStore.resolvePendingReportsForSpot(spot.id, 'dismissed', adminId, note);
    await recordSpotModerationEvent({
      spotId: spot.id,
      actor: adminId,
      decision: 'published',
      reasonCodes: ['ADMIN_PUBLISHED'],
      details: { note },
    });
    await notifyAuthor(
      spot,
      'Destination approved',
      `"${spot.name}" was approved by a moderator and is now live.`,
      `published:${Date.now()}`,
    );
    return spot;
  }

  if (action === 'keep_hidden') {
    await spotStore.setModerationStatus(spot.id, 'hidden_pending_review');
    await recordSpotModerationEvent({
      spotId: spot.id,
      actor: adminId,
      decision: 'kept_hidden',
      reasonCodes: ['ADMIN_KEPT_HIDDEN'],
      details: { note },
    });
    return spot;
  }

  await spotStore.setModerationStatus(spot.id, 'unpublished');
  await fieldLogStore.resolvePendingReportsForSpot(spot.id, 'reviewed', adminId, note);
  await recordSpotModerationEvent({
    spotId: spot.id,
    actor: adminId,
    decision: 'removed',
    reasonCodes: ['ADMIN_REMOVED'],
    details: { note },
  });
  await notifyAuthor(
    spot,
    'Destination removed',
    `"${spot.name}" was removed by a moderator: ${note}`,
    `removed:${Date.now()}`,
  );
  return spot;
}
