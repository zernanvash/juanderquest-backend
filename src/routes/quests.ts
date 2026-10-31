import { Router, Response, NextFunction } from 'express';
import { randomUUID, createHash, timingSafeEqual } from 'crypto';
import multer from 'multer';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { db, QuestAttemptRow, QuestRow, QuestStepEvidenceRow, QuestStep, withinRadius } from '../db/index.js';
import { getPool } from '../db/pool.js';
import { EconomyError, EconomyService } from '../economy/service.js';
import { isLocalEconomyProfile } from '../economy/profile.js';
import { env } from '../config/env.js';
import { signQuestChallenge, verifyQuestChallengeToken, signQuestArChallenge, verifyQuestArChallengeToken, signQuestQrPass, verifyQuestQrPassToken, AR_CHALLENGE_TYP } from '../auth/tokens.js';
import { spotStore } from '../spots/store.js';
import { optionalAuthenticateToken, authenticateToken, checkQAAuthorization, isAuthorizedQA, AuthRequest } from '../middleware/auth.js';
import { claimChallengeNonce, releaseChallengeNonce } from '../services/submissions.js';
import { detectValidatedMediaMime } from '../utils/media-mime.js';
import { validateRequest } from '../middleware/validate.js';
import { optionalAccuracy, optionalLat, optionalLng } from '../middleware/coerce.js';
import { sanitizeAttemptSnapshot, sanitizeQuestForViewer, sanitizeQuestSteps } from '../quests/sanitize.js';
import { normalizeTasks, publicTask, publicTasks } from '../quests/taskNormalize.js';
import type { QuestTask } from '../quests/taskTypes.js';
import { questTaskInputSchema, validateTasksWithinDistance } from '../quests/taskValidation.js';
import { hasCompletedQuest } from '../services/quest-completion.js';
import { hasFundingPlan, requireFundingHold, startFundedAttempt } from '../funding/holds.js';
import { FundingError, publishFunding } from '../funding/transaction.js';
import { fundingErrorResponse } from './fundingPlans.js';
import { lockGovernanceSnapshot, commitGovernanceTransaction } from '../governance/transaction.js';
import { publicFundingSummaries } from '../funding/readModel.js';
import { handleQuestStepVerified } from '../stamps/hooks.js';
import { settleReward } from '../funding/rewardSettlement.js';
import { progressionService } from '../progression/service.js';
import { governanceStore } from './proposals.js';

const router = Router();

/** A QR task's scan mode: the traveler scans a printed code, or a host scans the traveler's pass. */
const qrScanModeOf = (task: QuestTask | undefined) =>
  ((task?.verification as any)?.scan_mode || task?.qr_scan_mode || 'traveler_scans') as 'traveler_scans' | 'host_scans_traveler';

function secureCodeEquals(expected: unknown, supplied: unknown): boolean {
  if (typeof expected !== 'string' || typeof supplied !== 'string') return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

async function isDurableAdminOrQA(userId?: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const durableUser = db.usersRepo.getPool() ? await db.usersRepo.findById(userId) : db.findUserById(userId);
    return Boolean(durableUser?.role === 'admin' || durableUser?.role === 'qa');
  } catch {
    return false;
  }
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
    step_order_mode: row.step_order_mode === 'any' ? 'any' : 'sequential',
    steps_snapshot: Array.isArray(row.steps_snapshot) ? row.steps_snapshot : undefined,
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
    task_key: row.task_key ?? null,
    checkpoint_type: row.checkpoint_type,
    status: row.status,
    required: Boolean(row.required),
    title: String(row.title),
    description: row.description ?? null,
    idempotency_key: row.idempotency_key ?? null,
    evidence_payload: row.evidence_payload ?? null,
    rejection_reason: row.rejection_reason ?? null,
    needs_changes_reason: row.needs_changes_reason ?? null,
    failed_tries: row.failed_tries !== undefined && row.failed_tries !== null ? Number(row.failed_tries) : 0,
    first_try_at: row.first_try_at ? new Date(row.first_try_at).toISOString() : null,
    submitted_at: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
    verified_at: row.verified_at ? new Date(row.verified_at).toISOString() : null,
    reviewed_by: row.reviewed_by ?? null,
    reviewed_at: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

router.get('/quests', optionalAuthenticateToken, checkQAAuthorization, async (req: AuthRequest, res: Response) => {
  const category = req.query.category as string | undefined;
  const allowTest = isAuthorizedQA(req);
  if (allowTest) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }

  // Filter out archived or draft quests for general public
  const quests = db.listQuests(category, allowTest)
    .filter(q => q.status !== 'archived' && (q.status !== 'draft' || isAuthorizedQA(req)))
    .map((quest) => sanitizeQuestForViewer(quest, false));
  if (env.QUEST_FUNDING_ENABLED) {
    const pool=getPool();
    if(pool) {
      try {
        const summaries=await publicFundingSummaries(pool,quests.map(q=>q.id),allowTest);
        for(const quest of quests) if(summaries.has(quest.id)) (quest as any).funding=summaries.get(quest.id);
      } catch(error) { console.error('[funding] public quest summary unavailable:',error); }
    }
  }

  return res.status(200).json({
    success: true,
    data: quests,
  });
});

router.get('/quests/:id', optionalAuthenticateToken, checkQAAuthorization, async (req: AuthRequest, res: Response) => {
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
  const isAdminOrQA = await isDurableAdminOrQA(req.user?.id);

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
  if(env.QUEST_FUNDING_ENABLED) {
    const pool=getPool();
    if(pool) {
      try { responseData.funding=(await publicFundingSummaries(pool,[quest.id],Boolean(quest.is_test))).get(quest.id)??null; }
      catch(error) { console.error('[funding] quest detail summary unavailable:',error); }
    }
  }

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

// GET /quests/:id/edit - Author or admin: full definition incl. marker_code (Plan 43 §4.1)
router.get('/quests/:id/edit', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const quest = db.findQuestById(id, true);

  if (!quest) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Quest '${id}' not found.` } });
  }

  const spot = spotStore.spots.find((s) => s.quest_id === quest.id);
  const isAuthor = Boolean(req.user?.id && (quest.author_id === req.user.id || spot?.created_by === req.user.id));
  const isAdminOrQA = await isDurableAdminOrQA(req.user?.id);

  if (!isAuthor && !isAdminOrQA) {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Only the author or an admin can access the quest editor.' },
    });
  }

  // Author gets full definition with secret marker_code for printing QR sheet
  const normalizedTasks = normalizeTasks(quest.steps, spot, { allowClientMarkerCode: true });

  return res.status(200).json({
    success: true,
    data: {
      ...quest,
      steps: normalizedTasks,
      tasks: normalizedTasks,
      step_order_mode: quest.step_order_mode ?? 'sequential',
    },
  });
});

// PATCH /quests/:id - Author edit quest (Plan 43 §4.1)
const patchQuestSchema = z.object({
  body: z.object({
    expected_version: z.number().int().positive().optional(),
    title: z.string().trim().min(5).max(100).optional(),
    description: z.string().trim().min(15).max(1000).optional(),
    category: z.enum(['eco', 'cultural', 'food_trade']).optional(),
    radius_meters: z.number().int().min(50).max(500).optional(),
    reward_points: z.union([z.literal(50), z.literal(75), z.literal(100)]).optional(),
    step_order_mode: z.enum(['sequential', 'any']).optional(),
    status: z.enum(['draft', 'published', 'paused', 'archived']).optional(),
    tasks: z.array(questTaskInputSchema).max(10).optional(),
    steps: z.array(z.any()).max(10).optional(),
  }),
});

router.patch('/quests/:id', authenticateToken, validateRequest(patchQuestSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const quest = db.findQuestById(id, true);

  if (!quest) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Quest '${id}' not found.` } });
  }

  const spot = spotStore.spots.find((s) => s.quest_id === quest.id);
  const isAuthor = Boolean(req.user?.id && (quest.author_id === req.user.id || spot?.created_by === req.user.id));
  const isAdmin = Boolean(req.user?.role === 'admin');

  if (!isAuthor && !isAdmin) {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Only the author or an admin can edit this quest.' },
    });
  }

  const { expected_version, title, description, category, radius_meters, reward_points, step_order_mode, status, tasks, steps } = req.body;

  // Optimistic locking check (Plan 43 §4.1)
  const currentVersion = quest.version ?? 1;
  if (expected_version !== undefined && expected_version !== currentVersion) {
    return res.status(409).json({
      success: false,
      error: {
        code: 'VERSION_CONFLICT',
        message: `Version conflict: this quest is at version ${currentVersion}, but expected version was ${expected_version}.`,
      },
    });
  }

  const nextStatus = status ?? quest.status ?? 'published';
  const rawTasks = tasks || steps;

  let normalizedTasks: QuestTask[] = quest.steps as QuestTask[];
  if (rawTasks !== undefined) {
    if (nextStatus === 'published' && rawTasks.length === 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Published quests must have between 1 and 10 tasks.' },
      });
    }

    // Fence distance check (Plan 43 §4.6)
    const destinationLat = spot?.gps_lat ?? quest.gps_lat;
    const destinationLng = spot?.gps_lng ?? quest.gps_lng;
    const maxDistanceKm = Number(process.env.QUEST_TASK_MAX_DISTANCE_KM || 5);
    const distanceCheck = validateTasksWithinDistance(rawTasks, destinationLat, destinationLng, maxDistanceKm);
    if (!distanceCheck.valid) {
      return res.status(422).json({
        success: false,
        error: { code: 'TASK_TOO_FAR', message: distanceCheck.error },
      });
    }

    // Existing tasks to preserve keys & marker codes (Plan 43 §4.1)
    const existingTasks = normalizeTasks(quest.steps, spot, { allowClientMarkerCode: true });
    normalizedTasks = normalizeTasks(rawTasks, spot, {
      preserveSecretsFrom: existingTasks,
      allowClientMarkerCode: false,
    });

    if (nextStatus === 'published') {
      const hasRequired = normalizedTasks.some((t) => t.required);
      if (!hasRequired) {
        return res.status(400).json({
          success: false,
          error: { code: 'NO_REQUIRED_TASKS', message: 'Published quests must have at least one required task.' },
        });
      }
    }
  }

  // Version bump: draft updates in place; published increments version (Plan 43 §4.1)
  const newVersion = quest.status === 'draft' ? currentVersion : currentVersion + 1;
  const nowIso = new Date().toISOString();

  if (title !== undefined) quest.title = title;
  if (description !== undefined) quest.description = description;
  if (category !== undefined) quest.category = category;
  if (radius_meters !== undefined) quest.radius_meters = radius_meters;
  if (reward_points !== undefined) quest.reward_points = reward_points;
  if (step_order_mode !== undefined) quest.step_order_mode = step_order_mode;
  if (status !== undefined) {
    quest.status = status;
    quest.is_active = (status === 'published');
  }
  if (rawTasks !== undefined) {
    quest.steps = normalizedTasks;
  }
  quest.version = newVersion;
  quest.updated_at = nowIso;

  const pool = getPool();
  if (pool) {
    try {
      await pool.query(
        `UPDATE quests
         SET title = $1, description = $2, category = $3, radius_meters = $4,
             reward_points = $5, step_order_mode = $6, status = $7, is_active = $8,
             steps = $9, version = $10, updated_at = NOW()
         WHERE id = $11`,
        [
          quest.title,
          quest.description,
          quest.category,
          quest.radius_meters,
          quest.reward_points,
          quest.step_order_mode ?? 'sequential',
          quest.status,
          quest.is_active,
          JSON.stringify(quest.steps),
          quest.version,
          quest.id,
        ]
      );
    } catch (err) {
      return next(err);
    }
  }

  db.upsertQuest(quest);

  return res.status(200).json({
    success: true,
    data: {
      ...quest,
      tasks: quest.steps,
    },
    message: 'Quest updated successfully.',
  });
});

// GET /quests/:id/qr-sheet - Author/admin: list of QR tasks with print codes (Plan 43 §4.1)
router.get('/quests/:id/qr-sheet', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const quest = db.findQuestById(id, true);

  if (!quest) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Quest '${id}' not found.` } });
  }

  const spot = spotStore.spots.find((s) => s.quest_id === quest.id);
  const isAuthor = Boolean(req.user?.id && (quest.author_id === req.user.id || spot?.created_by === req.user.id));
  const isAdminOrQA = await isDurableAdminOrQA(req.user?.id);

  if (!isAuthor && !isAdminOrQA) {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Only the quest author or an administrator can access the QR print sheet.' },
    });
  }

  const tasks = normalizeTasks(quest.steps, spot, { allowClientMarkerCode: true });
  const qrTasks = tasks.filter((t) => t.checkpoint_type === 'qr');

  const sheet = qrTasks.map((t) => {
    const marker = (t.verification as any)?.marker_code || t.marker_code;
    const scanMode = (t.verification as any)?.scan_mode || t.qr_scan_mode || 'traveler_scans';
    return {
      task_key: t.key,
      step_order: t.step_order,
      title: t.title,
      marker_code: marker,
      qr_payload: marker,
      scan_mode: scanMode,
      fence: (t.verification as any)?.fence || { lat: t.gps_lat, lng: t.gps_lng, radius_meters: t.radius_meters },
    };
  });

  return res.status(200).json({
    success: true,
    data: {
      quest_id: quest.id,
      quest_title: quest.title,
      location_name: quest.location_name,
      qr_tasks: sheet,
    },
  });
});

// GET /quests/:id/analytics - Author/admin: aggregated funnel analytics per task (Plan 43 §4.1, §8)
router.get('/quests/:id/analytics', authenticateToken, async (req: AuthRequest, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const quest = db.findQuestById(id, true);

  if (!quest) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Quest '${id}' not found.` } });
  }

  const spot = spotStore.spots.find((s) => s.quest_id === quest.id);
  const isAuthor = Boolean(req.user?.id && (quest.author_id === req.user.id || spot?.created_by === req.user.id));
  const isAdminOrQA = await isDurableAdminOrQA(req.user?.id);

  if (!isAuthor && !isAdminOrQA) {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Only the author or an administrator can view quest analytics.' },
    });
  }

  const tasks = normalizeTasks(quest.steps, spot, { allowClientMarkerCode: true });
  const pool = getPool();

  if (pool) {
    try {
      const attemptsCountRes = await pool.query(
        "SELECT COUNT(*) AS started, COUNT(*) FILTER (WHERE status = 'completed') AS completed FROM quest_attempts WHERE quest_id = $1",
        [id]
      );
      const overallStarted = parseInt(attemptsCountRes.rows[0]?.started || '0', 10);
      const overallCompleted = parseInt(attemptsCountRes.rows[0]?.completed || '0', 10);

      // Aggregations per step_order
      const stepAggsRes = await pool.query(
        `SELECT
           e.step_order,
           e.task_key,
           COUNT(*) AS reached,
           COUNT(*) FILTER (WHERE e.status = 'verified') AS verified,
           COUNT(*) FILTER (WHERE e.status = 'pending_review') AS pending_review,
           COUNT(*) FILTER (WHERE e.status = 'needs_changes') AS needs_changes,
           COALESCE(AVG(e.failed_tries), 0)::float AS avg_failed_tries,
           COALESCE(
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e.verified_at - e.first_try_at)) / 60)
             FILTER (WHERE e.verified_at IS NOT NULL AND e.first_try_at IS NOT NULL),
             0
           )::float AS median_minutes_to_verify
         FROM quest_step_evidence e
         JOIN quest_attempts a ON a.id = e.attempt_id
         WHERE a.quest_id = $1
         GROUP BY e.step_order, e.task_key
         ORDER BY e.step_order ASC`,
        [id]
      );

      const aggsMap = new Map<number, any>();
      for (const row of stepAggsRes.rows) {
        aggsMap.set(Number(row.step_order), row);
      }

      const taskFunnel = tasks.map((t) => {
        const row = aggsMap.get(t.step_order);
        return {
          key: t.key,
          step_order: t.step_order,
          title: t.title,
          method: t.checkpoint_type,
          required: t.required,
          reached: row ? parseInt(row.reached, 10) : 0,
          verified: row ? parseInt(row.verified, 10) : 0,
          pending_review: row ? parseInt(row.pending_review, 10) : 0,
          needs_changes: row ? parseInt(row.needs_changes, 10) : 0,
          avg_failed_tries: row ? Math.round(row.avg_failed_tries * 10) / 10 : 0,
          median_minutes_to_verify: row ? Math.round(row.median_minutes_to_verify * 10) / 10 : 0,
        };
      });

      return res.status(200).json({
        success: true,
        data: {
          quest_id: quest.id,
          overall: {
            started: overallStarted,
            completed: overallCompleted,
          },
          task_funnel: taskFunnel,
        },
      });
    } catch (err) {
      return next(err);
    }
  }

  // In-memory fallback
  const attempts = db.quest_attempts.filter((a) => a.quest_id === id);
  const started = attempts.length;
  const completed = attempts.filter((a) => a.status === 'completed').length;
  const allEvidence = db.quest_step_evidence.filter((e) => attempts.some((a) => a.id === e.attempt_id));

  const taskFunnel = tasks.map((t) => {
    const evs = allEvidence.filter((e) => e.step_order === t.step_order);
    const verified = evs.filter((e) => e.status === 'verified').length;
    const pendingReview = evs.filter((e) => e.status === 'pending_review').length;
    const needsChanges = evs.filter((e) => e.status === 'needs_changes').length;
    const totalFailed = evs.reduce((acc, cur) => acc + (cur.failed_tries || 0), 0);
    const avgFailed = evs.length > 0 ? Math.round((totalFailed / evs.length) * 10) / 10 : 0;

    return {
      key: t.key,
      step_order: t.step_order,
      title: t.title,
      method: t.checkpoint_type,
      required: t.required,
      reached: evs.length,
      verified,
      pending_review: pendingReview,
      needs_changes: needsChanges,
      avg_failed_tries: avgFailed,
      median_minutes_to_verify: 0,
    };
  });

  return res.status(200).json({
    success: true,
    data: {
      quest_id: quest.id,
      overall: { started, completed },
      task_funnel: taskFunnel,
    },
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
      let liveQuest;
      try {
        liveQuest = await client.query(
          'SELECT id, author_id, is_test, status, version, steps, step_order_mode FROM quests WHERE id = $1 FOR SHARE', [id]);
      } catch {
        liveQuest = await client.query(
          'SELECT id, author_id, is_test, status, version, steps FROM quests WHERE id = $1 FOR SHARE', [id]);
      }
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
      const rawSteps = Array.isArray(q.steps) && q.steps.length > 0
        ? q.steps
        : [{ step_order: 1, title: 'Destination check-in', description: 'Submit location proof for verification.', checkpoint_type: 'location', required: true }];
      const normalizedTasks = normalizeTasks(rawSteps, q, { allowClientMarkerCode: true });
      const stepOrderMode: 'sequential' | 'any' = q.step_order_mode === 'any' ? 'any' : 'sequential';
      const requiredCount = normalizedTasks.filter((s) => s.required !== false).length;
      const attemptId = `attempt_${randomUUID()}`;

      let inserted;
      try {
        inserted = await client.query(
          `INSERT INTO quest_attempts (id, quest_id, user_id, version, current_step, total_steps, status, steps_snapshot, verified_steps, required_steps, step_order_mode)
           VALUES ($1, $2, $3, $4, 1, $5, 'in_progress', $6, 0, $7, $8) RETURNING *`,
          [attemptId, id, userId, q.version, Math.max(1, normalizedTasks.length), JSON.stringify(normalizedTasks), Math.max(1, requiredCount), stepOrderMode]
        );
      } catch {
        try {
          inserted = await client.query(
            `INSERT INTO quest_attempts (id, quest_id, user_id, version, current_step, total_steps, status, steps_snapshot, verified_steps, required_steps)
             VALUES ($1, $2, $3, $4, 1, $5, 'in_progress', $6, 0, $7) RETURNING *`,
            [attemptId, id, userId, q.version, Math.max(1, normalizedTasks.length), JSON.stringify(normalizedTasks), Math.max(1, requiredCount)]
          );
        } catch {
          inserted = await client.query(
            `INSERT INTO quest_attempts (id, quest_id, user_id, version, current_step, total_steps, status)
             VALUES ($1, $2, $3, $4, 1, $5, 'in_progress') RETURNING *`,
            [attemptId, id, userId, q.version, Math.max(1, normalizedTasks.length)]
          );
        }
      }

      try {
        for (const task of normalizedTasks) {
          const initialStatus = stepOrderMode === 'any' ? 'ready' : (task.step_order === 1 ? 'ready' : 'not_started');
          await client.query(
            `INSERT INTO quest_step_evidence (id, attempt_id, quest_id, user_id, step_order, task_key, checkpoint_type, status, required, title, description)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (attempt_id, step_order) DO UPDATE SET
               task_key = EXCLUDED.task_key,
               checkpoint_type = EXCLUDED.checkpoint_type,
               required = EXCLUDED.required,
               title = EXCLUDED.title,
               description = EXCLUDED.description`,
            [
              `step_ev_${randomUUID()}`,
              attemptId,
              id,
              userId,
              task.step_order,
              task.key,
              task.checkpoint_type,
              initialStatus,
              task.required !== false,
              task.title,
              task.description || null,
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

    // Helper to increment failed tries on error
    const recordFailure = async (statusCode: number, code: string, message: string) => {
      const now = new Date().toISOString();
      const newFailed = (stepEvidence!.failed_tries ?? 0) + 1;
      const firstTry = stepEvidence!.first_try_at ?? now;
      stepEvidence!.failed_tries = newFailed;
      stepEvidence!.first_try_at = firstTry;

      if (pool) {
        try {
          await pool.query(
            `UPDATE quest_step_evidence
             SET failed_tries = $1, first_try_at = COALESCE(first_try_at, $2), updated_at = NOW()
             WHERE id = $3`,
            [newFailed, firstTry, stepEvidence!.id]
          );
        } catch {}
      }
      db.saveStepEvidence(stepEvidence!);

      if (claimedChallengeNonce) {
        releaseChallengeNonce(claimedChallengeNonce);
      }

      return res.status(statusCode).json({
        success: false,
        error: { code, message },
      });
    };

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
    // Must verify against activeAttempt.steps_snapshot (Plan 43 §4.2, §4.3, §4.4)
    const snapshotTasks: QuestTask[] = Array.isArray(activeAttempt.steps_snapshot) && activeAttempt.steps_snapshot.length > 0
      ? normalizeTasks(activeAttempt.steps_snapshot, quest, { allowClientMarkerCode: true })
      : normalizeTasks(quest.steps, quest, { allowClientMarkerCode: true });

    const stepDef = snapshotTasks.find((s) => s.step_order === stepOrder);
    const checkpointType = stepDef?.checkpoint_type || stepEvidence.checkpoint_type;
    const capturedLat = body.captured_lat;
    const capturedLng = body.captured_lng;
    const capturedAccuracy = body.captured_accuracy;

    let targetLat = quest.gps_lat;
    let targetLng = quest.gps_lng;
    let allowedRadius = quest.radius_meters || 150;

    const fence = (stepDef?.verification as any)?.fence || (stepDef?.gps_lat != null && stepDef?.gps_lng != null ? { lat: stepDef.gps_lat, lng: stepDef.gps_lng, radius_meters: stepDef.radius_meters } : null);
    if (fence && typeof fence.lat === 'number' && typeof fence.lng === 'number') {
      targetLat = fence.lat;
      targetLng = fence.lng;
      allowedRadius = fence.radius_meters || allowedRadius;
    }

    let newStatus: any = 'verified';
    let evidencePayload: Record<string, any> = {};
    let claimedChallengeNonce: string | undefined;

    if (checkpointType === 'location') {
      if (capturedLat === undefined || capturedLng === undefined) {
        return recordFailure(400, 'MISSING_GPS_COORDINATES', 'Location step requires captured_lat and captured_lng.');
      }

      const distance = withinRadius(capturedLat, capturedLng, targetLat, targetLng, allowedRadius, capturedAccuracy || 0);
      if (!distance.ok) {
        return recordFailure(
          400,
          'GPS_RADIUS_EXCEEDED',
          Number.isFinite(distance.distance)
            ? `You are ${Math.round(distance.distance)}m away from this checkpoint. Must be within ${allowedRadius}m.`
            : 'The captured GPS coordinates are invalid.'
        );
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
      // A host-scan task is verified only by the host scanning the traveler's pass (host-verify-qr).
      if (qrScanModeOf(stepDef) === 'host_scans_traveler') {
        return recordFailure(400, 'HOST_SCAN_REQUIRED', 'Show your quest pass to the host; they scan it to verify this task.');
      }
      if (capturedLat === undefined || capturedLng === undefined) {
        return recordFailure(400, 'MISSING_GPS_COORDINATES', 'QR verification requires a fresh GPS reading.');
      }

      const distance = withinRadius(capturedLat, capturedLng, targetLat, targetLng, allowedRadius, capturedAccuracy || 0);
      if (!distance.ok) {
        return recordFailure(
          400,
          'GPS_RADIUS_EXCEEDED',
          Number.isFinite(distance.distance)
            ? `Fresh GPS reading (${Math.round(distance.distance)}m) exceeds allowed radius of ${allowedRadius}m.`
            : 'The captured GPS coordinates are invalid.'
        );
      }

      const qrCode = body.qr_code || body.scanned_marker_code;
      const challengeToken = body.challenge_token;

      let qrValid = false;
      let qrDetails: any = {};

      const stepMarker = (stepDef?.verification as any)?.marker_code || stepDef?.marker_code;
      if (qrCode) {
        const matchesQuest = secureCodeEquals(quest.marker_code, qrCode);
        const matchesStep = stepMarker && secureCodeEquals(stepMarker, qrCode);
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
        return recordFailure(400, 'INVALID_QR_CODE', 'The scanned QR code is invalid for this checkpoint.');
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

      // Reject URL-only or hash-only photo evidence (Plan 43 §4.3)
      if (!fileBuffer) {
        return recordFailure(400, 'VALIDATION_ERROR', 'A photo image file is required for photo task evidence.');
      }

      const photoCfg = stepDef?.verification as any;
      if (photoCfg?.require_gps || photoCfg?.fence) {
        if (capturedLat === undefined || capturedLng === undefined) {
          return recordFailure(400, 'MISSING_GPS_COORDINATES', 'This photo task requires on-site GPS coordinates.');
        }
        const photoFence = photoCfg.fence || fence;
        if (photoFence) {
          const dist = withinRadius(capturedLat, capturedLng, photoFence.lat, photoFence.lng, photoFence.radius_meters || allowedRadius, capturedAccuracy || 0);
          if (!dist.ok) {
            return recordFailure(
              400,
              'GPS_RADIUS_EXCEEDED',
              Number.isFinite(dist.distance)
                ? `Photo must be taken on-site (within ${photoFence.radius_meters}m). Current distance: ${Math.round(dist.distance)}m.`
                : 'The captured GPS coordinates are invalid.'
            );
          }
        }
      }

      const sha256Hash = createHash('sha256').update(fileBuffer).digest('hex');
      const dir = ensurePrivateEvidenceDir();
      const storedFilename = `evidence_${stepEvidence.id}_${randomUUID().slice(0, 8)}.${fileExt}`;
      fs.writeFileSync(path.resolve(dir, storedFilename), fileBuffer);

      const galleryOptIn = body.gallery_opt_in === true || body.gallery_opt_in === 'true';

      evidencePayload = {
        sha256: sha256Hash,
        file_path: storedFilename,
        photo_url: `/api/v1/quests/evidence/${stepEvidence.id}/file`,
        gallery_opt_in: galleryOptIn,
        gps: capturedLat !== undefined ? { lat: capturedLat, lng: capturedLng, accuracy: capturedAccuracy } : null,
        submitted_at: new Date().toISOString(),
      };
      newStatus = 'pending_review';
    } else if (checkpointType === 'ar') {
      if (capturedLat === undefined || capturedLng === undefined) {
        return recordFailure(400, 'MISSING_GPS_COORDINATES', 'AR verification requires a fresh GPS reading.');
      }

      const distance = withinRadius(capturedLat, capturedLng, targetLat, targetLng, allowedRadius, capturedAccuracy || 0);
      if (!distance.ok) {
        return recordFailure(
          400,
          'GPS_RADIUS_EXCEEDED',
          Number.isFinite(distance.distance)
            ? `You are ${Math.round(distance.distance)}m away from this AR checkpoint. Must be within ${allowedRadius}m.`
            : 'The captured GPS coordinates are invalid.'
        );
      }

      const challengeToken = body.challenge_token;
      if (!challengeToken) {
        return recordFailure(400, 'MISSING_CHALLENGE_TOKEN', 'AR verification requires a valid challenge token.');
      }

      let validAr = false;
      let arClaims: any = null;
      try {
        arClaims = verifyQuestArChallengeToken(challengeToken);
      } catch (err: any) {
        if (err?.name === 'TokenExpiredError') {
          return recordFailure(401, 'CHALLENGE_TOKEN_EXPIRED', 'AR challenge token has expired. Please restart the AR view.');
        }
      }

      if (!arClaims) {
        // Also check legacy token fallback
        try {
          const legacyClaims = verifyQuestChallengeToken(challengeToken);
          if (legacyClaims && legacyClaims.quest_id === quest.id && legacyClaims.user_id === userId) {
            arClaims = legacyClaims;
          }
        } catch {}
      }

      if (!arClaims || arClaims.quest_id !== quest.id || arClaims.user_id !== userId) {
        return recordFailure(400, 'INVALID_CHALLENGE_TOKEN', 'The challenge token is invalid for this AR checkpoint.');
      }

      if (arClaims.attempt_id && arClaims.attempt_id !== activeAttempt.id) {
        return recordFailure(400, 'INVALID_CHALLENGE_TOKEN', 'Challenge token was issued for a different attempt.');
      }

      const taskKey = stepEvidence.task_key || stepDef?.key;
      if (arClaims.task_key && taskKey && arClaims.task_key !== taskKey) {
        return recordFailure(400, 'INVALID_CHALLENGE_TOKEN', 'Challenge token was issued for a different task.');
      }

      const claimed = claimChallengeNonce(arClaims.nonce);
      if (!claimed) {
        return recordFailure(400, 'CHALLENGE_NONCE_REUSED', 'Challenge token has already been used.');
      }
      claimedChallengeNonce = arClaims.nonce;

      evidencePayload = {
        challenge_nonce: arClaims.nonce,
        gps: {
          lat: capturedLat,
          lng: capturedLng,
          accuracy: capturedAccuracy ?? 5,
          distance_meters: Math.round(distance.distance),
        },
        verified_at: new Date().toISOString(),
      };
      newStatus = 'verified';
    } else if (checkpointType === 'action') {
      const actionCfg = (stepDef?.verification as any)?.task;
      const actionKind = actionCfg?.kind || body.action_name;
      const attemptStartedAt = activeAttempt.created_at;

      let verified = false;
      let failureMessage = 'Please complete the required action first.';

      if (actionKind === 'complete_quiz') {
        const quizId = actionCfg?.quiz_id || body.quiz_id;
        if (!quizId) {
          return recordFailure(400, 'INVALID_ACTION_CONFIG', 'Quiz task is missing quiz_id.');
        }
        if (pool) {
          const quizRes = await pool.query(
            `SELECT 1 FROM cultural_quiz_completions
             WHERE user_id = $1 AND reward_scope_id = $2 AND completed_at >= $3
             LIMIT 1`,
            [userId, quizId, attemptStartedAt]
          );
          verified = Boolean(quizRes.rows[0]);
        } else {
          // In-memory fallback
          const completions = (db as any).cultural_quiz_completions || [];
          verified = completions.some((c: any) => c.user_id === userId && c.reward_scope_id === quizId && new Date(c.completed_at) >= new Date(attemptStartedAt));
        }
        failureMessage = 'Finish the cultural quiz to complete this task.';
      } else if (actionKind === 'save_spot') {
        const spotId = actionCfg?.spot_id || body.spot_id;
        if (pool) {
          const saveRes = await pool.query(
            `SELECT 1 FROM spot_interactions WHERE user_id = $1 AND spot_id = $2 AND interaction_type = 'save' LIMIT 1`,
            [userId, spotId]
          );
          verified = Boolean(saveRes.rows[0]);
        } else {
          verified = spotStore.interactions.get(userId)?.has(`${spotId}:save`) ?? false;
        }
        failureMessage = 'Save this destination to your bookmarks first.';
      } else if (actionKind === 'like_spot') {
        const spotId = actionCfg?.spot_id || body.spot_id;
        if (pool) {
          const likeRes = await pool.query(
            `SELECT 1 FROM spot_interactions WHERE user_id = $1 AND spot_id = $2 AND interaction_type = 'like' LIMIT 1`,
            [userId, spotId]
          );
          verified = Boolean(likeRes.rows[0]);
        } else {
          verified = spotStore.interactions.get(userId)?.has(`${spotId}:like`) ?? false;
        }
        failureMessage = 'Like this destination first.';
      } else if (actionKind === 'vote_juanchoice') {
        const campaignId = actionCfg?.campaign_id || body.campaign_id;
        if (pool) {
          const voteRes = campaignId
            ? await pool.query('SELECT 1 FROM juanchoice_participations WHERE user_id = $1 AND campaign_id = $2 LIMIT 1', [userId, campaignId])
            : await pool.query('SELECT 1 FROM juanchoice_participations WHERE user_id = $1 LIMIT 1', [userId]);
          verified = Boolean(voteRes.rows[0]);
        } else {
          const participations = (db as any).juanchoice_participations || [];
          verified = campaignId
            ? participations.some((p: any) => p.user_id === userId && p.campaign_id === campaignId)
            : participations.some((p: any) => p.user_id === userId);
        }
        failureMessage = 'Cast your JuanChoice vote first.';
      } else {
        // Fallback for legacy actions like view_story
        verified = true;
      }

      if (!verified) {
        return recordFailure(422, 'TASK_NOT_DONE_YET', failureMessage);
      }

      evidencePayload = {
        action_kind: actionKind,
        verified_at: new Date().toISOString(),
      };
      newStatus = 'verified';
    }

    // 4. Update step evidence and attempt state
    const nowIso = new Date().toISOString();
    stepEvidence.status = newStatus;
    stepEvidence.evidence_payload = evidencePayload;
    stepEvidence.idempotency_key = idempotencyKey || null;
    stepEvidence.verified_at = newStatus === 'verified' ? nowIso : null;
    stepEvidence.first_try_at = stepEvidence.first_try_at || nowIso;
    if (newStatus === 'pending_review') {
      stepEvidence.submitted_at = nowIso;
    }
    stepEvidence.updated_at = nowIso;

    const nextStepOrder = stepOrder + 1;
    const isSequential = (activeAttempt.step_order_mode ?? 'sequential') === 'sequential';

    if (pool) {
      try {
        await pool.query(
          `UPDATE quest_step_evidence
           SET status = $1, evidence_payload = $2, idempotency_key = $3,
               verified_at = $4, submitted_at = $5, first_try_at = COALESCE(first_try_at, $6),
               updated_at = NOW()
           WHERE id = $7`,
          [
            stepEvidence.status,
            JSON.stringify(evidencePayload),
            stepEvidence.idempotency_key,
            stepEvidence.verified_at,
            stepEvidence.submitted_at ?? null,
            stepEvidence.first_try_at,
            stepEvidence.id,
          ]
        );

        // In sequential mode: unlock next step if not_started
        if (isSequential) {
          await pool.query(
            `UPDATE quest_step_evidence
             SET status = 'ready', updated_at = NOW()
             WHERE attempt_id = $1 AND step_order = $2 AND status = 'not_started'`,
            [activeAttempt.id, nextStepOrder]
          );
        }

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
          [verifiedCount, isSequential ? nextStepOrder : activeAttempt.current_step, activeAttempt.id]
        );
        activeAttempt.verified_steps = verifiedCount;
        if (isSequential) {
          activeAttempt.current_step = Math.max(activeAttempt.current_step, nextStepOrder);
        }
      } catch (err) {
        if (claimedChallengeNonce) releaseChallengeNonce(claimedChallengeNonce);
        return next(err);
      }
    }

    // Mirror in memory
    db.saveStepEvidence(stepEvidence);
    if (isSequential) {
      const nextStepMem = db.findStepEvidence(activeAttempt.id, nextStepOrder);
      if (nextStepMem && nextStepMem.status === 'not_started') {
        nextStepMem.status = 'ready';
        nextStepMem.updated_at = new Date().toISOString();
        db.saveStepEvidence(nextStepMem);
      }
      activeAttempt.current_step = Math.max(activeAttempt.current_step, nextStepOrder);
    }
    const memSteps = db.getStepEvidence(activeAttempt.id);
    activeAttempt.verified_steps = memSteps.filter((s) => s.status === 'verified').length;
    claimedChallengeNonce = undefined;

    if (newStatus === 'verified' && pool) {
      await handleQuestStepVerified(pool, {
        userId,
        questId: activeAttempt.quest_id ?? quest.id,
        evidenceId: stepEvidence.id,
      });
    }

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

// Owner decision 2026-10-30: a reward is paid at once only for an official quest (no author, an admin author,
// or a sponsor funding plan) when every step was verified by the server (no photo waiting for review) and the
// traveler is not the author. Everything else goes to independent review, as before.
async function instantRewardEligible(quest: QuestRow, userId: string, steps: QuestStepEvidenceRow[]): Promise<boolean> {
  if (steps.some((step) => step.status === 'pending_review')) return false;
  if (!quest.author_id) return true;
  if (quest.author_id === userId) return false;
  const pool = getPool();
  const author = pool ? await db.usersRepo.findById(quest.author_id).catch(() => undefined) : db.findUserById(quest.author_id);
  if (author?.role === 'admin') return true;
  return pool ? hasFundingPlan(pool, quest.id) : false;
}

// Submit a finished attempt: settles the reward at once when instantRewardEligible, otherwise sends it to review.
async function handleSubmitOrCompleteAttempt(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
  options: { allowInstantReward: boolean }
) {
  const { id } = req.params;
  const userId = req.user!.id;
  const pool = getPool();
  const quest = db.findQuestById(id, true);

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

  const canSettleImmediately = options.allowInstantReward && Boolean(quest) && await instantRewardEligible(quest!, userId, steps);

  if (canSettleImmediately && quest) {
    const awardedPoints = quest.reward_points || 0;
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await lockGovernanceSnapshot(client);
        await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
        if (await hasCompletedQuest(db, userId, id, client)) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            success: false,
            error: { code: 'ALREADY_COMPLETED', message: 'You have already completed this quest.' },
          });
        }
        await requireFundingHold(client, userId, id);
        const rewardSettlement = await settleReward({
          client,
          userId,
          questId: id,
          referenceId: activeAttempt.id,
          actorId: userId,
          rewardPoints: awardedPoints,
        });
        const updatedAttemptRes = await client.query(
          "UPDATE quest_attempts SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *",
          [activeAttempt.id]
        );
        if (env.PROGRESSION_ENABLED && env.PROGRESSION_EMIT_OUTBOX_ENABLED) {
          await progressionService.recordApprovalOutboxEvent(
            {
              id: activeAttempt.id,
              user_id: userId,
              quest_id: id,
              created_at: activeAttempt.created_at,
              reviewed_at: new Date().toISOString(),
              is_test: Boolean(quest.is_test),
            },
            client
          );
        }
        await commitGovernanceTransaction(client);
        if (rewardSettlement.fundedGroups) publishFunding(rewardSettlement.fundedGroups);
        const gov = rewardSettlement.governanceResult;
        if (gov) {
          governanceStore.publishCommittedTransaction({
            entries: gov.entries,
            audit: [gov.audit],
            userBalanceUpdate: { userId, demoPoints: rewardSettlement.newPoints },
          });
        }

        const completedAttempt = updatedAttemptRes.rows[0] ? mapAttempt(updatedAttemptRes.rows[0]) : activeAttempt;
        completedAttempt.status = 'completed';
        completedAttempt.completed_at = completedAttempt.completed_at || new Date().toISOString();
        const memAttempt = db.quest_attempts.find((a) => a.id === activeAttempt!.id);
        if (memAttempt) {
          memAttempt.status = 'completed';
          memAttempt.completed_at = completedAttempt.completed_at;
          memAttempt.updated_at = completedAttempt.updated_at;
        }
        const traveler = db.users.find((u) => u.id === userId);
        if (traveler) traveler.demo_points = rewardSettlement.newPoints;

        return res.status(200).json({
          success: true,
          data: {
            ...sanitizeAttemptSnapshot(completedAttempt),
            attempt: sanitizeAttemptSnapshot(completedAttempt),
            reward_awarded: true,
            awarded_points: rewardSettlement.awardedPoints,
            new_points: rewardSettlement.newPoints,
            ...(rewardSettlement.voucherPerk ? { voucher_perk: rewardSettlement.voucherPerk } : {}),
          },
          message: `Quest completed! You earned +${rewardSettlement.awardedPoints} points.`,
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err instanceof FundingError) return fundingErrorResponse(res, err);
        return next(err);
      } finally {
        client.release();
      }
    }

    // In-memory immediate completion fallback
    if (await hasCompletedQuest(db, userId, id)) {
      return res.status(409).json({
        success: false,
        error: { code: 'ALREADY_COMPLETED', message: 'You have already completed this quest.' },
      });
    }
    const nowIso = new Date().toISOString();
    activeAttempt.status = 'completed';
    activeAttempt.completed_at = nowIso;
    activeAttempt.updated_at = nowIso;
    const rewardSettlement = await settleReward({
      userId,
      questId: id,
      referenceId: activeAttempt.id,
      actorId: userId,
      rewardPoints: awardedPoints,
    });
    return res.status(200).json({
      success: true,
      data: {
        ...sanitizeAttemptSnapshot(activeAttempt),
        attempt: sanitizeAttemptSnapshot(activeAttempt),
        reward_awarded: true,
        awarded_points: rewardSettlement.awardedPoints,
        new_points: rewardSettlement.newPoints,
      },
      message: `Quest completed! You earned +${rewardSettlement.awardedPoints} points.`,
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
    data: {
      ...sanitizeAttemptSnapshot(activeAttempt),
      attempt: sanitizeAttemptSnapshot(activeAttempt),
      reward_awarded: false,
      awarded_points: 0,
    },
    message: 'Quest attempt submitted for independent review. Rewards will be granted upon review approval.',
  });
}

// POST /quests/:id/submit-for-review - Submit quest for final independent review (unchanged for older clients)
router.post('/quests/:id/submit-for-review', authenticateToken, async (req: AuthRequest, res: Response, next: NextFunction) => {
  return handleSubmitOrCompleteAttempt(req, res, next, { allowInstantReward: false });
});

// POST /quests/:id/complete - Finish the quest: instant reward when eligible (see instantRewardEligible), otherwise review
router.post('/quests/:id/complete', authenticateToken, async (req: AuthRequest, res: Response, next: NextFunction) => {
  return handleSubmitOrCompleteAttempt(req, res, next, { allowInstantReward: true });
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

// POST /quests/:id/steps/:stepOrder/ar-challenge - Issue single-use AR challenge token bound to attempt & task
const arChallengeSchema = z.object({
  params: z.object({ id: z.string().min(1), stepOrder: z.string().regex(/^[1-9]\d{0,2}$/) }),
  body: z.object({
    captured_lat: optionalLat,
    captured_lng: optionalLng,
    captured_accuracy: optionalAccuracy,
  }),
});

router.post(
  '/quests/:id/steps/:stepOrder/ar-challenge',
  authenticateToken,
  validateRequest(arChallengeSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const { id, stepOrder: stepOrderStr } = req.params;
    const stepOrder = Number(stepOrderStr);
    const userId = req.user!.id;
    const { captured_lat, captured_lng, captured_accuracy } = req.body;

    const quest = db.findQuestById(id, true);
    if (!quest) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Quest not found.' } });
    }

    if (captured_lat === undefined || captured_lng === undefined) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_GPS_COORDINATES', message: 'AR challenge requires captured_lat and captured_lng.' },
      });
    }

    const pool = getPool();
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

    const snapshotTasks: QuestTask[] = Array.isArray(activeAttempt.steps_snapshot) && activeAttempt.steps_snapshot.length > 0
      ? normalizeTasks(activeAttempt.steps_snapshot, quest)
      : normalizeTasks(quest.steps, quest);

    const stepDef = snapshotTasks.find((s) => s.step_order === stepOrder);
    if (!stepDef || stepDef.checkpoint_type !== 'ar') {
      return res.status(400).json({
        success: false,
        error: { code: 'NOT_AR_TASK', message: `Step ${stepOrder} is not an AR task.` },
      });
    }

    const fence = (stepDef.verification as any)?.fence || (stepDef.gps_lat != null && stepDef.gps_lng != null ? { lat: stepDef.gps_lat, lng: stepDef.gps_lng, radius_meters: stepDef.radius_meters } : null);
    const targetLat = fence?.lat ?? quest.gps_lat;
    const targetLng = fence?.lng ?? quest.gps_lng;
    const allowedRadius = fence?.radius_meters ?? 50;

    const distance = withinRadius(captured_lat, captured_lng, targetLat, targetLng, allowedRadius, captured_accuracy || 0);
    if (!distance.ok) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'GPS_RADIUS_EXCEEDED',
          message: Number.isFinite(distance.distance)
            ? `Get closer — you're ${Math.round(distance.distance)} m away from this AR checkpoint.`
            : 'The captured GPS coordinates are invalid.',
        },
      });
    }

    const nonce = randomUUID();
    const expiresInSec = 600; // 10 minutes
    const taskKey = stepEvidence.task_key || stepDef.key;
    const token = signQuestArChallenge(
      {
        user_id: userId,
        quest_id: quest.id,
        attempt_id: activeAttempt.id,
        task_key: taskKey,
        nonce,
      },
      expiresInSec
    );

    return res.status(200).json({
      success: true,
      data: {
        challenge_token: token,
        quest_id: quest.id,
        attempt_id: activeAttempt.id,
        task_key: taskKey,
        expires_at: new Date(Date.now() + expiresInSec * 1000).toISOString(),
      },
    });
  }
);

// POST /quests/:id/steps/:stepOrder/qr-pass - Issue signed traveler QR pass for reverse host-scan QR tasks
router.post(
  '/quests/:id/steps/:stepOrder/qr-pass',
  authenticateToken,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const { id, stepOrder: stepOrderStr } = req.params;
    const stepOrder = Number(stepOrderStr);
    const userId = req.user!.id;

    const quest = db.findQuestById(id, true);
    if (!quest) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Quest not found.' } });
    }

    const pool = getPool();
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

    if (stepEvidence.status === 'not_started') {
      return res.status(400).json({
        success: false,
        error: { code: 'STEP_NOT_READY', message: `Step ${stepOrder} is locked. Complete previous steps first.` },
      });
    }

    const snapshotTasks: QuestTask[] = Array.isArray(activeAttempt.steps_snapshot) && activeAttempt.steps_snapshot.length > 0
      ? normalizeTasks(activeAttempt.steps_snapshot, quest)
      : normalizeTasks(quest.steps, quest);

    const stepDef = snapshotTasks.find((s) => s.step_order === stepOrder);
    if (!stepDef || stepDef.checkpoint_type !== 'qr') {
      return res.status(400).json({
        success: false,
        error: { code: 'NOT_QR_TASK', message: `Step ${stepOrder} is not a QR task.` },
      });
    }
    if (qrScanModeOf(stepDef) !== 'host_scans_traveler') {
      return res.status(400).json({
        success: false,
        error: { code: 'NOT_HOST_SCAN_TASK', message: `Step ${stepOrder} is verified by scanning the printed QR code, not with a pass.` },
      });
    }

    const nonce = randomUUID();
    const expiresInSec = 600; // 10 minutes
    const taskKey = stepEvidence.task_key || stepDef.key;
    const token = signQuestQrPass(
      {
        user_id: userId,
        quest_id: quest.id,
        attempt_id: activeAttempt.id,
        step_order: stepOrder,
        task_key: taskKey,
        nonce,
      },
      expiresInSec
    );

    const travelerUser = db.users.find((u) => u.id === userId);
    const travelerDisplayName = (travelerUser as any)?.display_name || (travelerUser as any)?.name || travelerUser?.seed_id || userId;

    return res.status(200).json({
      success: true,
      data: {
        qr_pass_token: token,
        qr_payload: `JDQPASS:${token}`,
        quest_id: quest.id,
        attempt_id: activeAttempt.id,
        step_order: stepOrder,
        task_key: taskKey,
        status: stepEvidence.status,
        traveler_name: travelerDisplayName,
        expires_at: new Date(Date.now() + expiresInSec * 1000).toISOString(),
      },
    });
  }
);

// POST /quests/:id/steps/:stepOrder/host-verify-qr - Quest author/host or admin scans traveler's QR pass to verify step
const hostVerifyQrSchema = z.object({
  params: z.object({ id: z.string().min(1), stepOrder: z.string().regex(/^[1-9]\d{0,2}$/) }),
  body: z.object({
    qr_pass_token: z.string().trim().min(1).max(4096),
    captured_lat: optionalLat,
    captured_lng: optionalLng,
    captured_accuracy: optionalAccuracy,
  }),
});

router.post(
  '/quests/:id/steps/:stepOrder/host-verify-qr',
  authenticateToken,
  validateRequest(hostVerifyQrSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const { id, stepOrder: stepOrderStr } = req.params;
    const stepOrder = Number(stepOrderStr);
    const hostUserId = req.user!.id;
    const { qr_pass_token, captured_lat, captured_lng, captured_accuracy } = req.body;

    const quest = db.findQuestById(id, true);
    if (!quest) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Quest not found.' } });
    }

    // The host is the quest's author, or an admin. Adding the destination does not make someone its host.
    const isAuthor = Boolean(hostUserId && quest.author_id === hostUserId);
    const hostRow = getPool() ? await db.usersRepo.findById(hostUserId).catch(() => undefined) : db.findUserById(hostUserId);
    const isAdminOrQA = hostRow?.role === 'admin' || hostRow?.role === 'qa';

    if (!isAuthor && !isAdminOrQA) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN_NOT_QUEST_HOST', message: 'Only the quest host/author or an administrator can scan and verify traveler QR passes.' },
      });
    }

    let claims: ReturnType<typeof verifyQuestQrPassToken> = null;
    try {
      claims = verifyQuestQrPassToken(qr_pass_token);
    } catch (err: any) {
      if (err?.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          error: { code: 'QR_PASS_EXPIRED', message: "The traveler's QR pass has expired. Ask them to refresh their pass." },
        });
      }
    }

    if (!claims || claims.quest_id !== quest.id || claims.step_order !== stepOrder) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_QR_PASS', message: 'This QR pass is invalid or belongs to a different quest or task step.' },
      });
    }

    if (claims.user_id === hostUserId) {
      return res.status(403).json({
        success: false,
        error: { code: 'SELF_VERIFY_FORBIDDEN', message: 'Hosts cannot scan and verify their own quest attempt.' },
      });
    }

    const pool = getPool();
    let activeAttempt: QuestAttemptRow | null = null;
    let stepEvidence: QuestStepEvidenceRow | null = null;

    if (pool) {
      try {
        const attemptRes = await pool.query(
          "SELECT * FROM quest_attempts WHERE id = $1 AND user_id = $2 AND quest_id = $3 LIMIT 1",
          [claims.attempt_id, claims.user_id, id]
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
      const memAttempt = db.quest_attempts.find((a) => a.id === claims!.attempt_id && a.user_id === claims!.user_id && a.quest_id === id);
      if (memAttempt) {
        activeAttempt = memAttempt;
        stepEvidence = db.findStepEvidence(memAttempt.id, stepOrder) ?? null;
      }
    }

    if (!activeAttempt || activeAttempt.status !== 'in_progress') {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_ACTIVE_ATTEMPT', message: 'The traveler does not have an active in-progress attempt for this quest.' },
      });
    }

    if (!stepEvidence) {
      return res.status(404).json({
        success: false,
        error: { code: 'STEP_NOT_FOUND', message: `Step ${stepOrder} not found on traveler's attempt.` },
      });
    }

    if (stepEvidence.status === 'verified') {
      return res.status(200).json({
        success: true,
        data: {
          step: stepEvidence,
          attempt: sanitizeAttemptSnapshot(activeAttempt),
          traveler_id: activeAttempt.user_id,
        },
        message: "Traveler's step is already verified.",
      });
    }

    if (stepEvidence.status === 'not_started') {
      return res.status(400).json({
        success: false,
        error: { code: 'STEP_NOT_READY', message: `Step ${stepOrder} is still locked for this traveler.` },
      });
    }

    const snapshotTasks: QuestTask[] = Array.isArray(activeAttempt.steps_snapshot) && activeAttempt.steps_snapshot.length > 0
      ? normalizeTasks(activeAttempt.steps_snapshot, quest, { allowClientMarkerCode: true })
      : normalizeTasks(quest.steps, quest, { allowClientMarkerCode: true });
    const stepDef = snapshotTasks.find((s) => s.step_order === stepOrder);

    if (!stepDef || stepDef.checkpoint_type !== 'qr' || qrScanModeOf(stepDef) !== 'host_scans_traveler') {
      return res.status(400).json({
        success: false,
        error: { code: 'NOT_HOST_SCAN_TASK', message: `Step ${stepOrder} is not verified by a host scan.` },
      });
    }
    // The host verifies on site: a fresh host GPS reading inside the task fence is required.
    if (typeof captured_lat !== 'number' || typeof captured_lng !== 'number') {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_GPS_COORDINATES', message: 'Host verification needs your current location.' },
      });
    }
    {
      const fence = (stepDef?.verification as any)?.fence || (stepDef?.gps_lat != null && stepDef?.gps_lng != null ? { lat: stepDef.gps_lat, lng: stepDef.gps_lng, radius_meters: stepDef.radius_meters } : null);
      const targetLat = fence?.lat ?? quest.gps_lat;
      const targetLng = fence?.lng ?? quest.gps_lng;
      const allowedRadius = fence?.radius_meters ?? quest.radius_meters ?? 150;
      const distance = withinRadius(captured_lat, captured_lng, targetLat, targetLng, allowedRadius, captured_accuracy || 0);
      if (!distance.ok) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'GPS_RADIUS_EXCEEDED',
            message: Number.isFinite(distance.distance)
              ? `Host GPS reading (${Math.round(distance.distance)}m) exceeds allowed radius of ${allowedRadius}m.`
              : 'The captured GPS coordinates are invalid.',
          },
        });
      }
    }

    const claimed = claimChallengeNonce(claims.nonce);
    if (!claimed) {
      return res.status(400).json({
        success: false,
        error: { code: 'CHALLENGE_NONCE_REUSED', message: 'This QR pass has already been scanned and used.' },
      });
    }

    const nowIso = new Date().toISOString();
    const evidencePayload = {
      scan_mode: 'host_scans_traveler',
      verified_by_host: hostUserId,
      challenge_nonce: claims.nonce,
      gps: captured_lat !== undefined && captured_lng !== undefined
        ? { lat: captured_lat, lng: captured_lng, accuracy: captured_accuracy ?? 5 }
        : null,
      verified_at: nowIso,
    };

    stepEvidence.status = 'verified';
    stepEvidence.evidence_payload = evidencePayload;
    stepEvidence.verified_at = nowIso;
    stepEvidence.first_try_at = stepEvidence.first_try_at || nowIso;
    stepEvidence.updated_at = nowIso;

    const nextStepOrder = stepOrder + 1;
    const isSequential = (activeAttempt.step_order_mode ?? 'sequential') === 'sequential';

    if (pool) {
      try {
        await pool.query(
          `UPDATE quest_step_evidence
           SET status = 'verified', evidence_payload = $1, verified_at = $2,
               first_try_at = COALESCE(first_try_at, $3), updated_at = NOW()
           WHERE id = $4`,
          [JSON.stringify(evidencePayload), nowIso, stepEvidence.first_try_at, stepEvidence.id]
        );

        if (isSequential) {
          await pool.query(
            `UPDATE quest_step_evidence
             SET status = 'ready', updated_at = NOW()
             WHERE attempt_id = $1 AND step_order = $2 AND status = 'not_started'`,
            [activeAttempt.id, nextStepOrder]
          );
        }

        const countRes = await pool.query(
          "SELECT COUNT(*) FROM quest_step_evidence WHERE attempt_id = $1 AND status = 'verified'",
          [activeAttempt.id]
        );
        const verifiedCount = parseInt(countRes.rows[0].count, 10);
        await pool.query(
          `UPDATE quest_attempts
           SET verified_steps = $1, current_step = GREATEST(current_step, $2), updated_at = NOW()
           WHERE id = $3`,
          [verifiedCount, isSequential ? nextStepOrder : activeAttempt.current_step, activeAttempt.id]
        );
        activeAttempt.verified_steps = verifiedCount;
        if (isSequential) {
          activeAttempt.current_step = Math.max(activeAttempt.current_step, nextStepOrder);
        }
      } catch (err) {
        releaseChallengeNonce(claims.nonce);
        return next(err);
      }
    }

    db.saveStepEvidence(stepEvidence);
    if (isSequential) {
      const nextStepMem = db.findStepEvidence(activeAttempt.id, nextStepOrder);
      if (nextStepMem && nextStepMem.status === 'not_started') {
        nextStepMem.status = 'ready';
        nextStepMem.updated_at = nowIso;
        db.saveStepEvidence(nextStepMem);
      }
      activeAttempt.current_step = Math.max(activeAttempt.current_step, nextStepOrder);
    }
    const memSteps = db.getStepEvidence(activeAttempt.id);
    activeAttempt.verified_steps = memSteps.filter((s) => s.status === 'verified').length;

    if (pool) {
      await handleQuestStepVerified(pool, {
        userId: activeAttempt.user_id,
        questId: activeAttempt.quest_id ?? quest.id,
        evidenceId: stepEvidence.id,
      });
    }

    const travelerUser = db.users.find((u) => u.id === activeAttempt!.user_id);
    const travelerDisplayName = (travelerUser as any)?.display_name || (travelerUser as any)?.name || travelerUser?.seed_id || activeAttempt.user_id;

    return res.status(200).json({
      success: true,
      data: {
        step: stepEvidence,
        attempt: sanitizeAttemptSnapshot(activeAttempt),
        traveler_id: activeAttempt.user_id,
        traveler_name: travelerDisplayName,
      },
      message: `Verified step ${stepOrder} for traveler ${travelerDisplayName}.`,
    });
  }
);

export default router;
