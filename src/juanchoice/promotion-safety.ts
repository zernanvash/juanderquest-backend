import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { JuanChoiceError } from './service.js';
import { calculateCrowdMetrics, CrowdStatus, CrowdConfidence } from '../spots/crowd.js';
import { ActivityEventInput } from '../spots/crowd.js';

function pool(): Pool {
  const result = getPool();
  if (!result) throw new JuanChoiceError('DATABASE_OUTAGE', 503);
  return result;
}

export type AssessmentDecision = 'cleared' | 'restricted';

export interface PromotionAssessmentRow {
  id: string;
  candidate_id: string;
  assessed_by: string;
  revision: number | string;
  decision: AssessmentDecision;
  reason: string;
  assessed_at: string;
  valid_until: string;
  is_test: boolean;
}

export interface CandidatePromotionEligibility {
  eligible: boolean;
  reason: string | null;
  latest_assessment: PromotionAssessmentRow | null;
  crowd_status: CrowdStatus;
  crowd_confidence: CrowdConfidence;
  spot_published: boolean;
  spot_suppressed: boolean;
}

export interface CreateAssessmentInput {
  campaignId: string;
  candidateId: string;
  adminId: string;
  decision: AssessmentDecision;
  reason: string;
  validUntil: string;
  expectedRevision: number;
}

/**
 * Executes work in a transaction with automatic COMMIT validation and ROLLBACK on error.
 */
async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    const committed = await client.query('COMMIT');
    if (committed.command !== 'COMMIT') throw new JuanChoiceError('COMMIT_FAILED', 503);
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function formatAssessmentRow(row: any): PromotionAssessmentRow {
  return {
    id: row.id,
    candidate_id: row.candidate_id,
    assessed_by: row.assessed_by,
    revision: Number(row.revision),
    decision: row.decision,
    reason: row.reason,
    assessed_at: new Date(row.assessed_at).toISOString(),
    valid_until: new Date(row.valid_until).toISOString(),
    is_test: Boolean(row.is_test),
  };
}

/**
 * Record a new append-only assessment for a candidate.
 * Locks campaign then candidate in order.
 * Strictly enforces revision optimistic concurrency, actor scope, and 7-day validity limit.
 */
export async function recordPromotionAssessment(
  input: CreateAssessmentInput
): Promise<PromotionAssessmentRow> {
  const trimmedReason = input.reason.trim();
  if (trimmedReason.length < 10 || trimmedReason.length > 1000) {
    throw new JuanChoiceError('INVALID_REASON', 400, 'Assessment reason must be between 10 and 1000 characters.');
  }

  if (
    typeof input.expectedRevision !== 'number' ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  ) {
    throw new JuanChoiceError('INVALID_REVISION', 400, 'expectedRevision must be a safe non-negative integer.');
  }

  return transaction(async (client) => {
    // 1. Lock order: Campaign -> Candidate
    const campaign = (
      await client.query(
        'SELECT id, is_test FROM juanchoice_campaigns WHERE id = $1 FOR UPDATE',
        [input.campaignId]
      )
    ).rows[0];
    if (!campaign) throw new JuanChoiceError('CAMPAIGN_NOT_FOUND', 404);

    const candidate = (
      await client.query(
        `SELECT c.id, c.campaign_id, c.spot_id, c.is_test, s.is_test AS spot_is_test
         FROM juanchoice_candidates c
         JOIN spots s ON s.id = c.spot_id
         WHERE c.id = $1 AND c.campaign_id = $2 FOR UPDATE`,
        [input.candidateId, input.campaignId]
      )
    ).rows[0];
    if (!candidate) throw new JuanChoiceError('CANDIDATE_NOT_FOUND', 404);

    // Verify scope alignment: candidate, campaign, and spot must match
    if (
      Boolean(candidate.is_test) !== Boolean(campaign.is_test) ||
      Boolean(candidate.spot_is_test) !== Boolean(campaign.is_test)
    ) {
      throw new JuanChoiceError('SCOPE_MISMATCH', 422, 'Campaign, candidate, and spot scope must match.');
    }

    // 2. Verify admin actor inside the transaction
    const admin = (
      await client.query(
        'SELECT id, role, is_test FROM users WHERE id = $1 FOR UPDATE',
        [input.adminId]
      )
    ).rows[0];
    if (!admin || admin.role !== 'admin') {
      throw new JuanChoiceError('FORBIDDEN', 403, 'Active admin role required.');
    }
    // Synthetic admin cannot assess real entities
    if (Boolean(admin.is_test) && !Boolean(campaign.is_test)) {
      throw new JuanChoiceError('SCOPE_MISMATCH', 403, 'Synthetic admin cannot assess real campaigns.');
    }
    // Real administrators CAN review and assess QA campaigns (operator QA workflow)

    // 3. Database clock validation
    const dbNowRow = (await client.query('SELECT clock_timestamp() AS now')).rows[0];
    const dbNow = new Date(dbNowRow.now);
    const validUntilDate = new Date(input.validUntil);

    if (isNaN(validUntilDate.getTime())) {
      throw new JuanChoiceError('INVALID_VALID_UNTIL', 400, 'Invalid valid_until timestamp.');
    }

    const maxValidUntil = new Date(dbNow.getTime() + 7 * 86_400_000);
    if (validUntilDate <= dbNow || validUntilDate > maxValidUntil) {
      throw new JuanChoiceError(
        'INVALID_VALIDITY_WINDOW',
        400,
        'valid_until must be strictly in the future and at most 7 days from now.'
      );
    }

    // 4. Concurrency & Revision control: query highest revision without int32 truncation
    const latestRevisionRow = (
      await client.query(
        'SELECT COALESCE(MAX(revision), 0) AS max_rev FROM juanchoice_promotion_assessments WHERE candidate_id = $1',
        [input.candidateId]
      )
    ).rows[0];
    const currentRevision = Number(latestRevisionRow?.max_rev ?? 0);

    if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) {
      throw new JuanChoiceError('INVALID_REVISION', 500, 'Stored revision exceeds safe integer limits.');
    }

    if (input.expectedRevision !== currentRevision) {
      throw new JuanChoiceError(
        'REVISION_CONFLICT',
        409,
        `Expected revision ${input.expectedRevision}, but current revision is ${currentRevision}.`
      );
    }

    const nextRevision = currentRevision + 1;
    if (!Number.isSafeInteger(nextRevision)) {
      throw new JuanChoiceError('REVISION_OVERFLOW', 400, 'Next revision would exceed safe integer limits.');
    }
    const assessmentId = randomUUID();

    // 5. Append assessment record atomically (using candidate scope derived server-side)
    let insertRes;
    try {
      insertRes = await client.query(
        `INSERT INTO juanchoice_promotion_assessments
          (id, candidate_id, assessed_by, revision, decision, reason, assessed_at, valid_until, is_test)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          assessmentId,
          input.candidateId,
          input.adminId,
          nextRevision,
          input.decision,
          trimmedReason,
          dbNow.toISOString(),
          validUntilDate.toISOString(),
          Boolean(candidate.is_test),
        ]
      );
    } catch (insertErr: any) {
      if (insertErr.code === '23505' || String(insertErr.message).includes('duplicate key')) {
        throw new JuanChoiceError(
          'REVISION_CONFLICT',
          409,
          `Concurrent revision conflict on revision ${nextRevision}.`
        );
      }
      throw insertErr;
    }
    const recorded = insertRes.rows[0];

    // 6. Record campaign audit entry
    await client.query(
      `INSERT INTO juanchoice_campaign_audit (id, campaign_id, actor_id, action, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        randomUUID(),
        input.campaignId,
        input.adminId,
        `promotion_assessment:${input.candidateId}:rev${nextRevision}:${input.decision}`,
        trimmedReason,
      ]
    );

    return formatAssessmentRow(recorded);
  });
}

/**
 * Retrieve the latest assessment for a candidate.
 */
export async function getLatestPromotionAssessment(
  candidateId: string,
  client: Pool | PoolClient = pool()
): Promise<PromotionAssessmentRow | null> {
  const row = (
    await client.query(
      `SELECT id, candidate_id, assessed_by, revision, decision, reason, assessed_at, valid_until, is_test
       FROM juanchoice_promotion_assessments
       WHERE candidate_id = $1
       ORDER BY revision DESC
       LIMIT 1`,
      [candidateId]
    )
  ).rows[0];
  if (!row) return null;
  return formatAssessmentRow(row);
}

/**
 * Evaluates candidate promotion eligibility:
 * - Campaign, candidate, and spot must exist and share identical scope
 * - Candidate must be eligible
 * - Spot must be published and unsuppressed
 * - Live crowd estimate from 24h durable events must NOT be 'estimated_busy' (busy overrides any clearance)
 * - Latest assessment must exist, have matching scope, decision == 'cleared', assessed_at <= dbNow, and valid_until > dbNow
 * - Latest revision governs; an expired restriction never revives an older clearance.
 */
export async function evaluateCandidatePromotionEligibility(
  campaignId: string,
  candidateId: string,
  allowTest = false,
  client: Pool | PoolClient = pool()
): Promise<CandidatePromotionEligibility> {
  const dbNow = new Date((await client.query('SELECT clock_timestamp() AS now')).rows[0].now);

  const candidateRow = (
    await client.query(
      `SELECT c.id AS candidate_id, c.campaign_id, c.spot_id, c.status AS candidate_status, c.is_test AS candidate_is_test,
              cmp.is_test AS campaign_is_test,
              s.status AS spot_status, s.recommendation_suppressed, s.crowd_capacity_band, s.is_test AS spot_is_test
       FROM juanchoice_candidates c
       JOIN juanchoice_campaigns cmp ON cmp.id = c.campaign_id
       JOIN spots s ON s.id = c.spot_id
       WHERE c.id = $1 AND c.campaign_id = $2`,
      [candidateId, campaignId]
    )
  ).rows[0];

  if (!candidateRow) {
    return {
      eligible: false,
      reason: 'CANDIDATE_NOT_FOUND',
      latest_assessment: null,
      crowd_status: 'unknown',
      crowd_confidence: 'none',
      spot_published: false,
      spot_suppressed: true,
    };
  }

  // If synthetic/test data is not allowed, reject test candidate/campaign/spot
  if (!allowTest && (candidateRow.candidate_is_test || candidateRow.campaign_is_test || candidateRow.spot_is_test)) {
    return {
      eligible: false,
      reason: 'CANDIDATE_NOT_FOUND',
      latest_assessment: null,
      crowd_status: 'unknown',
      crowd_confidence: 'none',
      spot_published: false,
      spot_suppressed: true,
    };
  }

  // Ensure absolute scope agreement across campaign, candidate, and spot
  if (
    Boolean(candidateRow.candidate_is_test) !== Boolean(candidateRow.campaign_is_test) ||
    Boolean(candidateRow.spot_is_test) !== Boolean(candidateRow.campaign_is_test)
  ) {
    return {
      eligible: false,
      reason: 'SCOPE_MISMATCH',
      latest_assessment: null,
      crowd_status: 'unknown',
      crowd_confidence: 'none',
      spot_published: false,
      spot_suppressed: true,
    };
  }

  const isScopeTest = Boolean(candidateRow.candidate_is_test);

  const spotPublished = candidateRow.spot_status === 'published';
  const spotSuppressed = Boolean(candidateRow.recommendation_suppressed);
  const candidateEligible = candidateRow.candidate_status === 'eligible';

  const windowStart = new Date(dbNow.getTime() - 24 * 3_600_000);
  const activityRows = (
    await client.query(
      `SELECT user_id, spot_id, activity_type, created_at, is_test
       FROM spot_activity_events
       WHERE spot_id = $1 AND is_test = $2 AND created_at >= $3::timestamptz AND created_at <= $4::timestamptz`,
      [candidateRow.spot_id, isScopeTest, windowStart.toISOString(), dbNow.toISOString()]
    )
  ).rows as ActivityEventInput[];

  const crowd = calculateCrowdMetrics(
    activityRows,
    candidateRow.crowd_capacity_band || 'medium',
    dbNow.getTime(),
    isScopeTest
  );

  // 2. Fetch latest assessment
  const latestAssessment = await getLatestPromotionAssessment(candidateId, client);

  // Check baseline destination conditions
  if (!spotPublished) {
    return {
      eligible: false,
      reason: 'SPOT_UNPUBLISHED',
      latest_assessment: latestAssessment,
      crowd_status: crowd.crowd_status,
      crowd_confidence: crowd.crowd_confidence,
      spot_published: false,
      spot_suppressed: spotSuppressed,
    };
  }

  if (spotSuppressed) {
    return {
      eligible: false,
      reason: 'SPOT_SUPPRESSED',
      latest_assessment: latestAssessment,
      crowd_status: crowd.crowd_status,
      crowd_confidence: crowd.crowd_confidence,
      spot_published: true,
      spot_suppressed: true,
    };
  }

  if (!candidateEligible) {
    return {
      eligible: false,
      reason: 'CANDIDATE_NOT_ELIGIBLE',
      latest_assessment: latestAssessment,
      crowd_status: crowd.crowd_status,
      crowd_confidence: crowd.crowd_confidence,
      spot_published: true,
      spot_suppressed: false,
    };
  }

  // 3. Busy overrides any clearance
  if (crowd.crowd_status === 'estimated_busy') {
    return {
      eligible: false,
      reason: 'ESTIMATED_BUSY',
      latest_assessment: latestAssessment,
      crowd_status: crowd.crowd_status,
      crowd_confidence: crowd.crowd_confidence,
      spot_published: true,
      spot_suppressed: false,
    };
  }

  // 4. Latest assessment requirement
  if (!latestAssessment) {
    return {
      eligible: false,
      reason: 'NO_PROMOTION_ASSESSMENT',
      latest_assessment: null,
      crowd_status: crowd.crowd_status,
      crowd_confidence: crowd.crowd_confidence,
      spot_published: true,
      spot_suppressed: false,
    };
  }

  // Scope check between candidate and latest assessment
  if (Boolean(latestAssessment.is_test) !== isScopeTest) {
    return {
      eligible: false,
      reason: 'SCOPE_MISMATCH',
      latest_assessment: latestAssessment,
      crowd_status: crowd.crowd_status,
      crowd_confidence: crowd.crowd_confidence,
      spot_published: true,
      spot_suppressed: false,
    };
  }

  // Latest decision check
  if (latestAssessment.decision === 'restricted') {
    return {
      eligible: false,
      reason: 'ASSESSMENT_RESTRICTED',
      latest_assessment: latestAssessment,
      crowd_status: crowd.crowd_status,
      crowd_confidence: crowd.crowd_confidence,
      spot_published: true,
      spot_suppressed: false,
    };
  }

  // Timing checks: assessed_at <= dbNow < valid_until
  const assessedAt = new Date(latestAssessment.assessed_at);
  const validUntil = new Date(latestAssessment.valid_until);

  if (isNaN(assessedAt.getTime()) || isNaN(validUntil.getTime())) {
    return {
      eligible: false,
      reason: 'INVALID_ASSESSMENT_DATES',
      latest_assessment: latestAssessment,
      crowd_status: crowd.crowd_status,
      crowd_confidence: crowd.crowd_confidence,
      spot_published: true,
      spot_suppressed: false,
    };
  }

  if (assessedAt > dbNow) {
    return {
      eligible: false,
      reason: 'ASSESSMENT_FUTURE_DATED',
      latest_assessment: latestAssessment,
      crowd_status: crowd.crowd_status,
      crowd_confidence: crowd.crowd_confidence,
      spot_published: true,
      spot_suppressed: false,
    };
  }

  // Exclusive expiry check: valid_until <= dbNow means expired
  if (validUntil <= dbNow) {
    return {
      eligible: false,
      reason: 'ASSESSMENT_EXPIRED',
      latest_assessment: latestAssessment,
      crowd_status: crowd.crowd_status,
      crowd_confidence: crowd.crowd_confidence,
      spot_published: true,
      spot_suppressed: false,
    };
  }

  // Decision is 'cleared' and unexpired, spot is published and unsuppressed, crowd is not busy
  return {
    eligible: true,
    reason: null,
    latest_assessment: latestAssessment,
    crowd_status: crowd.crowd_status,
    crowd_confidence: crowd.crowd_confidence,
    spot_published: true,
    spot_suppressed: false,
  };
}
