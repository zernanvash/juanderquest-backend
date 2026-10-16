import { Router, Response } from 'express';
import { z } from 'zod';
import { db, calculateHaversineDistance } from '../db/index.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { submissionsService } from '../services/submissions.js';

const router = Router();

const submissionSchema = z.object({
  body: z
    .object({
      idempotency_key: z.string().uuid('Idempotency key must be a valid UUID'),
      quest_id: z.string().min(1, 'Quest ID is required'),
      scanned_marker_code: z.string().min(1).optional(),
      challenge_token: z.string().min(1).optional(),
      captured_lat: z.number().min(-90).max(90),
      captured_lng: z.number().min(-180).max(180),
      captured_accuracy: z.number().nonnegative(),
    })
    .refine((data) => Boolean(data.scanned_marker_code || data.challenge_token), {
      message: 'Either challenge_token or scanned_marker_code is required',
      path: ['challenge_token'],
    }),
});

router.post(
  '/submissions',
  authenticateToken,
  rateLimit({ policyId: 'submissions:create', windowMs: 60_000, max: 30, keyStrategy: 'actor', coarseIpMax: 150 }),
  validateRequest(submissionSchema),
  async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { idempotency_key, quest_id, scanned_marker_code, challenge_token, captured_lat, captured_lng, captured_accuracy } = req.body;
    const submissionInput = {
      idempotency_key,
      user_id: userId,
      quest_id,
      scanned_marker_code,
      challenge_token,
      captured_lat,
      captured_lng,
      captured_accuracy,
    };

    try {
      const result = await submissionsService.createSubmission(submissionInput);

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
    } catch (err: any) {
      console.error('[submissions] creation failed:', err);
      if (err?.code === '23505' && err?.constraint === 'idx_submissions_unique_pending') {
        return res.status(409).json({ success: false,
          error: { code: 'SUBMISSION_PENDING', message: 'A proof for this quest is already awaiting review.' } });
      }
      if (err?.code === '23505' && err?.constraint === 'idx_submissions_challenge_nonce') {
        return res.status(409).json({ success: false,
          error: { code: 'CHALLENGE_ALREADY_USED', message: 'This challenge token has already been consumed.' } });
      }
      if (err?.code === '23505' && err?.constraint === 'submissions_idempotency_key_key') {
        try {
          const replay = await submissionsService.createSubmission(submissionInput);
          if (replay.success) return res.status(replay.statusCode || 200).json({ success: true, data: replay.data });
          if (replay.error?.code === 'IDEMPOTENCY_CONFLICT') {
            return res.status(replay.statusCode || 409).json({ success: false, error: replay.error });
          }
        } catch (replayError) {
          console.error('[submissions] idempotency replay lookup failed:', replayError);
        }
      }
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
