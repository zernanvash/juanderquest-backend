import { Router, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { db } from '../db/index.js';
import { getPool } from '../db/pool.js';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
import { submissionsService } from '../services/submissions.js';
import { lockGovernanceSnapshot, commitGovernanceTransaction } from '../governance/transaction.js';
import { progressionService } from '../progression/service.js';
import { env } from '../config/env.js';
import { spotStore } from '../spots/store.js';
import { hasCompletedQuest } from '../services/quest-completion.js';
import { settleReward } from '../funding/rewardSettlement.js';
import { hasFundingPlan } from '../funding/holds.js';
import { publishFunding, FundingError } from '../funding/transaction.js';
import { governanceStore } from './proposals.js';

const router = Router();

router.use('/admin', authenticateToken, requireAdmin);

router.get('/admin/submissions', (req: AuthRequest, res: Response) => {
  const statusFilter = req.query.status as string | undefined;
  const submissions = db.listAllSubmissions(statusFilter);

  return res.status(200).json({
    success: true,
    data: submissions,
  });
});

const reviewSchema = z.object({
  body: z.object({
    action: z.enum(['approve', 'reject']),
    rejection_reason: z.string().optional(),
  }),
});

router.patch('/admin/submissions/:id', validateRequest(reviewSchema), async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { action, rejection_reason } = req.body;
  const adminId = req.user!.id;

  if (action === 'reject' && !rejection_reason) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Rejection reason is required when rejecting a submission.',
      },
    });
  }

  try {
    const result = await submissionsService.reviewSubmission(id, action, adminId, rejection_reason);

    if (!result.success) {
      return res.status(result.statusCode || 400).json({
        success: false,
        error: result.error,
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        ...result.data!.submission,
        awarded_points: result.data!.awarded_points,
        ...(result.data!.awarded_explorer_coins !== undefined
          ? { awarded_explorer_coins: result.data!.awarded_explorer_coins } : {}),
        ...(result.data!.explorer_coin_transaction_id !== undefined
          ? { explorer_coin_transaction_id: result.data!.explorer_coin_transaction_id } : {}),
      },
    });
  } catch (err) {
    console.error('[admin] review submission failed:', err);
    return res.status(503).json({
      success: false,
      error: { code: 'STORAGE_UNAVAILABLE', message: 'Durable review storage is unavailable. Please try again later.' },
    });
  }
});

router.get('/admin/quest-attempts', async (req: AuthRequest, res: Response) => {
  const statusFilter = req.query.status as string | undefined;
  const pool = getPool();
  if (pool) {
    try {
      const whereClause = statusFilter ? 'WHERE a.status = $1' : '';
      const params = statusFilter ? [statusFilter] : [];
      const query = `
        SELECT 
          a.*,
          q.title AS quest_title,
          q.location_name AS quest_location,
          u.display_name AS traveler_name,
          COALESCE(
            json_agg(
              json_build_object(
                'id', e.id,
                'step_order', e.step_order,
                'task_key', e.task_key,
                'title', e.title,
                'description', e.description,
                'checkpoint_type', e.checkpoint_type,
                'required', e.required,
                'status', e.status,
                'evidence_payload', e.evidence_payload,
                'failed_tries', e.failed_tries,
                'first_try_at', e.first_try_at,
                'submitted_at', e.submitted_at,
                'needs_changes_reason', e.needs_changes_reason,
                'rejection_reason', e.rejection_reason,
                'reviewed_by', e.reviewed_by,
                'reviewed_at', e.reviewed_at,
                'verified_at', e.verified_at
              ) ORDER BY e.step_order ASC
            ) FILTER (WHERE e.id IS NOT NULL),
            '[]'::json
          ) AS steps
        FROM quest_attempts a
        JOIN quests q ON q.id = a.quest_id
        LEFT JOIN users u ON u.id = a.user_id
        LEFT JOIN quest_step_evidence e ON e.attempt_id = a.id
        ${whereClause}
        GROUP BY a.id, q.title, q.location_name, u.display_name
        ORDER BY a.created_at DESC
      `;
      const result = await pool.query(query, params);
      return res.status(200).json({ success: true, data: result.rows });
    } catch (err) {
      console.error('[admin] Failed to list quest attempts from pool:', err);
      return res.status(500).json({ success: false, error: { code: 'DATABASE_ERROR', message: 'Failed to query quest attempts.' } });
    }
  }

  let attempts = db.quest_attempts;
  if (statusFilter) {
    attempts = attempts.filter((a) => a.status === statusFilter);
  }
  const enriched = attempts.map((a) => {
    const q = db.findQuestById(a.quest_id);
    const u = db.users.find((user) => user.id === a.user_id);
    const steps = db.getStepEvidence(a.id);
    return {
      ...a,
      quest_title: q?.title,
      quest_location: q?.location_name,
      traveler_name: u?.display_name || 'Traveler',
      steps,
    };
  });
  return res.status(200).json({ success: true, data: enriched });
});

router.get('/admin/quest-attempts/:id', async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const pool = getPool();
  if (pool) {
    try {
      const query = `
        SELECT 
          a.*,
          q.title AS quest_title,
          q.location_name AS quest_location,
          q.author_id AS quest_author_id,
          u.display_name AS traveler_name,
          COALESCE(
            json_agg(
              json_build_object(
                'id', e.id,
                'step_order', e.step_order,
                'task_key', e.task_key,
                'title', e.title,
                'description', e.description,
                'checkpoint_type', e.checkpoint_type,
                'required', e.required,
                'status', e.status,
                'evidence_payload', e.evidence_payload,
                'failed_tries', e.failed_tries,
                'first_try_at', e.first_try_at,
                'submitted_at', e.submitted_at,
                'needs_changes_reason', e.needs_changes_reason,
                'rejection_reason', e.rejection_reason,
                'reviewed_by', e.reviewed_by,
                'reviewed_at', e.reviewed_at,
                'verified_at', e.verified_at
              ) ORDER BY e.step_order ASC
            ) FILTER (WHERE e.id IS NOT NULL),
            '[]'::json
          ) AS steps
        FROM quest_attempts a
        JOIN quests q ON q.id = a.quest_id
        LEFT JOIN users u ON u.id = a.user_id
        LEFT JOIN quest_step_evidence e ON e.attempt_id = a.id
        WHERE a.id = $1
        GROUP BY a.id, q.title, q.location_name, q.author_id, u.display_name
      `;
      const result = await pool.query(query, [id]);
      if (!result.rows[0]) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Quest attempt not found.' } });
      }
      return res.status(200).json({ success: true, data: result.rows[0] });
    } catch (err) {
      console.error('[admin] Failed to fetch quest attempt detail:', err);
      return res.status(500).json({ success: false, error: { code: 'DATABASE_ERROR', message: 'Failed to query quest attempt.' } });
    }
  }

  const memAttempt = db.quest_attempts.find((a) => a.id === id);
  if (!memAttempt) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Quest attempt not found.' } });
  }
  const q = db.findQuestById(memAttempt.quest_id);
  const u = db.users.find((user) => user.id === memAttempt.user_id);
  const steps = db.getStepEvidence(id);
  return res.status(200).json({
    success: true,
    data: {
      ...memAttempt,
      quest_title: q?.title,
      quest_location: q?.location_name,
      quest_author_id: q?.author_id,
      traveler_name: u?.display_name || 'Traveler',
      steps,
    },
  });
});

const questAttemptReviewSchema = z.object({
  body: z.object({
    action: z.enum(['approve', 'reject', 'request_changes']),
    rejection_reason: z.string().optional(),
    step_order: z.number().int().positive().optional(),
  }),
});

router.patch('/admin/quest-attempts/:id', validateRequest(questAttemptReviewSchema), async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { action, rejection_reason, step_order } = req.body;
  const adminId = req.user!.id;
  const pool = getPool();

  if ((action === 'reject' || action === 'request_changes') && !rejection_reason) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Rejection reason is required when rejecting or requesting changes.' },
    });
  }

  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockGovernanceSnapshot(client);

      // Read the owner first, then acquire user -> attempt locks. Attempt starts
      // also lock the traveler before inspecting an active attempt, so keep one
      // order to avoid a start-vs-approval deadlock.
      const ownerRes = await client.query('SELECT user_id FROM quest_attempts WHERE id = $1', [id]);
      if (!ownerRes.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Quest attempt '${id}' not found.` } });
      }
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [ownerRes.rows[0].user_id]);
      const attemptRes = await client.query('SELECT * FROM quest_attempts WHERE id = $1 FOR UPDATE', [id]);
      if (!attemptRes.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Quest attempt '${id}' not found.` } });
      }

      const attempt = attemptRes.rows[0];
      const questRes = await client.query('SELECT * FROM quests WHERE id = $1', [attempt.quest_id]);
      const quest = questRes.rows[0];
      if (!quest) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Quest not found.' } });
      }

      if (attempt.user_id === adminId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ success: false, error: { code: 'CANNOT_REVIEW_OWN_ATTEMPT', message: 'Administrators cannot approve their own quest attempts.' } });
      }

      if (quest.author_id === adminId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ success: false, error: { code: 'CREATOR_SELF_ATTEMPT', message: 'Quest authors cannot review attempts on their own quests.' } });
      }

      if (attempt.status === 'completed' && action === 'approve') {
        await commitGovernanceTransaction(client);
        return res.status(200).json({ success: true, data: { attempt, awarded_points: 0 }, message: 'Attempt already completed.' });
      }

      if (action === 'approve') {
        if (await hasFundingPlan(client, quest.id) && attempt.status !== 'submitted') {
          throw new FundingError('FUNDING_PLAN_STATE', 409, 'Submit all required quest steps before approval.');
        }
        // The traveler row is already locked before the attempt row above.
        // This serializes attempt and proof approvals across review paths.
        if (await hasCompletedQuest(db, attempt.user_id, quest.id, client)) {
          await client.query('ROLLBACK');
          return res.status(409).json({ success: false, error: {
            code: 'ALREADY_COMPLETED', message: 'This traveler has already completed this quest and cannot receive another reward.'
          } });
        }
        // Plan 43 §4.5: Attempt approval requires EVERY required photo task already verified.
        // Auto-verify of pending photo tasks is removed.
        const pendingStepsRes = await client.query(
          "SELECT step_order, title, checkpoint_type FROM quest_step_evidence WHERE attempt_id = $1 AND required = TRUE AND status != 'verified'",
          [id]
        );
        if (pendingStepsRes.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            success: false,
            error: {
              code: 'TASKS_PENDING_REVIEW',
              message: 'All required quest tasks must be verified before the attempt can be approved.',
              pending_tasks: pendingStepsRes.rows.map((r: any) => ({
                step_order: r.step_order,
                title: r.title,
                checkpoint_type: r.checkpoint_type,
              })),
            },
          });
        }

        const awardedPoints = quest.reward_points || 0;
        const rewardSettlement = await settleReward({
          client, userId: attempt.user_id, questId: quest.id, referenceId: id,
          actorId: adminId, rewardPoints: awardedPoints,
        });
        const updatedAttemptRes = await client.query(
          "UPDATE quest_attempts SET status = 'completed', completed_at = NOW(), reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW() WHERE id = $2 RETURNING *",
          [adminId, id]
        );

        // Progression outbox
        if (env.PROGRESSION_ENABLED && env.PROGRESSION_EMIT_OUTBOX_ENABLED) {
          await progressionService.recordApprovalOutboxEvent(
            { id, user_id: attempt.user_id, quest_id: quest.id, created_at: attempt.created_at, reviewed_at: new Date().toISOString(), is_test: attempt.is_test },
            client
          );
        }

        // Gallery publication check for photo steps with opt-in
        const photoSteps = await client.query(
          "SELECT * FROM quest_step_evidence WHERE attempt_id = $1 AND checkpoint_type = 'photo'",
          [id]
        );
        for (const row of photoSteps.rows) {
          const payload = typeof row.evidence_payload === 'string' ? JSON.parse(row.evidence_payload) : row.evidence_payload;
          if (payload?.gallery_opt_in === true && payload?.photo_url) {
            const spot = spotStore.spots.find((s) => s.quest_id === quest.id);
            if (spot && (spot as any).photos) {
              (spot as any).photos.push({
                id: `photo_${randomUUID().slice(0, 8)}`,
                url: payload.photo_url,
                user_id: attempt.user_id,
                created_at: new Date().toISOString(),
              });
            }
          }
        }

        await commitGovernanceTransaction(client);
        if (rewardSettlement.fundedGroups) publishFunding(rewardSettlement.fundedGroups);
        const gov = rewardSettlement.governanceResult;
        if (gov) governanceStore.publishCommittedTransaction({ entries: gov.entries, audit: [gov.audit],
          userBalanceUpdate: { userId: attempt.user_id, demoPoints: rewardSettlement.newPoints } });

        // Mirror in memory
        const memAttempt = db.quest_attempts.find((a) => a.id === id);
        if (memAttempt) {
          memAttempt.status = 'completed';
          memAttempt.completed_at = new Date().toISOString();
          memAttempt.reviewed_by = adminId;
          memAttempt.reviewed_at = new Date().toISOString();
        }
        for (const ev of db.quest_step_evidence.filter((e) => e.attempt_id === id)) {
          if (ev.status === 'pending_review') {
            ev.status = 'verified';
            ev.reviewed_by = adminId;
            ev.reviewed_at = new Date().toISOString();
          }
        }
        const traveler = db.users.find((u) => u.id === attempt.user_id);
        if (traveler) traveler.demo_points = rewardSettlement.newPoints;

        return res.status(200).json({
          success: true,
          data: { attempt: updatedAttemptRes.rows[0], awarded_points: rewardSettlement.awardedPoints,
            ...(rewardSettlement.voucherPerk?{voucher_perk:rewardSettlement.voucherPerk}:{}) },
          message: 'Quest attempt approved and reward points granted.',
        });
      } else if (action === 'request_changes') {
        if (step_order) {
          await client.query(
            "UPDATE quest_step_evidence SET status = 'needs_changes', rejection_reason = $1, reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW() WHERE attempt_id = $3 AND step_order = $4",
            [rejection_reason, adminId, id, step_order]
          );
        } else {
          await client.query(
            "UPDATE quest_step_evidence SET status = 'needs_changes', rejection_reason = $1, reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW() WHERE attempt_id = $3 AND status = 'pending_review'",
            [rejection_reason, adminId, id]
          );
        }
        const updatedAttemptRes = await client.query(
          "UPDATE quest_attempts SET status = 'in_progress', review_notes = $1, reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW() WHERE id = $3 RETURNING *",
          [rejection_reason, adminId, id]
        );
        await commitGovernanceTransaction(client);

        const memAttempt = db.quest_attempts.find((a) => a.id === id);
        if (memAttempt) {
          memAttempt.status = 'in_progress';
          memAttempt.review_notes = rejection_reason;
        }

        return res.status(200).json({
          success: true,
          data: { attempt: updatedAttemptRes.rows[0] },
          message: 'Changes requested for quest attempt.',
        });
      } else if (action === 'reject') {
        const retryable = await hasFundingPlan(client, quest.id);
        if (retryable) await client.query("UPDATE quest_step_evidence SET status='needs_changes',rejection_reason=$2,updated_at=NOW() WHERE attempt_id=$1 AND status='pending_review'",[id,rejection_reason]);
        const updatedAttemptRes = await client.query(
          "UPDATE quest_attempts SET status = $4, review_notes = $1, reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW() WHERE id = $3 RETURNING *",
          [rejection_reason, adminId, id, retryable ? 'in_progress' : 'abandoned']
        );
        await commitGovernanceTransaction(client);

        const memAttempt = db.quest_attempts.find((a) => a.id === id);
        if (memAttempt) {
          memAttempt.status = retryable ? 'in_progress' : 'abandoned';
          memAttempt.review_notes = rejection_reason;
        }

        return res.status(200).json({
          success: true,
          data: { attempt: updatedAttemptRes.rows[0] },
          message: 'Quest attempt rejected.',
        });
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (err instanceof FundingError) return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message } });
      if ((err as any)?.code === '23505' && (err as any)?.constraint === 'idx_quest_attempts_single_completion') {
        return res.status(409).json({ success: false, error: {
          code: 'ALREADY_COMPLETED', message: 'This traveler has already completed this quest and cannot receive another reward.'
        } });
      }
      console.error('[admin] quest-attempt review error:', err);
      return res.status(500).json({ success: false, error: { code: 'REVIEW_FAILED', message: 'Internal review processing failure.' } });
    } finally {
      client.release();
    }
  }

  // In-memory fallback
  const attempt = db.quest_attempts.find((a) => a.id === id);
  if (!attempt) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Quest attempt '${id}' not found.` } });
  }

  const quest = db.findQuestById(attempt.quest_id);
  if (!quest) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Quest not found.' } });
  }

  if (attempt.user_id === adminId) {
    return res.status(403).json({ success: false, error: { code: 'CANNOT_REVIEW_OWN_ATTEMPT', message: 'Administrators cannot approve their own quest attempts.' } });
  }

  if (quest.author_id === adminId) {
    return res.status(403).json({ success: false, error: { code: 'CREATOR_SELF_ATTEMPT', message: 'Quest authors cannot review attempts on their own quests.' } });
  }

  if (action === 'approve') {
    if (attempt.status === 'completed') {
      return res.status(200).json({ success: true, data: { attempt, awarded_points: 0 }, message: 'Attempt already completed.' });
    }
    if (await hasCompletedQuest(db, attempt.user_id, quest.id)) {
      return res.status(409).json({ success: false, error: {
        code: 'ALREADY_COMPLETED', message: 'This traveler has already completed this quest and cannot receive another reward.'
      } });
    }
    const awardedPoints = quest.reward_points || 0;
    attempt.status = 'completed';
    attempt.completed_at = new Date().toISOString();
    attempt.reviewed_by = adminId;
    attempt.reviewed_at = new Date().toISOString();

    for (const ev of db.quest_step_evidence.filter((e) => e.attempt_id === id)) {
      if (ev.status === 'pending_review') {
        ev.status = 'verified';
        ev.reviewed_by = adminId;
        ev.reviewed_at = new Date().toISOString();
      }
    }

    const rewardSettlement = await settleReward({
      userId: attempt.user_id, questId: quest.id, referenceId: id,
      actorId: adminId, rewardPoints: awardedPoints,
    });

    // Gallery publication check
    for (const ev of db.quest_step_evidence.filter((e) => e.attempt_id === id && e.checkpoint_type === 'photo')) {
      if (ev.evidence_payload?.gallery_opt_in === true && ev.evidence_payload?.photo_url) {
        const spot = spotStore.spots.find((s) => s.quest_id === quest.id);
        if (spot && (spot as any).photos) {
          (spot as any).photos.push({
            id: `photo_${randomUUID().slice(0, 8)}`,
            url: ev.evidence_payload.photo_url,
            user_id: attempt.user_id,
            created_at: new Date().toISOString(),
          });
        }
      }
    }

    return res.status(200).json({
      success: true,
      data: { attempt, awarded_points: rewardSettlement.awardedPoints },
      message: 'Quest attempt approved and reward points granted.',
    });
  } else if (action === 'request_changes') {
    if (step_order) {
      const ev = db.findStepEvidence(id, step_order);
      if (ev) {
        ev.status = 'needs_changes';
        ev.rejection_reason = rejection_reason;
      }
    } else {
      for (const ev of db.quest_step_evidence.filter((e) => e.attempt_id === id && e.status === 'pending_review')) {
        ev.status = 'needs_changes';
        ev.rejection_reason = rejection_reason;
      }
    }
    attempt.status = 'in_progress';
    attempt.review_notes = rejection_reason;
    return res.status(200).json({ success: true, data: { attempt }, message: 'Changes requested for quest attempt.' });
  } else if (action === 'reject') {
    attempt.status = 'abandoned';
    attempt.review_notes = rejection_reason;
    return res.status(200).json({ success: true, data: { attempt }, message: 'Quest attempt rejected.' });
  }
});

// PATCH /admin/quest-attempts/:id/steps/:stepOrder - Per-task review (Plan 43 §4.5)
const perTaskReviewSchema = z.object({
  params: z.object({ id: z.string().min(1), stepOrder: z.string().regex(/^[1-9]\d{0,2}$/) }),
  body: z.object({
    action: z.enum(['approve', 'needs_changes']),
    reason: z.string().trim().min(10).max(300).optional(),
  }),
});

router.patch(
  '/admin/quest-attempts/:id/steps/:stepOrder',
  validateRequest(perTaskReviewSchema),
  async (req: AuthRequest, res: Response) => {
    const { id, stepOrder: stepOrderStr } = req.params;
    const stepOrder = Number(stepOrderStr);
    const { action, reason } = req.body;
    const adminId = req.user!.id;

    if (action === 'needs_changes' && !reason) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Reason (10–300 characters) is required when requesting changes.' },
      });
    }

    const pool = getPool();
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Check attempt and creator self-review rule
        const attemptRes = await client.query('SELECT * FROM quest_attempts WHERE id = $1 FOR UPDATE', [id]);
        if (!attemptRes.rows[0]) {
          await client.query('ROLLBACK');
          return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Quest attempt not found.' } });
        }
        const attempt = attemptRes.rows[0];

        const questRes = await client.query('SELECT author_id FROM quests WHERE id = $1', [attempt.quest_id]);
        if (questRes.rows[0]?.author_id === adminId) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            success: false,
            error: { code: 'CREATOR_SELF_ATTEMPT', message: 'Quest authors cannot review tasks on their own quests.' },
          });
        }

        if (attempt.user_id === adminId) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            success: false,
            error: { code: 'CANNOT_REVIEW_OWN_ATTEMPT', message: 'Administrators cannot review their own quest attempts.' },
          });
        }

        const stepRes = await client.query(
          'SELECT * FROM quest_step_evidence WHERE attempt_id = $1 AND step_order = $2 FOR UPDATE',
          [id, stepOrder]
        );
        if (!stepRes.rows[0]) {
          await client.query('ROLLBACK');
          return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Step ${stepOrder} not found.` } });
        }
        const step = stepRes.rows[0];

        if (step.status !== 'pending_review') {
          await client.query('ROLLBACK');
          return res.status(409).json({
            success: false,
            error: { code: 'STEP_NOT_PENDING_REVIEW', message: `Task is currently '${step.status}', not pending review.` },
          });
        }

        let updatedStepRes;
        if (action === 'approve') {
          updatedStepRes = await client.query(
            `UPDATE quest_step_evidence
             SET status = 'verified', reviewed_by = $1, reviewed_at = NOW(), verified_at = NOW(), updated_at = NOW()
             WHERE attempt_id = $2 AND step_order = $3
             RETURNING *`,
            [adminId, id, stepOrder]
          );

          // Update verified steps count on attempt
          const countRes = await client.query(
            "SELECT COUNT(*) FROM quest_step_evidence WHERE attempt_id = $1 AND status = 'verified'",
            [id]
          );
          await client.query(
            'UPDATE quest_attempts SET verified_steps = $1, updated_at = NOW() WHERE id = $2',
            [parseInt(countRes.rows[0].count, 10), id]
          );
        } else {
          updatedStepRes = await client.query(
            `UPDATE quest_step_evidence
             SET status = 'needs_changes', needs_changes_reason = $1, rejection_reason = $1,
                 reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
             WHERE attempt_id = $3 AND step_order = $4
             RETURNING *`,
            [reason, adminId, id, stepOrder]
          );
        }

        await client.query('COMMIT');
        return res.status(200).json({
          success: true,
          data: { step: updatedStepRes.rows[0] },
          message: action === 'approve' ? 'Task evidence verified.' : 'Changes requested for task evidence.',
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.error('[admin] per-task review error:', err);
        return res.status(500).json({ success: false, error: { code: 'REVIEW_FAILED', message: 'Internal review processing failure.' } });
      } finally {
        client.release();
      }
    }

    // In-memory fallback
    const memAttempt = db.quest_attempts.find((a) => a.id === id);
    if (!memAttempt) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Quest attempt not found.' } });

    const memQuest = db.findQuestById(memAttempt.quest_id);
    if (memQuest?.author_id === adminId) {
      return res.status(403).json({ success: false, error: { code: 'CREATOR_SELF_ATTEMPT', message: 'Quest authors cannot review tasks on their own quests.' } });
    }
    if (memAttempt.user_id === adminId) {
      return res.status(403).json({ success: false, error: { code: 'CANNOT_REVIEW_OWN_ATTEMPT', message: 'Administrators cannot review their own quest attempts.' } });
    }

    const memStep = db.findStepEvidence(id, stepOrder);
    if (!memStep) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Step ${stepOrder} not found.` } });
    if (memStep.status !== 'pending_review') {
      return res.status(409).json({ success: false, error: { code: 'STEP_NOT_PENDING_REVIEW', message: `Task is currently '${memStep.status}', not pending review.` } });
    }

    const nowIso = new Date().toISOString();
    if (action === 'approve') {
      memStep.status = 'verified';
      memStep.reviewed_by = adminId;
      memStep.reviewed_at = nowIso;
      memStep.verified_at = nowIso;
      memStep.updated_at = nowIso;
      const memSteps = db.getStepEvidence(id);
      memAttempt.verified_steps = memSteps.filter((s) => s.status === 'verified').length;
    } else {
      memStep.status = 'needs_changes';
      memStep.needs_changes_reason = reason;
      memStep.rejection_reason = reason;
      memStep.reviewed_by = adminId;
      memStep.reviewed_at = nowIso;
      memStep.updated_at = nowIso;
    }
    db.saveStepEvidence(memStep);

    return res.status(200).json({
      success: true,
      data: { step: memStep },
      message: action === 'approve' ? 'Task evidence verified.' : 'Changes requested for task evidence.',
    });
  }
);

export default router;
