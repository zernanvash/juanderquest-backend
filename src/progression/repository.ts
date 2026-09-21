import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import {
  ReviewedQuestSpotBinding,
  VerifiedVisit,
  ProgressionEvent,
  ProgressionTotals,
  AchievementDefinition,
  AchievementAward,
  CuratedCollection,
  OutboxEvent,
} from './types.js';

type QueryExecutor = Pool | PoolClient;

export class ProgressionRepository {
  private getExecutor(client?: QueryExecutor): QueryExecutor | null {
    return client ?? getPool();
  }

  async getActiveBindingForQuest(questId: string, client?: QueryExecutor): Promise<ReviewedQuestSpotBinding | null> {
    const executor = this.getExecutor(client);
    if (!executor) return null;

    const { rows } = await executor.query(
      `SELECT * FROM reviewed_quest_spot_bindings
       WHERE quest_id = $1 AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 1`,
      [questId]
    );

    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id,
      quest_id: r.quest_id,
      spot_id: r.spot_id,
      binding_version: r.binding_version,
      status: r.status,
      reviewed_by: r.reviewed_by,
      notes: r.notes,
      is_test: Boolean(r.is_test),
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    };
  }

  async recordVerifiedVisit(
    visit: Omit<VerifiedVisit, 'created_at'>,
    client: PoolClient
  ): Promise<VerifiedVisit> {
    const { rows } = await client.query(
      `INSERT INTO verified_visits (
         id, user_id, spot_id, binding_id, municipality_id, source_submission_id,
         occurred_at, verified_at, evidence_version, is_test, revoked_at, revocation_reason
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (source_submission_id) DO NOTHING
       RETURNING *`,
      [
        visit.id,
        visit.user_id,
        visit.spot_id,
        visit.binding_id || null,
        visit.municipality_id || null,
        visit.source_submission_id,
        visit.occurred_at,
        visit.verified_at,
        visit.evidence_version,
        visit.is_test,
        visit.revoked_at || null,
        visit.revocation_reason || null,
      ]
    );

    const r = rows.length > 0
      ? rows[0]
      : (await client.query(
          'SELECT * FROM verified_visits WHERE source_submission_id = $1',
          [visit.source_submission_id]
        )).rows[0];

    if (r?.revoked_at) {
      throw new Error('VISIT_REVOKED: Existing verified visit for this submission has been revoked.');
    }

    return {
      id: r.id,
      user_id: r.user_id,
      spot_id: r.spot_id,
      binding_id: r.binding_id || null,
      municipality_id: r.municipality_id,
      source_submission_id: r.source_submission_id,
      occurred_at: new Date(r.occurred_at).toISOString(),
      verified_at: new Date(r.verified_at).toISOString(),
      evidence_version: r.evidence_version,
      is_test: Boolean(r.is_test),
      revoked_at: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
      revocation_reason: r.revocation_reason,
      created_at: new Date(r.created_at).toISOString(),
    };
  }

  async recordProgressionEvent(
    event: Omit<ProgressionEvent, 'created_at'>,
    client: PoolClient
  ): Promise<ProgressionEvent | null> {
    if (!Number.isSafeInteger(event.delta)) {
      throw new Error('INVALID_EVENT_DELTA: Delta must be a safe integer.');
    }

    // Lock user row first to serialize event writes and totals updates against concurrent rebuilds
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [event.user_id]);

    if (event.reversal_of) {
      const { rows: origRows } = await client.query(
        'SELECT * FROM progression_events WHERE id = $1 FOR UPDATE',
        [event.reversal_of]
      );
      if (!origRows.length) {
        throw new Error('REVERSAL_TARGET_NOT_FOUND');
      }
      const orig = origRows[0];
      if (orig.reversal_of) {
        throw new Error('REVERSAL_OF_REVERSAL_PROHIBITED: Cannot reverse an event that is already a reversal.');
      }
      if (orig.user_id !== event.user_id || orig.track !== event.track) {
        throw new Error('REVERSAL_SCOPE_MISMATCH: Reversal user_id and track must match target.');
      }
      if (orig.award_kind !== event.award_kind) {
        throw new Error('REVERSAL_AWARD_KIND_MISMATCH: Reversal award_kind must match target.');
      }
      if (Boolean(orig.is_test) !== Boolean(event.is_test)) {
        throw new Error('REVERSAL_SCOPE_MISMATCH: Reversal is_test scope must match target.');
      }
      if (BigInt(orig.delta) !== -BigInt(event.delta)) {
        throw new Error('REVERSAL_DELTA_MISMATCH');
      }
    }

    // Uniqueness is (user_id, source_type, source_id, award_kind) to prevent re-granting on version change
    const { rows } = await client.query(
      `INSERT INTO progression_events (
         id, user_id, track, delta, source_type, source_id, award_kind,
         rule_version, earned_at, is_test, reversal_of
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (user_id, source_type, source_id, award_kind) DO NOTHING
       RETURNING *`,
      [
        event.id,
        event.user_id,
        event.track,
        event.delta,
        event.source_type,
        event.source_id,
        event.award_kind,
        event.rule_version,
        event.earned_at,
        event.is_test,
        event.reversal_of || null,
      ]
    );

    if (rows.length === 0 || rows[0].id !== event.id) {
      return null; // Idempotent duplicate: already recorded for this logical source proof
    }

    const r = rows[0];
    return {
      id: r.id,
      user_id: r.user_id,
      track: r.track,
      delta: Number(r.delta),
      source_type: r.source_type,
      source_id: r.source_id,
      award_kind: r.award_kind,
      rule_version: r.rule_version,
      earned_at: new Date(r.earned_at).toISOString(),
      is_test: Boolean(r.is_test),
      reversal_of: r.reversal_of,
      created_at: new Date(r.created_at).toISOString(),
    };
  }

  async updateProgressionTotals(
    userId: string,
    deltas: { explorerXp?: number; civicXp?: number; civicStamps?: number },
    client: PoolClient
  ): Promise<ProgressionTotals> {
    // Lock user row first for consistent lock hierarchy
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);

    const expDelta = deltas.explorerXp || 0;
    const civDelta = deltas.civicXp || 0;
    const stampDelta = deltas.civicStamps || 0;

    if (!Number.isSafeInteger(expDelta) || !Number.isSafeInteger(civDelta) || !Number.isSafeInteger(stampDelta)) {
      throw new Error('INVALID_TOTALS_DELTA: Deltas must be safe integers.');
    }

    // Atomically validate that resulting totals will not exceed the safe integer bound
    const { rows: curRows } = await client.query(
      'SELECT explorer_xp, civic_xp, civic_stamps FROM progression_totals WHERE user_id = $1 FOR UPDATE',
      [userId]
    );

    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    const curExp = curRows.length ? BigInt(curRows[0].explorer_xp || 0) : 0n;
    const curCiv = curRows.length ? BigInt(curRows[0].civic_xp || 0) : 0n;
    const curStamps = curRows.length ? BigInt(curRows[0].civic_stamps || 0) : 0n;

    const nextExp = curExp + BigInt(expDelta);
    const nextCiv = curCiv + BigInt(civDelta);
    const nextStamps = curStamps + BigInt(stampDelta);

    if (
      nextExp > maxSafe || nextExp < 0n ||
      nextCiv > maxSafe || nextCiv < 0n ||
      nextStamps > maxSafe || nextStamps < 0n
    ) {
      throw new Error('TOTALS_OUT_OF_BOUNDS: Progression totals exceed JavaScript safe integer range [0, 9007199254740991].');
    }

    const { rows } = await client.query(
      `INSERT INTO progression_totals (user_id, explorer_xp, civic_xp, civic_stamps, last_event_at, updated_at)
       VALUES ($1, GREATEST(0::BIGINT, $2::BIGINT), GREATEST(0::BIGINT, $3::BIGINT), GREATEST(0::BIGINT, $4::BIGINT), NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         explorer_xp = GREATEST(0::BIGINT, progression_totals.explorer_xp + $2::BIGINT),
         civic_xp = GREATEST(0::BIGINT, progression_totals.civic_xp + $3::BIGINT),
         civic_stamps = GREATEST(0::BIGINT, progression_totals.civic_stamps + $4::BIGINT),
         last_event_at = NOW(),
         updated_at = NOW()
       RETURNING *`,
      [userId, expDelta, civDelta, stampDelta]
    );

    const r = rows[0];
    const exp = Number(r.explorer_xp);
    const civ = Number(r.civic_xp);
    const stamps = Number(r.civic_stamps);

    if (
      !Number.isSafeInteger(exp) || exp > Number.MAX_SAFE_INTEGER || exp < 0 ||
      !Number.isSafeInteger(civ) || civ > Number.MAX_SAFE_INTEGER || civ < 0 ||
      !Number.isSafeInteger(stamps) || stamps > Number.MAX_SAFE_INTEGER || stamps < 0
    ) {
      throw new Error('TOTALS_OUT_OF_BOUNDS: Resulting totals exceed safe integer range.');
    }

    return {
      user_id: r.user_id,
      explorer_xp: exp,
      civic_xp: civ,
      civic_stamps: stamps,
      last_event_at: r.last_event_at ? new Date(r.last_event_at).toISOString() : null,
      updated_at: new Date(r.updated_at).toISOString(),
    };
  }

  async rebuildTotalsForUser(userId: string, client: PoolClient): Promise<ProgressionTotals> {
    // Lock user row first to prevent concurrent grant writers from interleaving
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);

    const { rows } = await client.query(
      `SELECT track, award_kind, SUM(delta) AS total_delta
       FROM progression_events
       WHERE user_id = $1 AND is_test = (SELECT is_test FROM users WHERE id = $1)
       GROUP BY track, award_kind`,
      [userId]
    );

    let explorerXp = 0;
    let civicXp = 0;
    let civicStamps = 0;

    for (const row of rows) {
      const amount = Number(row.total_delta || 0);
      if (!Number.isSafeInteger(amount) || amount > Number.MAX_SAFE_INTEGER || amount < 0) {
        throw new Error('REBUILD_OVERFLOW: Calculated totals exceed safe integer range.');
      }
      if (row.track === 'explorer' && row.award_kind === 'xp') {
        explorerXp = Math.max(0, amount);
      } else if (row.track === 'civic') {
        if (row.award_kind === 'xp') civicXp = Math.max(0, amount);
        if (row.award_kind === 'stamp') civicStamps = Math.max(0, amount);
      }
    }

    const upsertRes = await client.query(
      `INSERT INTO progression_totals (user_id, explorer_xp, civic_xp, civic_stamps, last_event_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         explorer_xp = EXCLUDED.explorer_xp,
         civic_xp = EXCLUDED.civic_xp,
         civic_stamps = EXCLUDED.civic_stamps,
         updated_at = NOW()
       RETURNING *`,
      [userId, explorerXp, civicXp, civicStamps]
    );

    const r = upsertRes.rows[0];
    const exp = Number(r.explorer_xp);
    const civ = Number(r.civic_xp);
    const stamps = Number(r.civic_stamps);

    if (
      !Number.isSafeInteger(exp) || exp > Number.MAX_SAFE_INTEGER || exp < 0 ||
      !Number.isSafeInteger(civ) || civ > Number.MAX_SAFE_INTEGER || civ < 0 ||
      !Number.isSafeInteger(stamps) || stamps > Number.MAX_SAFE_INTEGER || stamps < 0
    ) {
      throw new Error('TOTALS_OUT_OF_BOUNDS: Rebuilt totals exceed safe integer range.');
    }

    return {
      user_id: r.user_id,
      explorer_xp: exp,
      civic_xp: civ,
      civic_stamps: stamps,
      last_event_at: r.last_event_at ? new Date(r.last_event_at).toISOString() : null,
      updated_at: new Date(r.updated_at).toISOString(),
    };
  }

  async getTotalsForUser(userId: string, client?: QueryExecutor): Promise<ProgressionTotals | null> {
    const executor = this.getExecutor(client);
    if (!executor) return null;

    const { rows } = await executor.query(
      'SELECT * FROM progression_totals WHERE user_id = $1',
      [userId]
    );

    if (!rows.length) {
      return {
        user_id: userId,
        explorer_xp: 0,
        civic_xp: 0,
        civic_stamps: 0,
        last_event_at: null,
        updated_at: new Date().toISOString(),
      };
    }

    const r = rows[0];
    const exp = Number(r.explorer_xp);
    const civ = Number(r.civic_xp);
    const stamps = Number(r.civic_stamps);

    if (!Number.isSafeInteger(exp) || !Number.isSafeInteger(civ) || !Number.isSafeInteger(stamps)) {
      throw new Error('CORRUPT_TOTALS_OVERFLOW: Stored totals exceed safe integer range.');
    }

    return {
      user_id: r.user_id,
      explorer_xp: exp,
      civic_xp: civ,
      civic_stamps: stamps,
      last_event_at: r.last_event_at ? new Date(r.last_event_at).toISOString() : null,
      updated_at: new Date(r.updated_at).toISOString(),
    };
  }

  async getVerifiedVisitsForUser(
    userId: string,
    options: { limit?: number; offset?: number; allowTest?: boolean } = {},
    client?: QueryExecutor
  ): Promise<VerifiedVisit[]> {
    const executor = this.getExecutor(client);
    if (!executor) return [];

    const limit = Math.min(Math.max(1, options.limit || 20), 50);
    const offset = Math.max(0, options.offset || 0);

    const query = options.allowTest
      ? `SELECT * FROM verified_visits WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT $2 OFFSET $3`
      : `SELECT * FROM verified_visits WHERE user_id = $1 AND is_test = FALSE ORDER BY occurred_at DESC LIMIT $2 OFFSET $3`;

    const { rows } = await executor.query(query, [userId, limit, offset]);
    return rows.map((r: any) => ({
      id: r.id,
      user_id: r.user_id,
      spot_id: r.spot_id,
      municipality_id: r.municipality_id,
      source_submission_id: r.source_submission_id,
      occurred_at: new Date(r.occurred_at).toISOString(),
      verified_at: new Date(r.verified_at).toISOString(),
      evidence_version: r.evidence_version,
      is_test: Boolean(r.is_test),
      revoked_at: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
      revocation_reason: r.revocation_reason,
      created_at: new Date(r.created_at).toISOString(),
    }));
  }

  async awardAchievement(
    award: Omit<AchievementAward, 'created_at'>,
    client: PoolClient
  ): Promise<AchievementAward | null> {
    const { rows: defRows } = await client.query(
      'SELECT * FROM achievement_definitions WHERE id = $1',
      [award.achievement_id]
    );
    const def = defRows[0];
    const criteriaVersion = award.criteria_version || def?.criteria_version || 'v1';
    const evidenceVersion = award.evidence_version || 'v1';
    const criteriaSnapshot = award.criteria_snapshot || (def ? {
      track: def.track,
      title: def.title,
      description: def.description,
      badge_icon: def.badge_icon,
      category: def.category,
      threshold: def.threshold,
      criteria_version: def.criteria_version,
    } : {});

    const { rows } = await client.query(
      `INSERT INTO achievement_awards (
         id, user_id, achievement_id, season, source_evidence_id,
         evidence_version, criteria_version, criteria_snapshot,
         awarded_at, is_test
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id, achievement_id, season) DO NOTHING
       RETURNING *`,
      [
        award.id,
        award.user_id,
        award.achievement_id,
        award.season || 'all_time',
        award.source_evidence_id || null,
        evidenceVersion,
        criteriaVersion,
        JSON.stringify(criteriaSnapshot),
        award.awarded_at || new Date().toISOString(),
        Boolean(award.is_test),
      ]
    );

    if (!rows.length) return null;
    const r = rows[0];
    const snap = typeof r.criteria_snapshot === 'string' ? JSON.parse(r.criteria_snapshot) : (r.criteria_snapshot || criteriaSnapshot);
    return {
      id: r.id,
      user_id: r.user_id,
      achievement_id: r.achievement_id,
      season: r.season,
      source_evidence_id: r.source_evidence_id,
      evidence_version: r.evidence_version || evidenceVersion,
      criteria_version: r.criteria_version || criteriaVersion,
      criteria_snapshot: snap,
      awarded_at: new Date(r.awarded_at).toISOString(),
      revoked_at: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
      revocation_reason: r.revocation_reason,
      is_test: Boolean(r.is_test),
      created_at: new Date(r.created_at).toISOString(),
      definition: def ? {
        id: def.id,
        track: snap.track ?? def.track,
        title: snap.title ?? def.title,
        description: snap.description ?? def.description,
        badge_icon: snap.badge_icon ?? def.badge_icon,
        category: snap.category ?? def.category,
        threshold: snap.threshold !== undefined ? Number(snap.threshold) : Number(def.threshold),
        criteria_version: snap.criteria_version ?? def.criteria_version,
        is_active: Boolean(def.is_active),
        created_at: new Date(r.awarded_at).toISOString(),
      } : undefined,
    };
  }

  async getAwardsForUser(
    userId: string,
    allowTest = false,
    client?: QueryExecutor
  ): Promise<AchievementAward[]> {
    const executor = this.getExecutor(client);
    if (!executor) return [];

    const query = `
      SELECT a.*, d.track, d.title as def_title, d.description as def_description,
             d.badge_icon as def_badge_icon, d.category as def_category,
             d.threshold as def_threshold, d.criteria_version as def_criteria_version
      FROM achievement_awards a
      LEFT JOIN achievement_definitions d ON d.id = a.achievement_id
      WHERE a.user_id = $1 ${allowTest ? '' : 'AND a.is_test = FALSE'}
        AND a.revoked_at IS NULL
      ORDER BY a.awarded_at DESC
    `;

    const { rows } = await executor.query(query, [userId]);
    return rows.map((r: any) => {
      let snap: any = {};
      if (r.criteria_snapshot) {
        snap = typeof r.criteria_snapshot === 'string' ? JSON.parse(r.criteria_snapshot) : r.criteria_snapshot;
      }
      return {
        id: r.id,
        user_id: r.user_id,
        achievement_id: r.achievement_id,
        season: r.season,
        source_evidence_id: r.source_evidence_id,
        evidence_version: r.evidence_version || 'v1',
        criteria_version: r.criteria_version || snap.criteria_version || r.def_criteria_version || 'v1',
        criteria_snapshot: snap,
        awarded_at: new Date(r.awarded_at).toISOString(),
        revoked_at: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
        revocation_reason: r.revocation_reason,
        is_test: Boolean(r.is_test),
        created_at: new Date(r.created_at).toISOString(),
        definition: {
          id: r.achievement_id,
          track: snap.track ?? r.track,
          title: snap.title ?? r.def_title ?? r.achievement_id,
          description: snap.description ?? r.def_description ?? '',
          badge_icon: snap.badge_icon ?? r.def_badge_icon ?? '',
          category: snap.category ?? r.def_category ?? 'milestone',
          threshold: snap.threshold !== undefined ? Number(snap.threshold) : Number(r.def_threshold || 1),
          criteria_version: snap.criteria_version ?? r.criteria_version ?? r.def_criteria_version ?? 'v1',
          is_active: true,
          created_at: new Date(r.awarded_at).toISOString(),
        },
      };
    });
  }

  async getAllAchievementDefinitions(client?: QueryExecutor): Promise<AchievementDefinition[]> {
    const executor = this.getExecutor(client);
    if (!executor) return [];

    const { rows } = await executor.query(
      `SELECT * FROM achievement_definitions WHERE is_active = TRUE ORDER BY track, id`
    );

    return rows.map((r: any) => ({
      id: r.id,
      track: r.track,
      title: r.title,
      description: r.description,
      badge_icon: r.badge_icon,
      category: r.category,
      threshold: r.threshold,
      criteria_version: r.criteria_version,
      is_active: Boolean(r.is_active),
      created_at: new Date(r.created_at).toISOString(),
    }));
  }

  async insertOutboxEvent(
    event: { id: string; event_key: string; event_type: string; payload: any },
    client: PoolClient
  ): Promise<void> {
    await client.query(
      `INSERT INTO outbox_events (id, event_key, event_type, payload, status, next_attempt_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())
       ON CONFLICT (event_key) DO NOTHING`,
      [event.id, event.event_key, event.event_type, JSON.stringify(event.payload)]
    );
  }

  async claimPendingOutboxEvents(
    batchSize: number,
    leaseSeconds: number,
    leaseOwner: string,
    client?: QueryExecutor
  ): Promise<OutboxEvent[]> {
    const executor = this.getExecutor(client);
    if (!executor) return [];

    // 1. Transition any expired processing events that have reached/exceeded max_attempts to dead_letter
    await executor.query(
      `UPDATE outbox_events
       SET status = 'dead_letter',
           last_error = COALESCE(last_error, 'LEASE_EXPIRED_MAX_ATTEMPTS_EXCEEDED'),
           lease_owner = NULL,
           claim_token = NULL,
           lease_expires_at = NULL
       WHERE status = 'processing'
         AND lease_expires_at <= NOW()
         AND attempts >= max_attempts`
    );

    // 2. Generate per-claim token and fenced owner
    const claimToken = randomUUID();
    const fencedOwner = `${leaseOwner}:${claimToken}`;

    // 3. Atomically claim eligible rows with SKIP LOCKED
    const { rows } = await executor.query(
      `UPDATE outbox_events
       SET status = 'processing',
           lease_owner = $1,
           claim_token = $2,
           lease_expires_at = NOW() + ($3 || ' seconds')::INTERVAL,
           attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM outbox_events
         WHERE (
           status IN ('pending', 'failed')
           OR (status = 'processing' AND lease_expires_at <= NOW())
         )
           AND next_attempt_at <= NOW()
           AND attempts < max_attempts
         ORDER BY next_attempt_at ASC
         LIMIT $4
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [fencedOwner, claimToken, leaseSeconds, batchSize]
    );

    return rows.map((r: any) => ({
      id: r.id,
      event_key: r.event_key,
      event_type: r.event_type,
      payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
      status: r.status,
      attempts: r.attempts,
      max_attempts: r.max_attempts,
      lease_owner: r.lease_owner,
      claim_token: r.claim_token,
      lease_expires_at: r.lease_expires_at ? new Date(r.lease_expires_at).toISOString() : null,
      next_attempt_at: new Date(r.next_attempt_at).toISOString(),
      delivered_at: r.delivered_at ? new Date(r.delivered_at).toISOString() : null,
      last_error: r.last_error,
      created_at: new Date(r.created_at).toISOString(),
    }));
  }

  async markOutboxCompleted(
    id: string,
    leaseOwner: string,
    client?: QueryExecutor,
    claimToken?: string | null
  ): Promise<boolean> {
    const executor = this.getExecutor(client);
    if (!executor) return false;

    // Strict compound fence: both lease_owner and claim_token are mandatory.
    // Raw worker names without claim tokens cannot acknowledge claims.
    let resolvedToken = claimToken;
    let resolvedOwner = leaseOwner;

    if (!resolvedToken && leaseOwner.includes(':')) {
      const colonIdx = leaseOwner.indexOf(':');
      resolvedToken = leaseOwner.slice(colonIdx + 1);
    }

    if (!resolvedToken) {
      // Per-claim token is mandatory; reject acknowledgement without valid claim token.
      return false;
    }

    const effectiveCompoundOwner = resolvedOwner.includes(':')
      ? resolvedOwner
      : `${resolvedOwner}:${resolvedToken}`;

    const { rowCount } = await executor.query(
      `UPDATE outbox_events
       SET status = 'completed',
           delivered_at = NOW(),
           lease_owner = NULL,
           claim_token = NULL,
           lease_expires_at = NULL
       WHERE id = $1
         AND status = 'processing'
         AND lease_owner = $2
         AND claim_token = $3::uuid`,
      [id, effectiveCompoundOwner, resolvedToken]
    );

    return (rowCount ?? 0) > 0;
  }

  async markOutboxFailed(
    id: string,
    leaseOwner: string,
    error: string,
    retryDelaySeconds: number,
    client?: QueryExecutor,
    claimToken?: string | null
  ): Promise<boolean> {
    const executor = this.getExecutor(client);
    if (!executor) return false;

    let resolvedToken = claimToken;
    let resolvedOwner = leaseOwner;

    if (!resolvedToken && leaseOwner.includes(':')) {
      const colonIdx = leaseOwner.indexOf(':');
      resolvedToken = leaseOwner.slice(colonIdx + 1);
    }

    if (!resolvedToken) {
      // Per-claim token is mandatory; reject failure acknowledgement without valid claim token.
      return false;
    }

    const effectiveCompoundOwner = resolvedOwner.includes(':')
      ? resolvedOwner
      : `${resolvedOwner}:${resolvedToken}`;

    const { rowCount } = await executor.query(
      `UPDATE outbox_events
       SET status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'failed' END,
           last_error = $2,
           next_attempt_at = NOW() + ($3 || ' seconds')::INTERVAL,
           lease_owner = NULL,
           claim_token = NULL,
           lease_expires_at = NULL
       WHERE id = $1
         AND status = 'processing'
         AND lease_owner = $4
         AND claim_token = $5::uuid`,
      [id, error, retryDelaySeconds, effectiveCompoundOwner, resolvedToken]
    );

    return (rowCount ?? 0) > 0;
  }

  async getCuratedCollections(userId?: string, allowTest = false, client?: QueryExecutor): Promise<CuratedCollection[]> {
    const executor = this.getExecutor(client);
    if (!executor) return [];

    // Quarantine synthetic/unpublished spots from public travelers
    const collectionsQuery = `
      SELECT c.*,
             cs.spot_id, cs.order_index,
             s.name AS spot_name, s.municipality, s.category AS spot_category, s.image_url
      FROM curated_collections c
      LEFT JOIN curated_collection_spots cs ON cs.collection_id = c.id
      LEFT JOIN spots s ON s.id = cs.spot_id AND s.status = 'published' AND ($1::boolean = TRUE OR s.is_test = FALSE)
      WHERE c.is_active = TRUE
      ORDER BY c.id, cs.order_index ASC
    `;

    const { rows } = await executor.query(collectionsQuery, [allowTest]);

    let visitedSpotIds = new Set<string>();
    if (userId) {
      const visitsRes = await executor.query(
        `SELECT DISTINCT spot_id FROM verified_visits
         WHERE user_id = $1 AND revoked_at IS NULL AND ($2::boolean = TRUE OR is_test = FALSE)`,
        [userId, allowTest]
      );
      visitedSpotIds = new Set(visitsRes.rows.map((r: any) => r.spot_id));
    }

    const collectionsMap = new Map<string, CuratedCollection>();

    for (const r of rows) {
      if (!collectionsMap.has(r.id)) {
        collectionsMap.set(r.id, {
          id: r.id,
          title: r.title,
          description: r.description,
          category: r.category,
          badge_id: r.badge_id,
          is_active: Boolean(r.is_active),
          total_spots: 0,
          visited_spots: 0,
          completed: false,
          spots: [],
        });
      }

      if (r.spot_id && r.spot_name) {
        const coll = collectionsMap.get(r.id)!;
        const isVisited = visitedSpotIds.has(r.spot_id);
        coll.total_spots++;
        if (isVisited) coll.visited_spots++;
        coll.spots.push({
          spot_id: r.spot_id,
          name: r.spot_name,
          municipality: r.municipality || '',
          category: r.spot_category || '',
          image_url: r.image_url || '',
          order_index: r.order_index,
          is_visited: isVisited,
        });
        coll.completed = coll.total_spots > 0 && coll.visited_spots === coll.total_spots;
      }
    }

    return Array.from(collectionsMap.values());
  }

  async getExploredLguCount(userId: string, allowTest = false, client?: QueryExecutor): Promise<number> {
    const executor = this.getExecutor(client);
    if (!executor) return 0;

    const { rows } = await executor.query(
      `SELECT COUNT(DISTINCT municipality_id) AS lgu_count
       FROM verified_visits
       WHERE user_id = $1 AND municipality_id IS NOT NULL AND revoked_at IS NULL AND ($2::boolean = TRUE OR is_test = FALSE)`,
      [userId, allowTest]
    );

    return Number(rows[0]?.lgu_count || 0);
  }

  async getTotalLguCount(client?: QueryExecutor): Promise<number> {
    const executor = this.getExecutor(client);
    if (!executor) return 48;

    const { rows } = await executor.query(
      `SELECT COUNT(*) AS total FROM municipalities WHERE is_active = TRUE`
    );

    return Number(rows[0]?.total || 48);
  }

  async resolveCanonicalMunicipalityId(rawName: string, client?: QueryExecutor): Promise<string | null> {
    const executor = this.getExecutor(client);
    if (!executor || !rawName) return null;

    let normalized = rawName.trim().toLowerCase();
    normalized = normalized
      .replace(/\bsta\.\s*/g, 'santa ')
      .replace(/\bsto\.\s*/g, 'santo ')
      .replace(/\s+/g, ' ');

    const strippedCity = normalized.replace(/\s+city$/i, '').trim();

    // 1. Direct match by ID or exact Name
    const { rows: direct } = await executor.query(
      `SELECT id FROM municipalities WHERE id = $1 OR LOWER(name) = $2 LIMIT 1`,
      [normalized.replace(/\s+/g, '_'), normalized]
    );
    if (direct.length) return direct[0].id;

    // 2. Strip city suffix match (e.g. "Alaminos" -> "Alaminos City", "Dagupan" -> "Dagupan City", "San Carlos" -> "San Carlos City")
    const { rows: stripped } = await executor.query(
      `SELECT id FROM municipalities WHERE LOWER(name) LIKE $1 LIMIT 1`,
      [`${strippedCity}%`]
    );
    if (stripped.length) return stripped[0].id;

    return null;
  }
}

export const progressionRepo = new ProgressionRepository();
