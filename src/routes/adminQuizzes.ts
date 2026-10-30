import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { CulturalQuizRepository } from '../quizzes/repository.js';
import { ProgressionRepository } from '../progression/repository.js';
import { CulturalQuizService } from '../quizzes/service.js';

const router = Router();
const repo = new CulturalQuizRepository();
const progressionRepo = new ProgressionRepository();
const service = new CulturalQuizService(repo, progressionRepo);

const createDraftSchema = z.object({
  destination_id: z.string().min(1),
  title: z.string().min(3).max(200),
  description: z.string().min(10),
  language: z.enum(['en', 'fil', 'ilo', 'pag']).default('en'),
  radius_meters: z.number().int().min(100).max(1000).default(200),
  xp_reward: z.number().int().positive().default(25),
  time_limit_minutes: z.number().int().min(5).max(120).default(30),
  cooldown_hours: z.number().int().min(1).max(168).default(24),
  host_lines: z.any().optional(),
  theme: z.string().max(50).default('crt'),
  questions: z.array(
    z.object({
      ordinal: z.number().int().min(1).max(5),
      question_text: z.string().min(3),
      explanation: z.string().min(3),
      source_url: z.string().url().optional(),
      question_type: z.enum(['multiple_choice', 'true_false', 'picture', 'order', 'map_drop']).default('multiple_choice'),
      media_url: z.string().url().optional().nullable(),
      hint: z.string().max(500).optional().nullable(),
      round: z.enum(['main', 'special', 'lightning']).default('main'),
      answer_payload: z.any().optional().nullable(),
      options: z.array(
        z.object({
          ordinal: z.number().int().min(1).max(4),
          option_text: z.string().min(1),
          is_correct: z.boolean(),
        })
      ).length(4),
    })
  ).length(5),
  is_test: z.boolean().optional(),
});

// GET /api/v1/admin/quizzes - List all quizzes
router.get('/admin/quizzes', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const list = await repo.listAllQuizzesForAdmin();
    return res.status(200).json({
      success: true,
      data: list,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err?.message || 'Failed to list quizzes.' },
    });
  }
});

// POST /api/v1/admin/quizzes - Create draft quiz
router.post('/admin/quizzes', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  const parsed = createDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid quiz draft payload.', details: parsed.error.issues },
    });
  }

  try {
    const result = await service.createQuizDraft({
      destinationId: parsed.data.destination_id,
      title: parsed.data.title,
      description: parsed.data.description,
      language: parsed.data.language,
      radiusMeters: parsed.data.radius_meters,
      xpReward: parsed.data.xp_reward,
      timeLimitMinutes: parsed.data.time_limit_minutes,
      cooldownHours: parsed.data.cooldown_hours,
      hostLines: parsed.data.host_lines,
      theme: parsed.data.theme,
      adminUserId: req.user!.id,
      isTest: parsed.data.is_test,
      questions: parsed.data.questions.map((q) => ({
        ordinal: q.ordinal,
        questionText: q.question_text,
        explanation: q.explanation,
        sourceUrl: q.source_url,
        questionType: q.question_type,
        mediaUrl: q.media_url,
        hint: q.hint,
        round: q.round,
        answerPayload: q.answer_payload,
        options: q.options.map((opt) => ({
          ordinal: opt.ordinal,
          optionText: opt.option_text,
          isCorrect: opt.is_correct,
        })),
      })),
    });

    return res.status(201).json({
      success: true,
      data: result,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err?.message || 'Failed to create quiz draft.' },
    });
  }
});

// GET /api/v1/admin/quizzes/:id - Admin quiz detail (current version + questions with correctness)
router.get('/admin/quizzes/:id', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const detail = await service.getQuizForAdmin(req.params.id);
    if (!detail) {
      return res.status(404).json({
        success: false,
        error: { code: 'QUIZ_NOT_FOUND', message: 'Cultural quiz not found.' },
      });
    }
    return res.status(200).json({ success: true, data: detail });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err?.message || 'Failed to load quiz detail.' },
    });
  }
});

// PATCH /api/v1/admin/quizzes/:id - Replace an unpublished draft (published versions are immutable)
router.patch('/admin/quizzes/:id', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  const parsed = createDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid quiz draft payload.', details: parsed.error.issues },
    });
  }

  try {
    const result = await service.updateQuizDraft(req.params.id, {
      destinationId: parsed.data.destination_id,
      title: parsed.data.title,
      description: parsed.data.description,
      language: parsed.data.language,
      radiusMeters: parsed.data.radius_meters,
      xpReward: parsed.data.xp_reward,
      timeLimitMinutes: parsed.data.time_limit_minutes,
      cooldownHours: parsed.data.cooldown_hours,
      hostLines: parsed.data.host_lines,
      theme: parsed.data.theme,
      adminUserId: req.user!.id,
      isTest: parsed.data.is_test,
      questions: parsed.data.questions.map((q) => ({
        ordinal: q.ordinal,
        questionText: q.question_text,
        explanation: q.explanation,
        sourceUrl: q.source_url,
        questionType: q.question_type,
        mediaUrl: q.media_url,
        hint: q.hint,
        round: q.round,
        answerPayload: q.answer_payload,
        options: q.options.map((opt) => ({
          ordinal: opt.ordinal,
          optionText: opt.option_text,
          isCorrect: opt.is_correct,
        })),
      })),
    });

    return res.status(200).json({ success: true, data: result });
  } catch (err: any) {
    const message: string = err?.message || '';
    if (message.startsWith('QUIZ_NOT_FOUND')) {
      return res.status(404).json({
        success: false,
        error: { code: 'QUIZ_NOT_FOUND', message: 'Cultural quiz not found.' },
      });
    }
    if (message.startsWith('QUIZ_IMMUTABLE')) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'QUIZ_IMMUTABLE',
          message: 'Only draft quizzes can be edited. Published versions are immutable; pause, archive or revoke instead.',
        },
      });
    }
    return res.status(400).json({
      success: false,
      error: { code: 'UPDATE_FAILED', message: message || 'Failed to update quiz draft.' },
    });
  }
});

// POST /api/v1/admin/quizzes/:id/publish - Publish quiz
router.post('/admin/quizzes/:id/publish', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const updated = await service.publishQuiz(req.params.id);
    return res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (err: any) {
    return res.status(400).json({
      success: false,
      error: { code: 'PUBLISH_FAILED', message: err?.message || 'Failed to publish quiz.' },
    });
  }
});

// POST /api/v1/admin/quizzes/:id/pause - Pause quiz
router.post('/admin/quizzes/:id/pause', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const updated = await service.setQuizStatus(req.params.id, 'paused');
    return res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (err: any) {
    return res.status(400).json({
      success: false,
      error: { code: 'UPDATE_FAILED', message: err?.message || 'Failed to pause quiz.' },
    });
  }
});

// POST /api/v1/admin/quizzes/:id/archive - Archive quiz
router.post('/admin/quizzes/:id/archive', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const updated = await service.setQuizStatus(req.params.id, 'archived');
    return res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (err: any) {
    return res.status(400).json({
      success: false,
      error: { code: 'UPDATE_FAILED', message: err?.message || 'Failed to archive quiz.' },
    });
  }
});

// POST /api/v1/admin/quizzes/:id/revoke - Revoke quiz and active attempts
router.post('/admin/quizzes/:id/revoke', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    await service.revokeQuiz(req.params.id, req.body.reason || 'Admin safety revocation');
    return res.status(200).json({
      success: true,
      message: 'Quiz revoked and active attempts invalidated.',
    });
  } catch (err: any) {
    return res.status(400).json({
      success: false,
      error: { code: 'REVOKE_FAILED', message: err?.message || 'Failed to revoke quiz.' },
    });
  }
});

export default router;
