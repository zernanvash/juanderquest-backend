import { db, SubmissionRow, calculateHaversineDistance } from '../db/index.js';
import { getPool } from '../db/pool.js';
import { lockGovernanceSnapshot, commitGovernanceTransaction } from '../governance/transaction.js';
import { governanceStore } from '../routes/proposals.js';
import { progressionService } from '../progression/service.js';
import { env } from '../config/env.js';
import { EconomyService } from '../economy/service.js';
import { isLocalEconomyProfile } from '../economy/profile.js';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { verifyQuestChallengeToken } from '../auth/tokens.js';
import { hasCompletedQuest } from './quest-completion.js';
import { settleReward } from '../funding/rewardSettlement.js';
import { hasFundingPlan, requireFundingHold } from '../funding/holds.js';
import { FundingError, publishFunding } from '../funding/transaction.js';
import type { CommittedLedgerGroup } from '../funding/ledger.js';

// Single-use challenge nonces are claimed in memory before any await so that
// concurrent requests cannot both pass the replay check. Entries expire shortly
// after the challenge JWT lifetime; the submissions table remains the durable
// cross-process backstop (`CHALLENGE:<nonce>` rows).
const CHALLENGE_NONCE_TTL_MS = 15 * 60 * 1000;
const usedChallengeNonces = new Map<string, number>();

export function claimChallengeNonce(nonce: string): boolean {
  const now = Date.now();
  for (const [key, expiresAt] of usedChallengeNonces) {
    if (expiresAt <= now) {
      usedChallengeNonces.delete(key);
    }
  }
  if (usedChallengeNonces.has(nonce)) {
    return false;
  }
  usedChallengeNonces.set(nonce, now + CHALLENGE_NONCE_TTL_MS);
  return true;
}

export function isChallengeNonceClaimed(nonce: string): boolean {
  const expiry = usedChallengeNonces.get(nonce);
  if (expiry === undefined) return false;
  if (expiry <= Date.now()) {
    usedChallengeNonces.delete(nonce);
    return false;
  }
  return true;
}

export function releaseChallengeNonce(nonce: string): void {
  usedChallengeNonces.delete(nonce);
}

export interface CreateSubmissionInput {
  idempotency_key: string;
  user_id: string;
  quest_id: string;
  scanned_marker_code?: string;
  challenge_token?: string;
  captured_lat: number;
  captured_lng: number;
  captured_accuracy: number;
}

// Fingerprint of the presented proof for idempotent-replay comparison. Challenge
// tokens are matched by nonce only, so a delayed network retry with an expired
// token still replays its original submission instead of a false conflict.
// Signature validation still happens later, before any proof is accepted.
function fingerprintProof(payload: CreateSubmissionInput): string | undefined {
  if (payload.challenge_token) {
    const decoded = jwt.decode(payload.challenge_token) as any;
    return decoded?.nonce ? `CHALLENGE:${decoded.nonce}` : undefined;
  }
  return payload.scanned_marker_code;
}

export interface ServiceResult<T> {
  success: boolean;
  data?: T;
  statusCode?: number;
  error?: {
    code: string;
    message: string;
  };
}

export class SubmissionsService {
  async createSubmission(payload: CreateSubmissionInput): Promise<ServiceResult<SubmissionRow>> {
    const pool = getPool();
    const presentedProofMarker = fingerprintProof(payload);

    // 1. User-scoped Idempotency Check
    if (pool) {
      const { rows: existingRows } = await pool.query(
        'SELECT * FROM submissions WHERE idempotency_key = $1 AND user_id = $2',
        [payload.idempotency_key, payload.user_id]
      );
      if (existingRows.length > 0) {
        const existing = existingRows[0];
        if (existing.quest_id !== payload.quest_id || existing.scanned_marker_code !== presentedProofMarker) {
          return {
            success: false,
            statusCode: 409,
            error: {
              code: 'IDEMPOTENCY_CONFLICT',
              message: 'An existing submission already exists for this idempotency key with different parameters.',
            },
          };
        }
        return {
          success: true,
          statusCode: 200,
          data: this.mapSubmissionRow(existing),
        };
      }
    } else {
      const existing = db.findSubmissionByIdempotency(payload.idempotency_key, payload.user_id);
      if (existing) {
        if (existing.quest_id !== payload.quest_id || existing.scanned_marker_code !== presentedProofMarker) {
          return {
            success: false,
            statusCode: 409,
            error: {
              code: 'IDEMPOTENCY_CONFLICT',
              message: 'An existing submission already exists for this idempotency key with different parameters.',
            },
          };
        }
        return {
          success: true,
          statusCode: 200,
          data: existing,
        };
      }
    }

    // 2. Quest existence check
    const quest = db.findQuestById(payload.quest_id, true);
    if (!quest) {
      return {
        success: false,
        statusCode: 404,
        error: { code: 'NOT_FOUND', message: `Quest '${payload.quest_id}' not found.` },
      };
    }
    if (quest.status === 'draft' || (!quest.is_active && !quest.status)) {
      return { success: false, statusCode: 404, error: { code: 'NOT_FOUND', message: 'Quest not found.' } };
    }

    // A proof inherits its actor/quest scope. Never let PostgreSQL's default
    // FALSE silently turn a synthetic proof into a live moderation record.
    const actor = db.findUserById(payload.user_id);
    if (!actor || Boolean(actor.is_test) !== Boolean(quest.is_test)) {
      return { success: false, statusCode: 403,
        error: { code: 'SCOPE_MISMATCH', message: 'Traveler and quest scopes do not match.' } };
    }

    if (quest.status === 'paused') {
      return {
        success: false,
        statusCode: 409,
        error: { code: 'QUEST_PAUSED', message: 'This quest is temporarily paused by the author.' },
      };
    }

    if (quest.status === 'archived') {
      return {
        success: false,
        statusCode: 410,
        error: { code: 'QUEST_ARCHIVED', message: 'This quest has been archived and is no longer available.' },
      };
    }

    // 3. Duplicate approved completion check
    if (await hasCompletedQuest(db, payload.user_id, payload.quest_id, pool)) {
      return {
        success: false,
        statusCode: 409,
        error: { code: 'ALREADY_COMPLETED', message: 'You have already completed this quest.' },
      };
    }

    if (pool) {
      try { await requireFundingHold(pool, payload.user_id, payload.quest_id); }
      catch (error) {
        if (error instanceof FundingError) return { success: false, statusCode: error.status, error: { code: error.code, message: error.message } };
        throw error;
      }
    }

    // One proof per active traveler/quest review cycle. This check precedes
    // proof/nonce validation so a second device cannot reserve a new token.
    if (pool) {
      const pending = await pool.query(
        "SELECT 1 FROM submissions WHERE user_id = $1 AND quest_id = $2 AND status = 'pending' LIMIT 1",
        [payload.user_id, payload.quest_id]
      );
      if (pending.rowCount) {
        return { success: false, statusCode: 409,
          error: { code: 'SUBMISSION_PENDING', message: 'A proof for this quest is already awaiting review.' } };
      }
    } else if (db.hasPendingSubmission(payload.user_id, payload.quest_id)) {
      return { success: false, statusCode: 409,
        error: { code: 'SUBMISSION_PENDING', message: 'A proof for this quest is already awaiting review.' } };
    }

    // 4. Verify Proof (Challenge Token or Physical Scanned Marker)
    let finalMarkerCode: string;
    let challengeNonce: string | undefined;
    let claimedNonceForInsert: string | undefined;
    const claimNonceForInsert = (): boolean => {
      if (!challengeNonce) return true;
      if (!claimChallengeNonce(challengeNonce)) return false;
      claimedNonceForInsert = challengeNonce;
      return true;
    };
    const releaseInsertNonce = () => {
      if (claimedNonceForInsert) releaseChallengeNonce(claimedNonceForInsert);
      claimedNonceForInsert = undefined;
    };

    if (payload.challenge_token) {
      try {
        const decoded = verifyQuestChallengeToken(payload.challenge_token);
        if (!decoded) {
          return {
            success: false,
            statusCode: 401,
            error: { code: 'INVALID_CHALLENGE', message: 'Challenge token subject is invalid.' },
          };
        }
        if (decoded.user_id !== payload.user_id) {
          return {
            success: false,
            statusCode: 403,
            error: { code: 'CHALLENGE_ACTOR_MISMATCH', message: 'Challenge token was not issued for this user.' },
          };
        }
        if (decoded.quest_id !== payload.quest_id) {
          return {
            success: false,
            statusCode: 400,
            error: { code: 'CHALLENGE_QUEST_MISMATCH', message: 'Challenge token was not issued for this quest.' },
          };
        }
        const nonce = decoded.nonce;
        if (typeof nonce !== 'string' || nonce.length < 1 || nonce.length > 200) {
          return {
            success: false,
            statusCode: 401,
            error: { code: 'INVALID_CHALLENGE', message: 'Challenge token is missing its nonce.' },
          };
        }
        challengeNonce = nonce;
        if (isChallengeNonceClaimed(nonce)) {
          return {
            success: false,
            statusCode: 409,
            error: { code: 'CHALLENGE_ALREADY_USED', message: 'This challenge token has already been consumed.' },
          };
        }
        if (pool) {
          const { rows } = await pool.query(
            "SELECT 1 FROM submissions WHERE scanned_marker_code = $1 LIMIT 1",
            [`CHALLENGE:${nonce}`]
          );
          if (rows.length > 0) {
            return {
              success: false,
              statusCode: 409,
              error: { code: 'CHALLENGE_ALREADY_USED', message: 'This challenge token has already been consumed.' },
            };
          }
        }
        finalMarkerCode = `CHALLENGE:${nonce}`;
      } catch (err: any) {
        if (err.name === 'TokenExpiredError') {
          return {
            success: false,
            statusCode: 400,
            error: { code: 'CHALLENGE_EXPIRED', message: 'Challenge token has expired. Please refresh your quest attempt.' },
          };
        }
        return {
          success: false,
          statusCode: 401,
          error: { code: 'INVALID_CHALLENGE', message: 'Challenge token signature or format is invalid.' },
        };
      }
    } else if (payload.scanned_marker_code) {
      if (!env.ALLOW_LEGACY_MARKER_PROOF) {
        return {
          success: false,
          statusCode: 400,
          error: {
            code: 'CHALLENGE_REQUIRED',
            message: 'Marker-code proof is deprecated. Request a challenge token from POST /quests/:id/challenge and resubmit.',
          },
        };
      }
      if (payload.scanned_marker_code !== quest.marker_code) {
        return {
          success: false,
          statusCode: 400,
          error: {
            code: 'VALIDATION_ERROR',
            message: `Scanned marker code '${payload.scanned_marker_code}' does not match target quest requirement.`,
          },
        };
      }
      finalMarkerCode = payload.scanned_marker_code;
    } else {
      return {
        success: false,
        statusCode: 400,
        error: {
          code: 'CHALLENGE_REQUIRED',
          message: 'Challenge verification is required. Request a challenge token from POST /quests/:id/challenge and resubmit.',
        },
      };
    }

    // 5. GPS radius enforcement
    const distanceMeters = calculateHaversineDistance(
      payload.captured_lat,
      payload.captured_lng,
      quest.gps_lat,
      quest.gps_lng
    );

    if (distanceMeters > quest.radius_meters) {
      return {
        success: false,
        statusCode: 422,
        error: {
          code: 'OUT_OF_RANGE',
          message: `Your captured location is ${distanceMeters}m away, which exceeds the allowed ${quest.radius_meters}m radius for ${quest.title}.`,
        },
      };
    }

    // 6. Create pending submission record
    const subId = `sub_${Date.now()}_${randomUUID().slice(0, 6)}`;
    if (pool) {
      if (await hasFundingPlan(pool, payload.quest_id)) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await lockGovernanceSnapshot(client);
          await requireFundingHold(client, payload.user_id, payload.quest_id);
          const held = await client.query(
            `SELECT h.*, p.quest_id FROM quest_funding_holds h JOIN quest_funding_plans p ON p.id=h.plan_id
             WHERE p.quest_id=$1 AND h.user_id=$2 AND h.status='held' FOR UPDATE OF h`, [payload.quest_id, payload.user_id]);
          const hold = held.rows[0];
          if (!hold || new Date(hold.expires_at).getTime() <= Date.now()) throw new FundingError('FUNDING_HOLD_EXPIRED', 409, 'This reward reservation has expired.');
          if (!claimNonceForInsert()) throw new FundingError('CHALLENGE_ALREADY_USED', 409, 'This challenge has already been used.');
          const inserted = await client.query(
            `INSERT INTO submissions(id,idempotency_key,user_id,quest_id,scanned_marker_code,captured_lat,captured_lng,captured_accuracy,status,is_test)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9) RETURNING *`,
            [subId,payload.idempotency_key,payload.user_id,payload.quest_id,finalMarkerCode,payload.captured_lat,payload.captured_lng,payload.captured_accuracy,Boolean(quest.is_test)]);
          await client.query('UPDATE quest_funding_holds SET submission_id=$2 WHERE id=$1', [hold.id,subId]);
          await client.query("UPDATE quest_attempts SET status='submitted',updated_at=NOW() WHERE id=$1", [hold.attempt_id]);
          await commitGovernanceTransaction(client);
          claimedNonceForInsert = undefined;
          const created = this.mapSubmissionRow(inserted.rows[0]);
          db.submissions.push(created);
          const attempt = db.quest_attempts.find(a => a.id === hold.attempt_id);
          if (attempt) attempt.status = 'submitted';
          return { success: true, statusCode: 201, data: created };
        } catch (error) {
          releaseInsertNonce();
          await client.query('ROLLBACK').catch(() => undefined);
          if (error instanceof FundingError) return { success: false, statusCode: error.status, error: { code: error.code, message: error.message } };
          throw error;
        } finally { client.release(); }
      }
      const durableEconomy = process.env.NODE_ENV !== 'test' || Boolean(process.env.JDQ_REAL_PG_URL);
      if (durableEconomy && isLocalEconomyProfile()) {
        const fundedContext = await pool.query(
          `SELECT 1 WHERE EXISTS (
             SELECT 1 FROM reward_pools WHERE quest_id = $1 AND status = 'active'
               AND asset_code = 'EXPLORER_COIN_SIM' AND scope_id IS NOT NULL
           ) OR EXISTS (
             SELECT 1 FROM reward_reservations r JOIN reward_pools p ON p.id = r.pool_id
             WHERE p.quest_id = $1 AND r.user_id = $2 AND r.status = 'reserved'
               AND p.scope_id IS NOT NULL
           )`, [payload.quest_id, payload.user_id]
        );
        if (fundedContext.rowCount) {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const scope = await client.query(
              `SELECT u.is_test AS user_test, q.is_test AS quest_test
                 FROM users u JOIN quests q ON q.id = $2
                WHERE u.id = $1 FOR SHARE OF u, q`,
              [payload.user_id, payload.quest_id]
            );
            if (!scope.rows[0] || Boolean(scope.rows[0].user_test) !== Boolean(scope.rows[0].quest_test)) {
              await client.query('ROLLBACK');
              return { success: false, statusCode: 403,
                error: { code: 'SCOPE_MISMATCH', message: 'Traveler and quest scopes do not match.' } };
            }
            const held = await client.query(
              `SELECT r.id, r.attempt_id, r.quest_version, r.expires_at,
                 a.status AS attempt_status, q.version AS current_version
               FROM reward_reservations r
               JOIN reward_pools p ON p.id = r.pool_id
               JOIN quest_attempts a ON a.id = r.attempt_id
               JOIN quests q ON q.id = p.quest_id
               WHERE p.quest_id = $1 AND r.user_id = $2 AND r.status = 'reserved'
               ORDER BY r.created_at DESC LIMIT 1 FOR UPDATE OF r`,
              [payload.quest_id, payload.user_id]
            );
            const reservation = held.rows[0];
            if (!reservation || reservation.attempt_status !== 'in_progress') {
              await client.query('ROLLBACK');
              return { success: false, statusCode: 409,
                error: { code: 'FUNDED_ATTEMPT_REQUIRED', message: 'Start the funded quest before submitting proof.' } };
            }
            if (Number(reservation.quest_version) !== Number(reservation.current_version)) {
              await client.query('ROLLBACK');
              return { success: false, statusCode: 409,
                error: { code: 'QUEST_REVISION_STALE', message: 'This quest changed; restart with the reviewed terms.' } };
            }
            const receiptTime = (await client.query('SELECT clock_timestamp() AS received_at')).rows[0].received_at;
            if (new Date(receiptTime).getTime() > new Date(reservation.expires_at).getTime()) {
              await client.query('ROLLBACK');
              return { success: false, statusCode: 409,
                error: { code: 'FUNDED_ATTEMPT_EXPIRED', message: 'The funded attempt deadline has passed.' } };
            }
            if (!claimNonceForInsert()) {
              await client.query('ROLLBACK');
              return { success: false, statusCode: 409,
                error: { code: 'CHALLENGE_ALREADY_USED', message: 'This challenge token has already been consumed.' } };
            }
            const inserted = await client.query(
              `INSERT INTO submissions
               (id, idempotency_key, user_id, quest_id, scanned_marker_code,
                captured_lat, captured_lng, captured_accuracy, status, created_at,
                updated_at, economic_attempt_id, is_test)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$9,$10,$11) RETURNING *`,
              [subId, payload.idempotency_key, payload.user_id, payload.quest_id,
                finalMarkerCode, payload.captured_lat, payload.captured_lng,
                payload.captured_accuracy, receiptTime, reservation.attempt_id,
                Boolean(scope.rows[0].user_test)]
            );
            await client.query(
              `UPDATE reward_reservations SET status = 'submitted', submission_id = $2,
               submitted_at = $3, updated_at = clock_timestamp() WHERE id = $1`,
              [reservation.id, subId, receiptTime]
            );
            await client.query(
              `UPDATE quest_attempts SET status = 'submitted', updated_at = clock_timestamp()
               WHERE id = $1`, [reservation.attempt_id]
            );
            const commit = await client.query('COMMIT');
            if (commit.command !== 'COMMIT') throw new Error('FUNDED_SUBMISSION_COMMIT_ABORTED');
            claimedNonceForInsert = undefined;
            const created = this.mapSubmissionRow(inserted.rows[0]);
            db.submissions.push(created);
            const cachedAttempt = db.quest_attempts.find((a) => a.id === reservation.attempt_id);
            if (cachedAttempt) cachedAttempt.status = 'submitted';
            return { success: true, statusCode: 201, data: created };
          } catch (error) {
            releaseInsertNonce();
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        }
      }
      const insertQuery = `
        INSERT INTO submissions (
          id, idempotency_key, user_id, quest_id, scanned_marker_code,
          captured_lat, captured_lng, captured_accuracy, status, created_at, updated_at, is_test
        )
        SELECT $1, $2, $3, $4, $5, $6::float, $7::float, $8::float,
               'pending'::submission_status, NOW(), NOW(), u.is_test
          FROM users u JOIN quests q ON q.id = $4
         WHERE u.id = $3 AND u.is_test = q.is_test
        RETURNING *
      `;
      const values = [
        subId,
        payload.idempotency_key,
        payload.user_id,
        payload.quest_id,
        finalMarkerCode,
        payload.captured_lat,
        payload.captured_lng,
        payload.captured_accuracy,
      ];
      if (!claimNonceForInsert()) {
        return { success: false, statusCode: 409,
          error: { code: 'CHALLENGE_ALREADY_USED', message: 'This challenge token has already been consumed.' } };
      }
      let rows: any[];
      try {
        ({ rows } = await pool.query(insertQuery, values));
      } catch (error) {
        releaseInsertNonce();
        throw error;
      }
      if (!rows[0]) {
        releaseInsertNonce();
        return { success: false, statusCode: 403,
          error: { code: 'SCOPE_MISMATCH', message: 'Traveler and quest scopes do not match.' } };
      }
      claimedNonceForInsert = undefined;
      const created = this.mapSubmissionRow(rows[0]);
      db.submissions.push(created);
      return {
        success: true,
        statusCode: 201,
        data: created,
      };
    }

    if (!claimNonceForInsert()) {
      return { success: false, statusCode: 409,
        error: { code: 'CHALLENGE_ALREADY_USED', message: 'This challenge token has already been consumed.' } };
    }
    let created: SubmissionRow;
    try {
      created = db.createSubmission({
      idempotency_key: payload.idempotency_key,
      user_id: payload.user_id,
      quest_id: payload.quest_id,
      scanned_marker_code: finalMarkerCode,
      captured_lat: payload.captured_lat,
      captured_lng: payload.captured_lng,
      captured_accuracy: payload.captured_accuracy,
      status: 'pending',
      is_test: Boolean(actor.is_test),
      });
    } catch (error) {
      releaseInsertNonce();
      throw error;
    }
    claimedNonceForInsert = undefined;
    return {
      success: true,
      statusCode: 201,
      data: created,
    };
  }

  async reviewSubmission(
    id: string,
    action: 'approve' | 'reject',
    adminId: string,
    rejectionReason?: string,
    appealDecision?: { appealId: string; reason: string }
  ): Promise<ServiceResult<{
    submission: SubmissionRow;
    awarded_points: number;
    awarded_explorer_coins?: string;
    explorer_coin_transaction_id?: string;
  }>> {
    const pool = getPool();
    const targetStatus = action === 'approve' ? 'approved' : 'rejected';

    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Shared lock order: governance singleton, then submission/user rows.
        await lockGovernanceSnapshot(client);
        const { rows: subRows } = await client.query('SELECT * FROM submissions WHERE id = $1 FOR UPDATE', [id]);
        if (!subRows.length) {
          await client.query('ROLLBACK');
          return {
            success: false,
            statusCode: 404,
            error: { code: 'NOT_FOUND', message: `Submission '${id}' not found.` },
          };
        }

        const sub = subRows[0];
        if (sub.user_id === adminId) {
          await client.query('ROLLBACK');
          return { success: false, statusCode: 403,
            error: { code: 'SELF_REVIEW_FORBIDDEN', message: 'Reviewers cannot approve or reject their own proof.' } };
        }
        // A replayed approval of an already-approved submission is idempotent: it must
        // reach the shortcut below instead of tripping on the attempt its own first
        // approval completed.
        if (action === 'approve' && sub.status !== 'approved') {
          // Use the same traveler lock as progressive-attempt approval so a
          // legacy proof and a reviewed attempt cannot both pay out in parallel.
          await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [sub.user_id]);
          if (await hasCompletedQuest(db, sub.user_id, sub.quest_id, client, id)) {
            await client.query('ROLLBACK');
            return { success: false, statusCode: 409,
              error: { code: 'ALREADY_COMPLETED', message: 'This traveler already has an approved proof for this quest. Reject this one as a duplicate.' } };
          }
        }
        if (appealDecision) {
          if (action !== 'approve' || appealDecision.reason.trim().length < 10 ||
              appealDecision.reason.trim().length > 2000) {
            await client.query('ROLLBACK');
            return { success: false, statusCode: 400,
              error: { code: 'INVALID_APPEAL_DECISION', message: 'Invalid appeal decision.' } };
          }
          const appeal = await client.query(
            `SELECT a.id, a.status, a.user_id, r.status AS reservation_status,
                    q.author_id, a.original_reviewer_id AS original_reviewer
             FROM reward_appeals a
             JOIN reward_reservations r ON r.id = a.reservation_id
             JOIN submissions s ON s.id = a.submission_id
             JOIN quests q ON q.id = s.quest_id
             WHERE a.id = $1 AND a.submission_id = $2 FOR UPDATE OF a`,
            [appealDecision.appealId, id]
          );
          const decision = appeal.rows[0];
          if (!decision || decision.user_id !== sub.user_id ||
              adminId === sub.user_id || adminId === decision.author_id ||
              adminId === decision.original_reviewer ||
              (decision.status !== 'submitted' && decision.status !== 'approved') ||
              (decision.status === 'approved' && sub.status !== 'approved') ||
              (decision.status === 'submitted' && sub.status !== 'rejected') ||
              (decision.status === 'submitted' && decision.reservation_status !== 'appeal')) {
            await client.query('ROLLBACK');
            return { success: false, statusCode: 409,
              error: { code: 'APPEAL_REVIEW_CONFLICT', message: 'Independent appeal review is unavailable.' } };
          }
          const reviewer = await client.query('SELECT role FROM users WHERE id = $1', [adminId]);
          if (reviewer.rows[0]?.role !== 'admin') throw new Error('ADMIN_APPEAL_REVIEW_REQUIRED');
          if (decision.status === 'submitted') {
            await client.query(
              `UPDATE reward_appeals SET status = 'approved', decided_by = $2,
               decided_at = clock_timestamp(), decision_reason = $3 WHERE id = $1`,
              [appealDecision.appealId, adminId, appealDecision.reason.trim()]
            );
          }
        }

        // Idempotent check: if already in target status, return cleanly without awarding points twice
        if (sub.status === targetStatus) {
          const coinReceipt = action === 'approve' && isLocalEconomyProfile()
            ? await new EconomyService(pool).receiptForApprovedSubmissionInTx(client, sub)
            : null;
          await commitGovernanceTransaction(client);
          return {
            success: true,
            statusCode: 200,
            data: {
              submission: this.mapSubmissionRow(sub),
              awarded_points: 0,
              ...(coinReceipt ? {
                awarded_explorer_coins: coinReceipt.amountMinor,
                explorer_coin_transaction_id: coinReceipt.transactionId,
              } : {}),
            },
          };
        }

        // Conflicting terminal state (e.g. reject after approve or vice versa)
        if (sub.status !== 'pending' && !(appealDecision && sub.status === 'rejected')) {
          await client.query('ROLLBACK');
          return {
            success: false,
            statusCode: 409,
            error: {
              code: 'STATE_CONFLICT',
              message: `Submission '${id}' has already been reviewed as '${sub.status}' and cannot transition.`,
            },
          };
        }

        // Transition the original rejected proof only through a separately
        // recorded, independently reviewed appeal. Normal approvals still
        // require a pending submission.
        const updateSubQuery = `
          UPDATE submissions
          SET status = $2, rejection_reason = $3, reviewed_by = $4, reviewed_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = $5
          RETURNING *
        `;
        let updatedSubRows: any[];
        try {
          ({ rows: updatedSubRows } = await client.query(updateSubQuery, [
            id,
            targetStatus,
            action === 'reject' ? (rejectionReason ?? null) : null,
            adminId,
            appealDecision ? 'rejected' : 'pending',
          ]));
        } catch (error: any) {
          if (error.code === '23505' && error.constraint === 'idx_submissions_unique_approved') {
            await client.query('ROLLBACK');
            return { success: false, statusCode: 409,
              error: { code: 'ALREADY_COMPLETED', message: 'This traveler already has an approved proof for this quest. Reject this one as a duplicate.' } };
          }
          throw error;
        }

        if (updatedSubRows.length === 0) {
          const { rows: currentRows } = await client.query('SELECT * FROM submissions WHERE id = $1', [id]);
          await commitGovernanceTransaction(client);
          if (currentRows.length && currentRows[0].status === targetStatus) {
            return {
              success: true,
              statusCode: 200,
              data: {
                submission: this.mapSubmissionRow(currentRows[0]),
                awarded_points: 0,
              },
            };
          }
          return {
            success: false,
            statusCode: 409,
            error: {
              code: 'STATE_CONFLICT',
              message: `Submission '${id}' has already been reviewed as '${currentRows[0]?.status}' and cannot transition.`,
            },
          };
        }

        const updatedSub = this.mapSubmissionRow(updatedSubRows[0]);

        let awardedPoints = 0;
        let awardedExplorerCoins: string | undefined;
        let explorerCoinTransactionId: string | undefined;
        let newPoints: number | undefined;
        let govResult: any = null;
        let fundedGroups: CommittedLedgerGroup[] | undefined;
        let fundedAttemptId: string | undefined;
        if (action === 'approve') {
          // Lock user row
          await client.query('SELECT demo_points FROM users WHERE id = $1 FOR UPDATE', [sub.user_id]);
          const { rows: questRows } = await client.query('SELECT * FROM quests WHERE id = $1', [sub.quest_id]);
          const quest = questRows[0];
          if (quest) {
            awardedPoints = quest.reward_points;
            const rewardSettlement = await settleReward({
              client, userId: updatedSub.user_id, questId: quest.id,
              referenceId: updatedSub.id, actorId: adminId, rewardPoints: awardedPoints,
            });
            newPoints = rewardSettlement.newPoints;
            govResult = rewardSettlement.governanceResult;
            fundedGroups = rewardSettlement.fundedGroups;
            fundedAttemptId = rewardSettlement.fundedAttemptId;
            awardedPoints = rewardSettlement.awardedPoints;
          }

          if (isLocalEconomyProfile()) {
            const coinReceipt = await new EconomyService(pool).settleApprovedSubmissionInTx(
              client, updatedSub, adminId
            );
            awardedExplorerCoins = coinReceipt?.amountMinor;
            explorerCoinTransactionId = coinReceipt?.transactionId;
          }

          // Emit progression outbox event within the SAME transaction if enabled
          if (env.PROGRESSION_ENABLED && env.PROGRESSION_EMIT_OUTBOX_ENABLED) {
            await progressionService.recordApprovalOutboxEvent(
              {
                id: updatedSub.id,
                user_id: updatedSub.user_id,
                quest_id: updatedSub.quest_id,
                created_at: updatedSub.created_at,
                reviewed_at: updatedSub.reviewed_at,
                is_test: updatedSub.is_test,
              },
              client
            );
          }

          // Complete the exact funded attempt when present. A funded proof has
          // already moved its attempt to 'submitted'; the legacy in-memory
          // path still uses the active user/quest pair.
          if (sub.economic_attempt_id) {
            const completedAttempt = await client.query(
              `UPDATE quest_attempts SET status = 'completed', completed_at = NOW(), updated_at = NOW()
               WHERE id = $1 AND user_id = $2 AND quest_id = $3 AND status = 'submitted'`,
              [sub.economic_attempt_id, updatedSub.user_id, updatedSub.quest_id]
            );
            if (completedAttempt.rowCount !== 1) throw new Error('FUNDED_ATTEMPT_COMPLETION_REQUIRED');
          } else {
            try {
              await client.query(
                "UPDATE quest_attempts SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE user_id = $1 AND quest_id = $2 AND status = 'in_progress'",
                [updatedSub.user_id, updatedSub.quest_id]
              );
            } catch {
              // non-fatal if table not present in legacy fixtures
            }
          }
        } else if (isLocalEconomyProfile()) {
          await new EconomyService(pool).holdRejectedSubmissionInTx(client, updatedSub);
        }

        if (action === 'reject') {
          await client.query(
            `UPDATE quest_attempts SET status='in_progress',updated_at=NOW() WHERE id IN
             (SELECT h.attempt_id FROM quest_funding_holds h WHERE h.submission_id=$1 AND h.status='held')`, [id]);
        }

        await commitGovernanceTransaction(client);
        if (fundedGroups) publishFunding(fundedGroups);
        if (fundedAttemptId) {
          const attempt = db.quest_attempts.find(row => row.id === fundedAttemptId);
          if (attempt) attempt.status = 'completed';
        }

        // Sync in-memory representation after successful commit
        const memSub = db.submissions.find((s) => s.id === id);
        if (memSub) {
          Object.assign(memSub, updatedSub);
        }
        if (action === 'approve') {
          if (sub.economic_attempt_id) {
            const cachedAttempt = db.quest_attempts.find((a) => a.id === sub.economic_attempt_id);
            if (cachedAttempt) {
              cachedAttempt.status = 'completed';
              cachedAttempt.completed_at = new Date().toISOString();
              cachedAttempt.updated_at = cachedAttempt.completed_at;
            }
          } else {
            db.completeAttempt(updatedSub.user_id, updatedSub.quest_id);
          }
        }
        if (action === 'approve' && newPoints !== undefined) {
          const memUser = db.findUserById(sub.user_id);
          if (memUser) {
            memUser.demo_points = newPoints;
            memUser.updated_at = updatedSub.updated_at;
          }
          if (govResult && govResult.entries) {
            governanceStore.publishCommittedTransaction({
              entries: govResult.entries,
              audit: [govResult.audit],
              userBalanceUpdate: { userId: sub.user_id, demoPoints: newPoints, balanceMjdq: govResult.balanceMjdq },
            });
          }
        }

        return {
          success: true,
          statusCode: 200,
          data: {
            submission: updatedSub,
            awarded_points: awardedPoints,
            ...(awardedExplorerCoins ? { awarded_explorer_coins: awardedExplorerCoins } : {}),
            ...(explorerCoinTransactionId ? { explorer_coin_transaction_id: explorerCoinTransactionId } : {}),
          },
        };
      } catch (error) {
        await client.query('ROLLBACK');
        if (error instanceof FundingError) return { success: false, statusCode: error.status, error: { code: error.code, message: error.message } };
        if ((error as any)?.code === '23505' && (error as any)?.constraint === 'idx_submissions_unique_approved') {
          return { success: false, statusCode: 409,
            error: { code: 'ALREADY_COMPLETED', message: 'This traveler already has an approved proof for this quest. Reject this one as a duplicate.' } };
        }
        throw error;
      } finally {
        client.release();
      }
    }

    // In-memory fallback
    const existingSubmission = db.submissions.find((submission) => submission.id === id);
    if (existingSubmission?.user_id === adminId) {
      return { success: false, statusCode: 403,
        error: { code: 'SELF_REVIEW_FORBIDDEN', message: 'Reviewers cannot approve or reject their own proof.' } };
    }
    const result = db.reviewSubmission(id, action, adminId, rejectionReason);
    if (!result) {
      return {
        success: false,
        statusCode: 404,
        error: { code: 'NOT_FOUND', message: `Submission '${id}' not found.` },
      };
    }
    if (result.conflicting) {
      return {
        success: false,
        statusCode: 409,
        error: {
          code: result.reason ?? 'STATE_CONFLICT',
          message: result.reason === 'ALREADY_COMPLETED'
            ? 'This traveler already has an approved proof for this quest. Reject this one as a duplicate.'
            : `Submission '${id}' has already been reviewed as '${result.submission.status}' and cannot transition.`,
        },
      };
    }

    const quest = db.findQuestById(result.submission.quest_id, true);
    const awardedPoints = action === 'approve' && !result.alreadyReviewed ? quest?.reward_points || 0 : 0;
    if (action === 'approve') {
      db.completeAttempt(result.submission.user_id, result.submission.quest_id);
      if (!result.alreadyReviewed && quest) {
        await settleReward({
          userId: result.submission.user_id, questId: quest.id,
          referenceId: result.submission.id, actorId: adminId, rewardPoints: awardedPoints,
        });
      }
    }

    return {
      success: true,
      statusCode: 200,
      data: {
        submission: result.submission,
        awarded_points: awardedPoints,
      },
    };
  }

  private mapSubmissionRow(row: any): SubmissionRow {
    return {
      id: row.id,
      idempotency_key: row.idempotency_key,
      user_id: row.user_id,
      quest_id: row.quest_id,
      scanned_marker_code: row.scanned_marker_code,
      captured_lat: parseFloat(row.captured_lat),
      captured_lng: parseFloat(row.captured_lng),
      captured_accuracy: parseFloat(row.captured_accuracy),
      status: row.status,
      is_test: Boolean(row.is_test),
      rejection_reason: row.rejection_reason ?? undefined,
      reviewed_by: row.reviewed_by ?? undefined,
      reviewed_at: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : undefined,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    };
  }
}

export const submissionsService = new SubmissionsService();
