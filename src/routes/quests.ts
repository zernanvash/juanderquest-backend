import { Router, Response, NextFunction } from 'express';
import { randomUUID, createHash, timingSafeEqual } from 'crypto';
import multer from 'multer';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { db, QuestAttemptRow, QuestStepEvidenceRow, QuestStep, withinRadius } from '../db/index.js';
import { getPool } from '../db/pool.js';
import { EconomyError, EconomyService } from '../economy/service.js';
import { isLocalEconomyProfile } from '../economy/profile.js';
import { env } from '../config/env.js';
import { signQuestChallenge, verifyQuestChallengeToken } from '../auth/tokens.js';
import { spotStore } from '../spots/store.js';
import { optionalAuthenticateToken, authenticateToken, checkQAAuthorization, isAuthorizedQA, AuthRequest } from '../middleware/auth.js';
import { claimChallengeNonce, releaseChallengeNonce } from '../services/submissions.js';
import { detectValidatedMediaMime } from '../utils/media-mime.js';
import { validateRequest } from '../middleware/validate.js';
import { optionalAccuracy, optionalLat, optionalLng } from '../middleware/coerce.js';
import { sanitizeAttemptSnapshot, sanitizeQuestForViewer, sanitizeQuestSteps } from '../quests/sanitize.js';
import { hasCompletedQuest } from '../services/quest-completion.js';
import { hasFundingPlan, requireFundingHold, startFundedAttempt } from '../funding/holds.js';
import { FundingError } from '../funding/transaction.js';
import { fundingErrorResponse } from './fundingPlans.js';
import { lockGovernanceSnapshot } from '../governance/transaction.js';

const router = Router();

function secureCodeEquals(expected: unknown, supplied: unknown): boolean {
  if (typeof expected !== 'string' || typeof supplied !== 'string') return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 + 1024 }, // 8 MB limit for photo evidence
});

const stepEvidenceSchema = z.object({
  params: z.object({ id: z.string().min(1), stepOrder: z.string().regex(/^[1-9]\d{0,2}$/) }),
  body: z.object({
    idempotency_key: z.string().min(8).max(100).optional(),
    captured_lat: optionalLat,
    captured_lng: optionalLng,
    captured_accuracy: optionalAccuracy,
    qr_code: z.string().trim().min(1).max(200).optional(),
    scanned_marker_code: z.string().trim().min(1).max(200).optional(),
    challenge_token: z.string().min(1).max(4096).optional(),
    action_name: z.string().max(50).optional(),
    photo_base64: z.string().max(14_000_000).optional(),
    photo_url: z.string().url().max(2048).optional(),
    photo_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    gallery_opt_in: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
  }).passthrough(),
});

const PRIVATE_EVIDENCE_DIR = path.resolve(process.cwd(), 'uploads/private-evidence');
function ensurePrivateEvidenceDir() {
  if (!fs.existsSync(PRIVATE_EVIDENCE_DIR)) {
    fs.mkdirSync(PRIVATE_EVIDENCE_DIR, { recursive: true });
  }
  return PRIVATE_EVIDENCE_DIR;
}

function mapAttempt(row: any): QuestAttemptRow {
  return {
    id: String(row.id),
    quest_id: String(row.quest_id),
    user_id: String(row.user_id),
    version: Number(row.version),
    current_step: Number(row.current_step),
    total_steps: Number(row.total_steps),
    status: row.status,
    steps_snapshot: sanitizeQuestSteps(Array.isArray(row.steps_snapshot) ? row.steps_snapshot : undefined),
    verified_steps: row.verified_steps !== undefined && row.verified_steps !== null ? Number(row.verified_steps) : 0,
    required_steps: row.required_steps !== undefined && row.required_steps !== null ? Number(row.required_steps) : 1,
    review_notes: row.review_notes ?? null,
    reviewed_by: row.reviewed_by ?? null,
    reviewed_at: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

function mapStepEvidence(row: any): QuestStepEvidenceRow {
  return {
    id: String(row.id),
    attempt_id: String(row.attempt_id),
    quest_id: String(row.quest_id),
    user_id: String(row.user_id),
    step_order: Number(row.step_order),
    checkpoint_type: row.checkpoint_type,
    status: row.status,
    required: Boolean(row.required),
    title: String(row.title),
    description: row.description ?? null,
    idempotency_key: row.idempotency_key ?? null,
    evidence_payload: row.evidence_payload ?? null,
    rejection_reason: row.rejection_reason ?? null,
    verified_at: row.verified_at ? new Date(row.verified_at).toISOString() : null,
    reviewed_by: row.reviewed_by ?? null,
    reviewed_at: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

router.get('/quests', optionalAuthenticateToken, checkQAAuthorization, (req: AuthRequest, res: Response) => {
  const category = req.query.category as string | undefined;
  const allowTest = isAuthorizedQA(req);
  if (allowTest) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }

  // Filter out archived or draft quests for general public
  const quests = db.listQuests(category, allowTest)
    .filter(q => q.status !== 'archived' && (q.status !== 'draft' || isAuthorizedQA(req)))
    .map((quest) => sanitizeQuestForViewer(quest, false));

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
  let responseData: any = sanitizeQuestForViewer(quest, canInspectMarker);

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
router.patch('/quests/:id/status', authenticateToken, async (req: AuthRequest, res: Response) => {
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

  const statusPool = getPool();
  try {
    if (statusPool && status === 'published') {
      const required = await statusPool.query('SELECT funding_required FROM quests WHERE id=$1', [id]);
      if (required.rows[0]?.funding_required) return res.status(409).json({ success: false, error: { code: 'FUNDING_PLAN_REQUIRED', message: 'Fund this Eco-Quest before publishing it.' } });
    }
    if (statusPool && await hasFundingPlan(statusPool, id)) {
      return res.status(409).json({ success: false, error: { code: 'FUNDING_PLAN_STATE', message: 'Use the funding round controls to manage this quest.' } });
    }
  } catch (error) { return fundingErrorResponse(res, error); }

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
router.post('/quests/:id/attempts', authenticateToken, async (req: AuthRequest, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const fundingPool = getPool();
  if (fundingPool) {
    try {
      const funded = await startFundedAttempt(fundingPool, id, req.user!.id);
      if (funded) {
        const attempt = mapAttempt(funded.attempt);
        const cached = db.quest_attempts.find(row => row.id === attempt.id);
        if (cached) Object.assign(cached, attempt); else db.quest_attempts.push(attempt);
        return res.status(funded.resumed ? 200 : 201).json({ success: true, data: { ...sanitizeAttemptSnapshot(attempt), funding_hold: funded.funding_hold } });
      }
    } catch (error) {
      if (error instanceof FundingError) return fundingErrorResponse(res, error);
      return next(error);
    }
  }
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
  const pool = getPool();
  if (quest.author_id === userId) {
    return res.status(403).json({
      success: false,
      error: { code: 'CREATOR_SELF_ATTEMPT', message: 'Quest authors cannot earn rewards from their own quest.' },
    });
  }
  if (!pool && await hasCompletedQuest(db, userId, id)) {
    return res.status(409).json({
      success: false,
      error: { code: 'ALREADY_COMPLETED', message: 'You have already completed this quest.' },
    });
  }

  let rewardReservation;
  if (pool && isLocalEconomyProfile()) {
    try {
      rewardReservation = await new EconomyService(pool).reserveForQuestIfActive(id, userId);
    } catch (error) {
      if (error instanceof EconomyError && ['NO_FUNDED_SLOT', 'ALREADY_AWARDED', 'POOL_NOT_ACTIVE'].includes(error.code)) {
        return res.status(409).json({
          success: false,
          error: { code: error.code, message: 'This funded reward is unavailable. Please check the quest terms before starting.' },
        });
      }
      return next(error);
    }
  }

  if (rewardReservation?.attemptId && pool) {
    // Funded starts have already committed the attempt and full reservation in
    // one database transaction. The in-memory mirror is a cache, never a
    // second attempt writer for this path.
    const persisted = await pool.query('SELECT * FROM quest_attempts WHERE id = $1', [rewardReservation.attemptId]);
    const row = persisted.rows[0];
    if (!row || row.user_id !== userId || row.quest_id !== id) return next(new Error('FUNDED_ATTEMPT_UNAVAILABLE'));
    const existingMirror = db.getActiveAttempt(userId, id);
    const attempt = mapAttempt(row);
    if (existingMirror) Object.assign(existingMirror, attempt);
    else db.quest_attempts.push(attempt);
    return res.status(existingMirror ? 200 : 201).json({
      success: true, data: { ...attempt, reward_reservation: rewardReservation },
      message: existingMirror ? 'Resumed existing quest attempt.' : 'Quest attempt started.',
    });
  }

  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize starts for the same traveler, including across API workers.
      const user = await client.query('SELECT id, is_test FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const liveQuest = await client.query(
        'SELECT id, author_id, is_test, status, version, steps FROM quests WHERE id = $1 FOR SHARE', [id]);
      const q = liveQuest.rows[0];
      if (!user.rows[0] || !q) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Quest or traveler not found.' } });
      }
      if (Boolean(user.rows[0].is_test) !== Boolean(q.is_test)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ success: false, error: { code: 'SCOPE_MISMATCH', message: 'Traveler and quest scopes do not match.' } });
      }
      if (q.author_id === userId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ success: false, error: { code: 'CREATOR_SELF_ATTEMPT', message: 'Quest authors cannot earn rewards from their own quest.' } });
      }
      if (q.status !== 'published') {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, error: { code: 'QUEST_NOT_OPEN', message: 'This quest is not open for new attempts.' } });
      }
      if (await hasCompletedQuest(db, userId, id, client)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, error: { code: 'ALREADY_COMPLETED', message: 'You have already completed this quest.' } });
      }
      const active = await client.query(
        "SELECT * FROM quest_attempts WHERE user_id = $1 AND quest_id = $2 AND status IN ('in_progress', 'submitted') ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        [userId, id]);
      if (active.rows[0]) {
        await client.query('COMMIT');
        return res.status(200).json({ success: true, data: mapAttempt(active.rows[0]), message: 'Resumed existing quest attempt.' });
      }
      const steps = Array.isArray(q.steps) && q.steps.length > 0
        ? q.steps
        : [{ step_order: 1, title: 'Destination check-in', description: 'Submit location proof for verification.', checkpoint_type: 'location', required: true }];
      const requiredCount = steps.filter((s: any) => s.required !== false).length;
      const attemptId = `attempt_${randomUUID()}`;

      let inserted;
      try {
        inserted = await client.query(
          `INSERT INTO quest_attempts (id, quest_id, user_id, version, current_step, total_steps, status, steps_snapshot, verified_steps, required_steps)
           VALUES ($1, $2, $3, $4, 1, $5, 'in_progress', $6, 0, $7) RETURNING *`,
          [attemptId, id, userId, q.version, Math.max(1, steps.length), JSON.stringify(steps), Math.max(1, requiredCount)]
        );
      } catch {
        inserted = await client.query(
          `INSERT INTO quest_attempts (id, quest_id, user_id, version, current_step, total_steps, status)
           VALUES ($1, $2, $3, $4, 1, $5, 'in_progress') RETURNING *`,
          [attemptId, id, userId, q.version, Math.max(1, steps.length)]
        );
      }

      try {
        for (const step of steps) {
          await client.query(
            `INSERT INTO quest_step_evidence (id, attempt_id, quest_id, user_id, step_order, checkpoint_type, status, required, title, description)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (attempt_id, step_order) DO NOTHING`,
            [
              `step_ev_${randomUUID()}`,
              attemptId,
              id,
              userId,
              step.step_order,
              step.checkpoint_type,
              step.step_order === 1 ? 'ready' : 'not_started',
              step.required !== false,
              step.title,
              step.description || null,
            ]
          );
        }
      } catch {}

      await client.query('COMMIT');
      const attempt = mapAttempt(inserted.rows[0]);
      db.quest_attempts.push(attempt);
      return res.status(201).json({ success: true, data: attempt, message: 'Quest attempt started.' });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return next(error);
    } finally {
      client.release();
    }
  }

  const existing = db.getActiveAttempt(userId, id);
  if (existing) {
    return res.status(200).json({
      success: true,
      data: rewardReservation ? { ...sanitizeAttemptSnapshot(existing), reward_reservation: rewardReservation } : sanitizeAttemptSnapshot(existing),
      message: 'Resumed existing quest attempt.',
    });
  }

  const stepsSnapshot = Array.isArray(quest.steps) && quest.steps.length > 0 ? quest.steps : [];
  const totalSteps = stepsSnapshot.length > 0 ? stepsSnapshot.length : 1;
  const newAttempt = db.createAttempt({
    id: `attempt_${randomUUID().slice(0, 12)}`,
    quest_id: id,
    user_id: userId,
    version: quest.version ?? 1,
    current_step: 1,
    total_steps: totalSteps,
    status: 'in_progress',
    steps_snapshot: stepsSnapshot,
  });

  return res.status(201).json({
    success: true,
    data: rewardReservation ? { ...sanitizeAttemptSnapshot(newAttempt), reward_reservation: rewardReservation } : sanitizeAttemptSnapshot(newAttempt),
    message: 'Quest attempt started.',
  });
});

// GET /quests/:id/progress - Traveler attempt progress check
router.get('/quests/:id/progress', authenticateToken, async (req: AuthRequest, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const quest = db.findQuestById(id, true);

  if (!quest) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: `Quest with ID '${id}' not found.` },
    });
  }

  const userId = req.user!.id;
  const pool = getPool();
  if (pool) {
    try {
      const [completed, active] = await Promise.all([
        hasCompletedQuest(db, userId, id, pool),
        pool.query("SELECT * FROM quest_attempts WHERE user_id = $1 AND quest_id = $2 ORDER BY created_at DESC LIMIT 1", [userId, id]),
      ]);
      let activeAttempt: any = null;
      if (active.rows[0] && ['in_progress', 'submitted'].includes(active.rows[0].status)) {
        activeAttempt = mapAttempt(active.rows[0]);
        try {
          const stepRows = await pool.query(
            "SELECT * FROM quest_step_evidence WHERE attempt_id = $1 ORDER BY step_order ASC",
            [activeAttempt.id]
          );
          activeAttempt.steps = stepRows.rows.map(mapStepEvidence);
        } catch {
          activeAttempt.steps = db.getStepEvidence(activeAttempt.id);
        }
      }
      return res.status(200).json({ success: true, data: {
        quest_id: id,
        has_completed: completed,
        active_attempt: activeAttempt ? sanitizeAttemptSnapshot(activeAttempt) : null,
      } });
    } catch (error) { return next(error); }
  }
  const hasCompleted = await hasCompletedQuest(db, userId, id);
  const rawAttempt = db.getActiveAttempt(userId, id) ?? null;
  let activeAttempt: any = null;
  if (rawAttempt) {
    activeAttempt = { ...rawAttempt };
    activeAttempt.steps = db.getStepEvidence(rawAttempt.id);
  }

  return res.status(200).json({
    success: true,
    data: {
      quest_id: id,
      has_completed: hasCompleted,
      active_attempt: activeAttempt ? sanitizeAttemptSnapshot(activeAttempt) : null,
    },
  });
});

// POST /quests/:id/steps/:stepOrder/evidence - Submit proof for a specific quest step
router.post(
  '/quests/:id/steps/:stepOrder/evidence',
  authenticateToken,
  (req: AuthRequest, res: Response, next: NextFunction) => {
    evidenceUpload.single('photo')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            success: false,
            error: { code: 'FILE_TOO_LARGE', message: 'Photo evidence exceeds maximum limit of 8 MB.' },
          });
        }
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: err.message || 'Evidence upload failed.' },
        });
      }
      next();
    });
  },
  validateRequest(stepEvidenceSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const validated = res.locals.validatedRequest as {
      params: { id: string; stepOrder: string };
      body: Record<string, any>;
    };
    const body = validated.body;
    const { id } = validated.params;
    const stepOrder = Number(validated.params.stepOrder);

    const quest = db.findQuestById(id, true);
    if (!quest) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Quest with ID '${id}' not found.` },
      });
    }

    const userId = req.user!.id;
    const pool = getPool();

    // 1. Fetch active attempt
    let activeAttempt: QuestAttemptRow | null = null;
    let stepEvidence: QuestStepEvidenceRow | null = null;

    if (pool) {
      try {
        const attemptRes = await pool.query(
          "SELECT * FROM quest_attempts WHERE user_id = $1 AND quest_id = $2 AND status = 'in_progress' ORDER BY created_at DESC LIMIT 1",
          [userId, id]
        );
        if (attemptRes.rows[0]) {
          activeAttempt = mapAttempt(attemptRes.rows[0]);
          const stepRes = await pool.query(
            "SELECT * FROM quest_step_evidence WHERE attempt_id = $1 AND step_order = $2",
            [activeAttempt.id, stepOrder]
          );
          if (stepRes.rows[0]) {
            stepEvidence = mapStepEvidence(stepRes.rows[0]);
          }
        }
      } catch (err) {
        return next(err);
      }
    }

    if (!activeAttempt) {
      const memAttempt = db.getActiveAttempt(userId, id);
      if (memAttempt) {
        activeAttempt = memAttempt;
        stepEvidence = db.findStepEvidence(memAttempt.id, stepOrder) ?? null;
      }
    }

    if (!activeAttempt) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_ACTIVE_ATTEMPT', message: 'You have not started an active attempt for this quest.' },
      });
    }

    if (!stepEvidence) {
      return res.status(404).json({
        success: false,
        error: { code: 'STEP_NOT_FOUND', message: `Step ${stepOrder} not found for this attempt.` },
      });
    }

    // 2. Check current step status & idempotency
    const idempotencyKey = body.idempotency_key;
    if (stepEvidence.status === 'verified') {
      if (idempotencyKey && stepEvidence.idempotency_key === idempotencyKey) {
        return res.status(200).json({
          success: true,
          data: { step: stepEvidence, attempt: sanitizeAttemptSnapshot(activeAttempt) },
          message: 'Step already verified.',
        });
      }
      return res.status(409).json({
        success: false,
        error: { code: 'STEP_ALREADY_VERIFIED', message: `Step ${stepOrder} has already been verified.` },
      });
    }

    if (stepEvidence.status === 'pending_review') {
      if (idempotencyKey && stepEvidence.idempotency_key === idempotencyKey) {
        return res.status(200).json({
          success: true,
          data: { step: stepEvidence, attempt: sanitizeAttemptSnapshot(activeAttempt) },
          message: 'Step proof already submitted for review.',
        });
      }
      return res.status(409).json({
        success: false,
        error: { code: 'STEP_PENDING_REVIEW', message: `Step ${stepOrder} is currently pending independent review.` },
      });
    }

    if (stepEvidence.status === 'not_started') {
      return res.status(400).json({
        success: false,
        error: { code: 'STEP_NOT_READY', message: `Step ${stepOrder} is locked. Complete previous steps first.` },
      });
    }

    // 3. Extract and validate evidence based on checkpoint type
    const checkpointType = stepEvidence.checkpoint_type;
    const capturedLat = body.captured_lat;
    const capturedLng = body.captured_lng;
    const capturedAccuracy = body.captured_accuracy;

    let targetLat = quest.gps_lat;
    let targetLng = quest.gps_lng;
    let allowedRadius = quest.radius_meters || 150;

    const questStepDef = quest.steps?.find((s) => s.step_order === stepOrder);
    if (questStepDef?.gps_lat !== undefined && questStepDef?.gps_lng !== undefined) {
      targetLat = questStepDef.gps_lat;
      targetLng = questStepDef.gps_lng;
    }
    if (questStepDef?.radius_meters) {
      allowedRadius = questStepDef.radius_meters;
    }

    let newStatus: any = 'verified';
    let evidencePayload: Record<string, any> = {};
    let claimedChallengeNonce: string | undefined;

    if (checkpointType === 'location') {
      if (capturedLat === undefined || capturedLng === undefined) {
        return res.status(400).json({
          success: false,
          error: { code: 'MISSING_GPS_COORDINATES', message: 'Location step requires captured_lat and captured_lng.' },
        });
      }

      const distance = withinRadius(capturedLat, capturedLng, targetLat, targetLng, allowedRadius, capturedAccuracy || 0);
      if (!distance.ok) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'GPS_RADIUS_EXCEEDED',
            message: Number.isFinite(distance.distance)
              ? `You are ${Math.round(distance.distance)}m away from this checkpoint. Must be within ${allowedRadius}m.`
              : 'The captured GPS coordinates are invalid.',
          },
        });
      }

      evidencePayload = {
        gps: {
          lat: capturedLat,
          lng: capturedLng,
          accuracy: capturedAccuracy ?? 5,
          distance_meters: Math.round(distance.distance),
        },
        verified_at: new Date().toISOString(),
      };
      newStatus = 'verified';
    } else if (checkpointType === 'qr') {
      if (capturedLat === undefined || capturedLng === undefined) {
        return res.status(400).json({
          success: false,
          error: { code: 'MISSING_GPS_COORDINATES', message: 'QR verification requires a fresh GPS reading.' },
        });
      }

      const distance = withinRadius(capturedLat, capturedLng, targetLat, targetLng, allowedRadius, capturedAccuracy || 0);
      if (!distance.ok) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'GPS_RADIUS_EXCEEDED',
            message: Number.isFinite(distance.distance)
              ? `Fresh GPS reading (${Math.round(distance.distance)}m) exceeds allowed radius of ${allowedRadius}m.`
              : 'The captured GPS coordinates are invalid.',
          },
        });
      }

      const qrCode = body.qr_code || body.scanned_marker_code;
      const challengeToken = body.challenge_token;

      let qrValid = false;
      let qrDetails: any = {};

      if (qrCode) {
        const matchesQuest = secureCodeEquals(quest.marker_code, qrCode);
        const matchesStep = questStepDef && secureCodeEquals(questStepDef.marker_code, qrCode);
        if (matchesQuest || matchesStep) {
          qrValid = true;
          qrDetails = { scanned_qr: qrCode };
        }
      }

      if (!qrValid && challengeToken) {
        try {
          const decoded = verifyQuestChallengeToken(challengeToken);
          if (decoded && decoded.quest_id === quest.id && decoded.user_id === userId) {
            const claimed = claimChallengeNonce(decoded.nonce);
            if (claimed) {
              claimedChallengeNonce = decoded.nonce;
              qrValid = true;
              qrDetails = { challenge_nonce: decoded.nonce };
            }
          }
        } catch {}
      }

      if (!qrValid) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_QR_CODE', message: 'The scanned QR code is invalid for this checkpoint.' },
        });
      }

      evidencePayload = {
        ...qrDetails,
        gps: {
          lat: capturedLat,
          lng: capturedLng,
          accuracy: capturedAccuracy ?? 5,
        },
        verified_at: new Date().toISOString(),
      };
      newStatus = 'verified';
    } else if (checkpointType === 'photo') {
      let fileBuffer: Buffer | null = null;
      let fileExt = 'jpg';

      if (req.file?.buffer) {
        fileBuffer = req.file.buffer;
        const detected = detectValidatedMediaMime(fileBuffer);
        if (detected && detected.mediaType === 'image') {
          fileExt = detected.ext;
        }
      } else if (body.photo_base64) {
        try {
          fileBuffer = Buffer.from(body.photo_base64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
          const detected = detectValidatedMediaMime(fileBuffer);
          if (detected && detected.mediaType === 'image') {
            fileExt = detected.ext;
          }
        } catch {}
      }

      let sha256Hash = body.photo_sha256;
      let storedFilename = '';

      if (fileBuffer) {
        sha256Hash = createHash('sha256').update(fileBuffer).digest('hex');
        const dir = ensurePrivateEvidenceDir();
        storedFilename = `evidence_${stepEvidence.id}_${randomUUID().slice(0, 8)}.${fileExt}`;
        fs.writeFileSync(path.resolve(dir, storedFilename), fileBuffer);
      }

      if (!fileBuffer && !body.photo_url && !body.photo_sha256) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'No photo evidence provided.' },
        });
      }

      const galleryOptIn = body.gallery_opt_in === true || body.gallery_opt_in === 'true';

      evidencePayload = {
        sha256: sha256Hash || 'sha256_mock',
        file_path: storedFilename || null,
        photo_url: body.photo_url || (storedFilename ? `/api/v1/quests/evidence/${stepEvidence.id}/file` : null),
        gallery_opt_in: galleryOptIn,
        gps: capturedLat !== undefined ? { lat: capturedLat, lng: capturedLng, accuracy: capturedAccuracy } : null,
        submitted_at: new Date().toISOString(),
      };
      newStatus = 'pending_review';
    } else if (checkpointType === 'action') {
      const allowedActions = ['like_destination', 'quiz_completed', 'view_story'];
      const actionName = body.action_name;
      if (!actionName || !allowedActions.includes(actionName)) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_ACTION', message: `Action must be one of: ${allowedActions.join(', ')}` },
        });
      }

      evidencePayload = {
        action_name: actionName,
        verified_at: new Date().toISOString(),
      };
      newStatus = 'verified';
    }

    // 4. Update step evidence and attempt state
    stepEvidence.status = newStatus;
    stepEvidence.evidence_payload = evidencePayload;
    stepEvidence.idempotency_key = idempotencyKey || null;
    stepEvidence.verified_at = newStatus === 'verified' ? new Date().toISOString() : null;
    stepEvidence.updated_at = new Date().toISOString();

    const nextStepOrder = stepOrder + 1;

    if (pool) {
      try {
        await pool.query(
          `UPDATE quest_step_evidence
           SET status = $1, evidence_payload = $2, idempotency_key = $3, verified_at = $4, updated_at = NOW()
           WHERE id = $5`,
          [stepEvidence.status, JSON.stringify(evidencePayload), stepEvidence.idempotency_key, stepEvidence.verified_at, stepEvidence.id]
        );

        // Unlock next step if not_started
        await pool.query(
          `UPDATE quest_step_evidence
           SET status = 'ready', updated_at = NOW()
           WHERE attempt_id = $1 AND step_order = $2 AND status = 'not_started'`,
          [activeAttempt.id, nextStepOrder]
        );

        // Recompute verified steps on attempt
        const countRes = await pool.query(
          "SELECT COUNT(*) FROM quest_step_evidence WHERE attempt_id = $1 AND status = 'verified'",
          [activeAttempt.id]
        );
        const verifiedCount = parseInt(countRes.rows[0].count, 10);
        await pool.query(
          `UPDATE quest_attempts
           SET verified_steps = $1, current_step = GREATEST(current_step, $2), updated_at = NOW()
           WHERE id = $3`,
          [verifiedCount, nextStepOrder, activeAttempt.id]
        );
        activeAttempt.verified_steps = verifiedCount;
        activeAttempt.current_step = Math.max(activeAttempt.current_step, nextStepOrder);
      } catch (err) {
        if (claimedChallengeNonce) releaseChallengeNonce(claimedChallengeNonce);
        return next(err);
      }
    }

    // Mirror in memory
    db.saveStepEvidence(stepEvidence);
    const nextStepMem = db.findStepEvidence(activeAttempt.id, nextStepOrder);
    if (nextStepMem && nextStepMem.status === 'not_started') {
      nextStepMem.status = 'ready';
      nextStepMem.updated_at = new Date().toISOString();
      db.saveStepEvidence(nextStepMem);
    }
    const memSteps = db.getStepEvidence(activeAttempt.id);
    activeAttempt.verified_steps = memSteps.filter((s) => s.status === 'verified').length;
    activeAttempt.current_step = Math.max(activeAttempt.current_step, nextStepOrder);
    claimedChallengeNonce = undefined;

    return res.status(200).json({
      success: true,
      data: {
        step: stepEvidence,
        attempt: sanitizeAttemptSnapshot(activeAttempt),
      },
      message: newStatus === 'verified' ? 'Step verified successfully.' : 'Step proof submitted for independent review.',
    });
  }
);

// POST /quests/:id/submit-for-review - Submit quest for final independent review
router.post('/quests/:id/submit-for-review', authenticateToken, async (req: AuthRequest, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const userId = req.user!.id;
  const pool = getPool();

  let activeAttempt: QuestAttemptRow | null = null;
  let steps: QuestStepEvidenceRow[] = [];

  if (pool) {
    try {
      const attemptRes = await pool.query(
        "SELECT * FROM quest_attempts WHERE user_id = $1 AND quest_id = $2 AND status = 'in_progress' ORDER BY created_at DESC LIMIT 1",
        [userId, id]
      );
      if (attemptRes.rows[0]) {
        activeAttempt = mapAttempt(attemptRes.rows[0]);
        const stepsRes = await pool.query(
          "SELECT * FROM quest_step_evidence WHERE attempt_id = $1 ORDER BY step_order ASC",
          [activeAttempt.id]
        );
        steps = stepsRes.rows.map(mapStepEvidence);
      }
    } catch (err) {
      return next(err);
    }
  }

  if (!activeAttempt) {
    const memAttempt = db.getActiveAttempt(userId, id);
    if (memAttempt) {
      activeAttempt = memAttempt;
      steps = db.getStepEvidence(memAttempt.id);
    }
  }

  if (!activeAttempt) {
    return res.status(400).json({
      success: false,
      error: { code: 'NO_ACTIVE_ATTEMPT', message: 'You have no active in-progress attempt for this quest.' },
    });
  }

  // Check that all required steps are satisfied (either verified or pending_review)
  const unverifiedRequired = steps.filter((s) => s.required && !['verified', 'pending_review'].includes(s.status));
  if (unverifiedRequired.length > 0) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'UNSATISFIED_STEPS',
        message: `Step ${unverifiedRequired[0].step_order} (${unverifiedRequired[0].title}) must be completed or submitted before final review.`,
      },
    });
  }

  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockGovernanceSnapshot(client);
      await requireFundingHold(client, userId, id);
      await client.query(
        "UPDATE quest_attempts SET status = 'submitted', updated_at = NOW() WHERE id = $1",
        [activeAttempt.id]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (err instanceof FundingError) return fundingErrorResponse(res, err);
      return next(err);
    } finally { client.release(); }
  }
  activeAttempt.status = 'submitted';
  activeAttempt.updated_at = new Date().toISOString();

  return res.status(200).json({
    success: true,
    data: sanitizeAttemptSnapshot(activeAttempt),
    message: 'Quest attempt submitted for independent review. Rewards will be granted upon review approval.',
  });
});

// GET /quests/evidence/:evidenceId/file - Private evidence secure access
router.get('/quests/evidence/:evidenceId/file', authenticateToken, async (req: AuthRequest, res: Response, next: NextFunction) => {
  const { evidenceId } = req.params;
  const userId = req.user!.id;
  const isAdmin = req.user!.role === 'admin';
  const pool = getPool();

  let evidence: QuestStepEvidenceRow | null = null;
  if (pool) {
    try {
      const res = await pool.query('SELECT * FROM quest_step_evidence WHERE id = $1', [evidenceId]);
      if (res.rows[0]) evidence = mapStepEvidence(res.rows[0]);
    } catch (err) {
      return next(err);
    }
  }

  if (!evidence) {
    evidence = db.quest_step_evidence.find((e) => e.id === evidenceId) ?? null;
  }

  if (!evidence) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Evidence record not found.' },
    });
  }

  // Enforce access control: only author of evidence or admin can view
  if (evidence.user_id !== userId && !isAdmin) {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'You are not authorized to view this private evidence.' },
    });
  }

  const filePath = evidence.evidence_payload?.file_path;
  if (!filePath) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'No file attached to this evidence.' },
    });
  }

  const fullPath = path.resolve(PRIVATE_EVIDENCE_DIR, filePath);
  if (!fs.existsSync(fullPath) || !fullPath.startsWith(PRIVATE_EVIDENCE_DIR)) {
    return res.status(404).json({
      success: false,
      error: { code: 'FILE_NOT_FOUND', message: 'Evidence file not found on disk.' },
    });
  }

  return res.sendFile(fullPath);
});

router.post('/quests/:id/challenge', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const fundingPool = getPool();
  if (fundingPool) {
    try { await requireFundingHold(fundingPool, req.user!.id, id); }
    catch (error) { return fundingErrorResponse(res, error); }
  }
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
  if (await hasCompletedQuest(db, userId, id, getPool())) {
    return res.status(409).json({
      success: false,
      error: { code: 'ALREADY_COMPLETED', message: 'You have already completed this quest.' },
    });
  }

  const nonce = randomUUID();
  const expiresInSec = 600; // 10 minutes
  const token = signQuestChallenge({ user_id: userId, quest_id: id, nonce }, expiresInSec);

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
