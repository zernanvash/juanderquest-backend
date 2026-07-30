import { Router, Response } from 'express';
import { z } from 'zod';
import { db, calculateHaversineDistance } from '../db/index.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';

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

router.post('/submissions', authenticateToken, validateRequest(submissionSchema), (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { idempotency_key, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy } = req.body;

  // 1. User-Scoped Idempotency Check (Fix 4.4)
  const existingSub = db.findSubmissionByIdempotency(idempotency_key, userId);
  if (existingSub) {
    return res.status(200).json({
      success: true,
      data: existingSub,
    });
  }

  // 2. Quest Existence
  const quest = db.findQuestById(quest_id);
  if (!quest) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Quest '${quest_id}' not found.`,
      },
    });
  }

  // 3. Duplicate Approved Completion Check (Fix 4.6)
  if (db.hasApprovedSubmission(userId, quest_id)) {
    return res.status(409).json({
      success: false,
      error: {
        code: 'ALREADY_COMPLETED',
        message: 'You have already completed this quest.',
      },
    });
  }

  // 4. Check Marker Match
  if (scanned_marker_code !== quest.marker_code) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: `Scanned marker code '${scanned_marker_code}' does not match target quest requirement.`,
      },
    });
  }

  // 5. GPS Radius Enforcement (Fix 4.3)
  const distanceMeters = calculateHaversineDistance(
    captured_lat,
    captured_lng,
    quest.gps_lat,
    quest.gps_lng
  );

  if (distanceMeters > quest.radius_meters) {
    return res.status(422).json({
      success: false,
      error: {
        code: 'OUT_OF_RANGE',
        message: `Your captured location is ${distanceMeters}m away, which exceeds the allowed ${quest.radius_meters}m radius for ${quest.title}.`,
      },
    });
  }

  // 6. Create Pending Submission
  const newSubmission = db.createSubmission({
    idempotency_key,
    user_id: userId,
    quest_id,
    scanned_marker_code,
    captured_lat,
    captured_lng,
    captured_accuracy,
    status: 'pending',
  });

  return res.status(201).json({
    success: true,
    data: newSubmission,
  });
});

router.get('/submissions', authenticateToken, (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const userSubmissions = db.listSubmissionsForUser(userId);

  return res.status(200).json({
    success: true,
    data: userSubmissions,
  });
});

export default router;
