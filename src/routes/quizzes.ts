import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, optionalAuthenticateToken, AuthRequest } from '../middleware/auth.js';
import { CulturalQuizRepository } from '../quizzes/repository.js';
import { ProgressionRepository } from '../progression/repository.js';
import { CulturalQuizService } from '../quizzes/service.js';

const router = Router();
const repo = new CulturalQuizRepository();
const progressionRepo = new ProgressionRepository();
const service = new CulturalQuizService(repo, progressionRepo);

const nearbySchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const startAttemptSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy_meters: z.number().positive().optional(),
  captured_at: z.string().optional(),
  idempotency_key: z.string().max(100).optional(),
});

const submitAttemptSchema = z.object({
  answers: z.array(
    z.object({
      question_id: z.string().min(1),
      selected_option_id: z.string().min(1),
    })
  ).length(5),
  idempotency_key: z.string().max(100).optional(),
});

// POST /api/v1/quizzes/nearby - Discover active quizzes within radius of current location
router.post('/quizzes/nearby', optionalAuthenticateToken, async (req: AuthRequest, res: Response) => {
  const parsed = nearbySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid latitude or longitude coordinates.' },
    });
  }

  try {
    const invitations = await service.getNearbyQuizzes(
      parsed.data.lat,
      parsed.data.lng,
      req.user?.id
    );

    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({
      success: true,
      data: invitations,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err?.message || 'Failed to query nearby quizzes.' },
    });
  }
});

// GET /api/v1/quizzes/:id - Public-safe introduction & user eligibility without grading keys
router.get('/quizzes/:id', optionalAuthenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const detail = await service.getQuizDetail(req.params.id, req.user?.id);
    if (!detail) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Cultural quiz not found.' },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        id: detail.quiz.id,
        destination_id: detail.quiz.destination_id,
        destination_name: detail.destination.name,
        municipality: detail.destination.municipality,
        gps_lat: detail.destination.gps_lat,
        gps_lng: detail.destination.gps_lng,
        title: detail.version.title,
        description: detail.version.description,
        language: detail.version.language,
        radius_meters: detail.version.radius_meters,
        xp_reward: detail.version.xp_reward,
        time_limit_minutes: detail.version.time_limit_minutes,
        cooldown_hours: detail.version.cooldown_hours,
        status: detail.quiz.status,
        version: detail.quiz.current_version,
        is_completed: detail.is_completed ?? false,
        active_attempt_id: detail.active_attempt_id,
        cooldown_until: detail.cooldown_until,
      },
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err?.message || 'Failed to fetch quiz detail.' },
    });
  }
});

// POST /api/v1/quizzes/:id/attempts - Start an authenticated attempt with GPS validation
router.post('/quizzes/:id/attempts', authenticateToken, async (req: AuthRequest, res: Response) => {
  const parsed = startAttemptSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid location or attempt parameters.' },
    });
  }

  try {
    const result = await service.startAttempt({
      quizId: req.params.id,
      userId: req.user!.id,
      lat: parsed.data.lat,
      lng: parsed.data.lng,
      accuracyMeters: parsed.data.accuracy_meters,
      capturedAt: parsed.data.captured_at,
      idempotencyKey: parsed.data.idempotency_key,
    });

    return res.status(201).json({
      success: true,
      data: {
        attempt: result.attempt,
        questions: result.questions,
      },
    });
  } catch (err: any) {
    const msg = err?.message || '';
    if (msg.startsWith('OUT_OF_RANGE')) {
      return res.status(403).json({ success: false, error: { code: 'OUT_OF_RANGE', message: msg } });
    }
    if (msg.startsWith('COOLDOWN_ACTIVE')) {
      return res.status(429).json({ success: false, error: { code: 'COOLDOWN_ACTIVE', message: msg } });
    }
    if (msg.startsWith('QUIZ_NOT_FOUND')) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: msg } });
    }
    if (msg.startsWith('QUIZ_NOT_AVAILABLE')) {
      return res.status(400).json({ success: false, error: { code: 'QUIZ_NOT_AVAILABLE', message: msg } });
    }

    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: msg || 'Failed to start quiz attempt.' },
    });
  }
});

// GET /api/v1/quiz-attempts/:id - Resumable active attempt questions (owner only)
router.get('/quiz-attempts/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const result = await service.getAttemptForUser(req.params.id, req.user!.id);
    if (!result) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Quiz attempt not found or not owned by caller.' },
      });
    }

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err?.message || 'Failed to fetch quiz attempt.' },
    });
  }
});

// PUT /api/v1/quiz-attempts/:id/submission - Submit answers for grading & Explorer XP
router.put('/quiz-attempts/:id/submission', authenticateToken, async (req: AuthRequest, res: Response) => {
  const parsed = submitAttemptSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Five valid answers are required.' },
    });
  }

  try {
    const mappedAnswers = parsed.data.answers.map((a) => ({
      questionId: a.question_id,
      selectedOptionId: a.selected_option_id,
    }));

    const result = await service.submitAttempt({
      attemptId: req.params.id,
      userId: req.user!.id,
      answers: mappedAnswers,
      idempotencyKey: parsed.data.idempotency_key,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err: any) {
    console.error('[quiz-submission] error:', err);
    const msg = err?.message || '';
    if (msg.startsWith('ATTEMPT_EXPIRED')) {
      return res.status(410).json({ success: false, error: { code: 'ATTEMPT_EXPIRED', message: msg } });
    }
    if (msg.startsWith('ATTEMPT_NOT_FOUND')) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: msg } });
    }
    if (msg.startsWith('UNAUTHORIZED_ATTEMPT')) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: msg } });
    }
    if (msg.startsWith('MISSING_ANSWERS') || msg.startsWith('DUPLICATE_ANSWERS') || msg.startsWith('INVALID_OPTION_ID')) {
      return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: msg } });
    }

    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: msg || 'Failed to grade quiz attempt.' },
    });
  }
});

// GET /api/v1/me/quiz-history - User's past quiz history and rewards
router.get('/me/quiz-history', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const history = await repo.listUserHistory(req.user!.id);
    return res.status(200).json({
      success: true,
      data: history,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err?.message || 'Failed to list quiz history.' },
    });
  }
});

export default router;
