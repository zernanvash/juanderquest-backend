import { db, SubmissionRow, calculateHaversineDistance } from '../db/index.js';
import { getPool } from '../db/pool.js';
import { lockGovernanceSnapshot, commitGovernanceTransaction } from '../governance/transaction.js';
import { governanceStore } from '../routes/proposals.js';
import { progressionService } from '../progression/service.js';
import { env } from '../config/env.js';
import { randomUUID } from 'crypto';

export interface CreateSubmissionInput {
  idempotency_key: string;
  user_id: string;
  quest_id: string;
  scanned_marker_code: string;
  captured_lat: number;
  captured_lng: number;
  captured_accuracy: number;
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

    // 1. User-scoped Idempotency Check
    if (pool) {
      const { rows: existingRows } = await pool.query(
        'SELECT * FROM submissions WHERE idempotency_key = $1 AND user_id = $2',
        [payload.idempotency_key, payload.user_id]
      );
      if (existingRows.length > 0) {
        const existing = existingRows[0];
        if (existing.quest_id !== payload.quest_id || existing.scanned_marker_code !== payload.scanned_marker_code) {
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
        if (existing.quest_id !== payload.quest_id || existing.scanned_marker_code !== payload.scanned_marker_code) {
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
    const quest = db.findQuestById(payload.quest_id);
    if (!quest) {
      return {
        success: false,
        statusCode: 404,
        error: { code: 'NOT_FOUND', message: `Quest '${payload.quest_id}' not found.` },
      };
    }

    // 3. Duplicate approved completion check
    if (pool) {
      const { rows } = await pool.query(
        "SELECT 1 FROM submissions WHERE user_id = $1 AND quest_id = $2 AND status = 'approved' LIMIT 1",
        [payload.user_id, payload.quest_id]
      );
      if (rows.length > 0) {
        return {
          success: false,
          statusCode: 409,
          error: { code: 'ALREADY_COMPLETED', message: 'You have already completed this quest.' },
        };
      }
    } else if (db.hasApprovedSubmission(payload.user_id, payload.quest_id)) {
      return {
        success: false,
        statusCode: 409,
        error: { code: 'ALREADY_COMPLETED', message: 'You have already completed this quest.' },
      };
    }

    // 4. Check marker match
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
      const insertQuery = `
        INSERT INTO submissions (
          id, idempotency_key, user_id, quest_id, scanned_marker_code,
          captured_lat, captured_lng, captured_accuracy, status, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW(), NOW())
        RETURNING *
      `;
      const values = [
        subId,
        payload.idempotency_key,
        payload.user_id,
        payload.quest_id,
        payload.scanned_marker_code,
        payload.captured_lat,
        payload.captured_lng,
        payload.captured_accuracy,
      ];
      const { rows } = await pool.query(insertQuery, values);
      const created = this.mapSubmissionRow(rows[0]);
      db.submissions.push(created);
      return {
        success: true,
        statusCode: 201,
        data: created,
      };
    }

    const created = db.createSubmission({
      idempotency_key: payload.idempotency_key,
      user_id: payload.user_id,
      quest_id: payload.quest_id,
      scanned_marker_code: payload.scanned_marker_code,
      captured_lat: payload.captured_lat,
      captured_lng: payload.captured_lng,
      captured_accuracy: payload.captured_accuracy,
      status: 'pending',
    });
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
    rejectionReason?: string
  ): Promise<ServiceResult<{ submission: SubmissionRow; awarded_points: number }>> {
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

        // Idempotent check: if already in target status, return cleanly without awarding points twice
        if (sub.status === targetStatus) {
          await commitGovernanceTransaction(client);
          return {
            success: true,
            statusCode: 200,
            data: {
              submission: this.mapSubmissionRow(sub),
              awarded_points: 0,
            },
          };
        }

        // Conflicting terminal state (e.g. reject after approve or vice versa)
        if (sub.status !== 'pending') {
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

        // Transition submission status atomically from pending
        const updateSubQuery = `
          UPDATE submissions
          SET status = $2, rejection_reason = $3, reviewed_by = $4, reviewed_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'pending'
          RETURNING *
        `;
        const { rows: updatedSubRows } = await client.query(updateSubQuery, [
          id,
          targetStatus,
          action === 'reject' ? (rejectionReason ?? null) : null,
          adminId,
        ]);

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
        let newPoints: number | undefined;
        let govResult: any = null;
        if (action === 'approve') {
          // Lock user row
          await client.query('SELECT demo_points FROM users WHERE id = $1 FOR UPDATE', [sub.user_id]);
          const { rows: questRows } = await client.query('SELECT * FROM quests WHERE id = $1', [sub.quest_id]);
          const quest = questRows[0];
          if (quest) {
            awardedPoints = quest.reward_points;
            const balanceResult = await client.query(
              'UPDATE users SET demo_points = demo_points + ($2)::int, updated_at = NOW() WHERE id = $1 RETURNING demo_points',
              [sub.user_id, awardedPoints]
            );
            newPoints = balanceResult.rows[0]?.demo_points;
            if (newPoints === undefined) throw new Error('USER_NOT_FOUND');
            // Atomically record ledger reward credit in the SAME transaction BEFORE commit
            try {
              govResult = await governanceStore.creditQuestReward(
                updatedSub.user_id,
                quest.id,
                updatedSub.id,
                awardedPoints,
                adminId,
                client
              );
            } catch (govErr) {
              await client.query('ROLLBACK');
              throw govErr;
            }
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
        }

        await commitGovernanceTransaction(client);

        // Sync in-memory representation after successful commit
        const memSub = db.submissions.find((s) => s.id === id);
        if (memSub) {
          Object.assign(memSub, updatedSub);
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
          },
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    // In-memory fallback
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
          code: 'STATE_CONFLICT',
          message: `Submission '${id}' has already been reviewed as '${result.submission.status}' and cannot transition.`,
        },
      };
    }

    const quest = db.findQuestById(result.submission.quest_id, true);
    const awardedPoints = action === 'approve' && !result.alreadyReviewed ? quest?.reward_points || 0 : 0;
    if (action === 'approve' && !result.alreadyReviewed && quest) {
      void governanceStore.creditQuestReward(result.submission.user_id, quest.id, result.submission.id, awardedPoints, adminId);
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
      rejection_reason: row.rejection_reason ?? undefined,
      reviewed_by: row.reviewed_by ?? undefined,
      reviewed_at: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : undefined,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    };
  }
}

export const submissionsService = new SubmissionsService();
