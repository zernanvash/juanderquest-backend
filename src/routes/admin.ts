import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
import { submissionsService } from '../services/submissions.js';

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

export default router;
