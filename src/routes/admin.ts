import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
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

router.patch('/admin/submissions/:id', validateRequest(reviewSchema), (req: AuthRequest, res: Response) => {
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

  const result = db.reviewSubmission(id, action, adminId, rejection_reason);

  if (!result) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Submission '${id}' not found.`,
      },
    });
  }

  const { submission: updatedSub, alreadyReviewed, conflicting } = result;

  // Conflicting terminal state (e.g. reject after approve) is an explicit 409, not silent success.
  if (conflicting) {
    return res.status(409).json({
      success: false,
      error: {
        code: 'STATE_CONFLICT',
        message: `Submission '${id}' has already been reviewed as '${updatedSub.status}' and cannot transition.`,
      },
    });
  }

  const quest = db.findQuestById(updatedSub.quest_id);
  if (action === 'approve' && !alreadyReviewed && quest) {
    governanceStore.creditQuestReward(updatedSub.user_id, quest.id, updatedSub.id, quest.reward_points, adminId);
  }

  return res.status(200).json({
    success: true,
    data: {
      ...updatedSub,
      awarded_points: action === 'approve' && !alreadyReviewed ? quest?.reward_points || 0 : 0,
    },
  });
});

export default router;
