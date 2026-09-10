import { Router, Response } from 'express';
import { z } from 'zod';
import { db, calculateHaversineDistance } from '../db/index.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { submissionsService } from '../services/submissions.js';

const router = Router();

const submissionSchema = z.object({
  body: z.object({
    idempotency_key: z.string().uuid('Idempotency key must be a valid UUID'),
    quest_id: z.string().min(1, 'Quest ID is required'),
    scanned_marker_code: z.string().min(1, 'Scanned marker code is required'),
    captured_lat: z.number().min(-90).max(90),
    captured_lng: z.number().min(-180).max(180),
    captured_accuracy: z.number().nonnegative(),
  }),
});

router.post(
  '/submissions',
  authenticateToken,
  rateLimit({ policyId: 'submissions:create', windowMs: 60_000, max: 30, keyStrategy: 'actor', coarseIpMax: 150 }),
  validateRequest(submissionSchema),
  async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { idempotency_key, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy } = req.body;

    try {
      const result = await submissionsService.createSubmission({
        idempotency_key,
        user_id: userId,
        quest_id,
        scanned_marker_code,
        captured_lat,
        captured_lng,
        captured_accuracy,
      });

      if (!result.success) {
        return res.status(result.statusCode || 400).json({
          success: false,
          error: result.error,
        });
      }

      return res.status(result.statusCode || 201).json({
        success: true,
        data: result.data,
      });
    } catch (err) {
      console.error('[submissions] creation failed:', err);
      return res.status(503).json({
        success: false,
        error: { code: 'STORAGE_UNAVAILABLE', message: 'Durable submission storage is unavailable. Please try again later.' },
      });
    }
  }
);

router.get('/submissions', authenticateToken, (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const userSubmissions = db.listSubmissionsForUser(userId);

  return res.status(200).json({
    success: true,
    data: userSubmissions,
  });
});

export default router;
