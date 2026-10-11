import { Router, Response } from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { db } from '../db/index.js';
import { env } from '../config/env.js';
import { spotStore } from '../spots/store.js';
import { optionalAuthenticateToken, authenticateToken, checkQAAuthorization, isAuthorizedQA, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.get('/quests', optionalAuthenticateToken, checkQAAuthorization, (req: AuthRequest, res: Response) => {
  const category = req.query.category as string | undefined;
  const allowTest = isAuthorizedQA(req);
  if (allowTest) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }

  // Filter out archived or draft quests for general public
  const quests = db.listQuests(category, allowTest)
    .filter(q => q.status !== 'archived' && (q.status !== 'draft' || isAuthorizedQA(req)))
    .map(({ marker_code, ...quest }) => quest);

  return res.status(200).json({
    success: true,
    data: quests,
  });
});

router.get('/quests/:id', optionalAuthenticateToken, checkQAAuthorization, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const allowTest = isAuthorizedQA(req);
  const quest = db.findQuestById(id, true);

  if (!quest) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Quest with ID '${id}' not found.`,
      },
    });
  }

  // If legacy inactive without progressive lifecycle status, require allowTest
  if (!quest.is_active && !quest.status && !allowTest) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: `Quest with ID '${id}' not found.` },
    });
  }

  if (allowTest && quest.is_test) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }

  const spot = spotStore.spots.find((s) => s.quest_id === quest.id);
  const isAuthor = Boolean(req.user?.id && (quest.author_id === req.user.id || spot?.created_by === req.user.id));
  const isAdminOrQA = Boolean(req.user?.role === 'admin' || req.user?.role === 'qa');

  // Draft quests are private to author, admin, and QA
  if (quest.status === 'draft' && !isAuthor && !isAdminOrQA) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: `Quest with ID '${id}' not found.` },
    });
  }

  // Phase 1 Security Repair: Do not leak marker_code to unauthorized/public viewers.
  const canInspectMarker = allowTest || isAuthor || isAdminOrQA;
  let responseData: any = canInspectMarker ? { ...quest } : (({ marker_code, ...rest }) => rest)(quest);

  // Author & Admin operational metrics (attempt statistics without leaking private traveler GPS/identities)
  if (isAuthor || isAdminOrQA) {
    responseData = {
      ...responseData,
      stats: db.getQuestAttemptStats(quest.id),
    };
  }

  return res.status(200).json({
    success: true,
    data: responseData,
  });
});

// PATCH /quests/:id/status - Author or admin quest lifecycle management
router.patch('/quests/:id/status', authenticateToken, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const quest = db.findQuestById(id, true);

  if (!quest) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: `Quest with ID '${id}' not found.` },
    });
  }

  const spot = spotStore.spots.find((s) => s.quest_id === quest.id);
  const isAuthor = Boolean(req.user?.id && (quest.author_id === req.user.id || spot?.created_by === req.user.id));
  const isAdmin = Boolean(req.user?.role === 'admin');

  if (!isAuthor && !isAdmin) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN_NOT_DESTINATION_AUTHOR',
        message: 'Only the destination author or an administrator can manage quest status.',
      },
    });
  }

  const { status } = req.body;
  const validStatuses = ['draft', 'published', 'paused', 'archived'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_STATUS', message: `Status must be one of: ${validStatuses.join(', ')}` },
    });
  }

  if (quest.status === 'archived' && status !== 'archived') {
    return res.status(400).json({
      success: false,
      error: { code: 'CANNOT_UNARCHIVE', message: 'Archived quests cannot be reopened.' },
    });
  }

  quest.status = status;
  quest.is_active = (status === 'published');
  quest.updated_at = new Date().toISOString();
  db.upsertQuest(quest);

  return res.status(200).json({
    success: true,
    data: quest,
    message: `Quest status successfully updated to '${status}'.`,
  });
});

// POST /quests/:id/attempts - Start or resume progressive quest attempt
router.post('/quests/:id/attempts', authenticateToken, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const quest = db.findQuestById(id, true);

  if (!quest) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: `Quest with ID '${id}' not found.` },
    });
  }

  if (quest.status === 'draft') {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: `Quest with ID '${id}' not found.` },
    });
  }

  if (quest.status === 'paused') {
    return res.status(409).json({
      success: false,
      error: { code: 'QUEST_PAUSED', message: 'This quest is temporarily paused by the author.' },
    });
  }

  if (quest.status === 'archived') {
    return res.status(410).json({
      success: false,
      error: { code: 'QUEST_ARCHIVED', message: 'This quest has been archived.' },
    });
  }

  const userId = req.user!.id;
  if (db.hasApprovedSubmission(userId, id)) {
    return res.status(409).json({
      success: false,
      error: { code: 'ALREADY_COMPLETED', message: 'You have already completed this quest.' },
    });
  }

  const existing = db.getActiveAttempt(userId, id);
  if (existing) {
    return res.status(200).json({
      success: true,
      data: existing,
      message: 'Resumed existing quest attempt.',
    });
  }

  const totalSteps = quest.steps && quest.steps.length > 0 ? quest.steps.length : 1;
  const newAttempt = db.createAttempt({
    id: `attempt_${randomUUID().slice(0, 12)}`,
    quest_id: id,
    user_id: userId,
    version: quest.version ?? 1,
    current_step: 1,
    total_steps: totalSteps,
    status: 'in_progress',
  });

  return res.status(201).json({
    success: true,
    data: newAttempt,
    message: 'Quest attempt started.',
  });
});

// GET /quests/:id/progress - Traveler attempt progress check
router.get('/quests/:id/progress', authenticateToken, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const quest = db.findQuestById(id, true);

  if (!quest) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: `Quest with ID '${id}' not found.` },
    });
  }

  const userId = req.user!.id;
  const hasCompleted = db.hasApprovedSubmission(userId, id);
  const activeAttempt = db.getActiveAttempt(userId, id) ?? null;

  return res.status(200).json({
    success: true,
    data: {
      quest_id: id,
      has_completed: hasCompleted,
      active_attempt: activeAttempt,
    },
  });
});

router.post('/quests/:id/challenge', authenticateToken, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const quest = db.findQuestById(id, true);

  if (!quest) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: `Quest with ID '${id}' not found.` },
    });
  }

  if (quest.status === 'draft') {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: `Quest with ID '${id}' not found.` },
    });
  }

  if (quest.status === 'paused') {
    return res.status(409).json({
      success: false,
      error: { code: 'QUEST_PAUSED', message: 'This quest is temporarily paused by the author.' },
    });
  }

  if (quest.status === 'archived') {
    return res.status(410).json({
      success: false,
      error: { code: 'QUEST_ARCHIVED', message: 'This quest has been archived and is no longer available.' },
    });
  }

  const userId = req.user!.id;
  if (db.hasApprovedSubmission(userId, id)) {
    return res.status(409).json({
      success: false,
      error: { code: 'ALREADY_COMPLETED', message: 'You have already completed this quest.' },
    });
  }

  const nonce = randomUUID();
  const expiresInSec = 600; // 10 minutes
  const token = jwt.sign(
    {
      sub: 'quest_challenge',
      user_id: userId,
      quest_id: id,
      nonce,
    },
    env.JWT_SECRET,
    { expiresIn: expiresInSec }
  );

  return res.status(200).json({
    success: true,
    data: {
      challenge_token: token,
      quest_id: id,
      expires_at: new Date(Date.now() + expiresInSec * 1000).toISOString(),
    },
  });
});

export default router;
