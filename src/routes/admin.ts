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

router.get('/admin/quest-attempts', (req: AuthRequest, res: Response) => {
  const statusFilter = req.query.status as string | undefined;
  let attempts = db.quest_attempts;
  if (statusFilter) {
    attempts = attempts.filter((a) => a.status === statusFilter);
  }
  return res.status(200).json({ success: true, data: attempts });
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
        const awardedPoints = quest.reward_points || 0;

        // Mark any pending_review steps as verified
        await client.query(
          "UPDATE quest_step_evidence SET status = 'verified', reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW() WHERE attempt_id = $2 AND status = 'pending_review'",
          [adminId, id]
        );

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

export default router;
