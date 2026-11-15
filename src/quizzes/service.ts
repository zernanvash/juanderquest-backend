import { perkBonus } from '../juanchoice/perks.js';
import { createHash, randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { CulturalQuizRepository } from './repository.js';
import { ProgressionRepository } from '../progression/repository.js';
import { recordActivity, runIsolatedProducer } from '../social/activity.js';
import {
  CulturalQuiz,
  CulturalQuizVersion,
  CulturalQuizQuestion,
  CulturalQuizQuestionType,
  CulturalQuizAttempt,
  CulturalQuizGradedResult,
  CulturalQuizDetail,
  NearbyQuizInvitation,
  SpotQuizSummary,
} from './types.js';

export interface StartAttemptParams {
  quizId: string;
  userId: string;
  lat: number;
  lng: number;
  accuracyMeters?: number;
  capturedAt?: string;
  idempotencyKey?: string;
}

export interface SubmitAttemptParams {
  attemptId: string;
  userId: string;
  answers: Array<{
    questionId: string;
    selectedOptionId?: string;
    orderedOptionIds?: string[];
    skipped?: boolean;
  }>;
  styleScore?: number;
  streakMax?: number;
  idempotencyKey?: string;
}

export interface CreateQuizDraftParams {
  destinationId: string;
  title: string;
  description: string;
  language?: 'en' | 'fil' | 'ilo' | 'pag';
  radiusMeters?: number;
  xpReward?: number;
  timeLimitMinutes?: number;
  cooldownHours?: number;
  hostLines?: any;
  theme?: string;
  questions: Array<{
    ordinal: number;
    questionText: string;
    explanation: string;
    sourceUrl?: string;
    questionType?: CulturalQuizQuestionType;
    mediaUrl?: string | null;
    hint?: string | null;
    round?: 'main' | 'special' | 'lightning';
    answerPayload?: any | null;
    options: Array<{
      ordinal: number;
      optionText: string;
      isCorrect: boolean;
    }>;
  }>;
  adminUserId: string;
  isTest?: boolean;
}

function deterministicShuffle<T>(items: T[], seed: string): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const hash = createHash('sha256').update(`${seed}:${i}`).digest();
    const n = hash.readUInt32BE(0);
    const j = n % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function sanitizeAttemptQuestions(
  questions: CulturalQuizQuestion[],
  attemptId: string,
  revealAnswers = false,
): CulturalQuizQuestion[] {
  return questions.map((q) => {
    const qType = q.question_type || 'multiple_choice';
    const baseOptions =
      qType === 'sequence_order' && !revealAnswers
        ? deterministicShuffle(q.options, `${attemptId}:${q.id}`)
        : q.options;

    return {
      id: q.id,
      version_id: q.version_id,
      ordinal: q.ordinal,
      question_text: q.question_text,
      explanation: revealAnswers ? q.explanation : '',
      source_url: q.source_url,
      question_type: qType,
      media_url: q.media_url || null,
      round: q.round || 'main',
      created_at: q.created_at,
      options: baseOptions.map((opt) => {
        if (qType === 'sequence_order' && !revealAnswers) {
          return {
            id: opt.id,
            question_id: opt.question_id,
            option_text: opt.option_text,
            created_at: opt.created_at,
          };
        }
        return {
          id: opt.id,
          question_id: opt.question_id,
          ordinal: opt.ordinal,
          option_text: opt.option_text,
          ...(revealAnswers ? { is_correct: opt.is_correct } : {}),
          created_at: opt.created_at,
        };
      }),
    };
  });
}

async function fetchDestinationPhotoUrls(client: PoolClient, destinationId: string): Promise<Set<string>> {
  const urls = new Set<string>();
  const { rows: assetRows } = await client.query(
    `SELECT url FROM spot_assets WHERE spot_id = $1 AND status IN ('attached', 'approved')`,
    [destinationId],
  );
  for (const r of assetRows) {
    if (typeof r.url === 'string' && r.url.trim()) {
      urls.add(r.url.trim());
    }
  }
  const { rows: spotRows } = await client.query(
    `SELECT image_url FROM spots WHERE id = $1 AND image_url IS NOT NULL AND image_url <> ''`,
    [destinationId],
  );
  for (const r of spotRows) {
    if (typeof r.image_url === 'string' && r.image_url.trim()) {
      urls.add(r.image_url.trim());
    }
  }
  return urls;
}

function validateQuizDraftQuestions(
  questions: CreateQuizDraftParams['questions'],
  allowedSpotPhotoUrls: Set<string>,
): void {
  if (questions.length !== 5) {
    throw new Error('INVALID_QUIZ_DRAFT: A cultural quiz draft must have exactly 5 questions.');
  }
  for (const q of questions) {
    const qType = q.questionType || 'multiple_choice';
    const ordinals = q.options.map((o) => o.ordinal).sort((a, b) => a - b);

    if (qType === 'true_false') {
      if (q.options.length !== 2) {
        throw new Error(`INVALID_QUIZ_DRAFT: Question ${q.ordinal} (true_false) must have exactly 2 options.`);
      }
      if (ordinals[0] !== 1 || ordinals[1] !== 2) {
        throw new Error(`INVALID_QUIZ_DRAFT: Question ${q.ordinal} (true_false) options must have ordinals 1 and 2.`);
      }
      const correctCount = q.options.filter((opt) => opt.isCorrect).length;
      if (correctCount !== 1) {
        throw new Error(`INVALID_QUIZ_DRAFT: Question ${q.ordinal} must have exactly 1 correct answer.`);
      }
    } else if (qType === 'sequence_order') {
      if (q.options.length < 3 || q.options.length > 4) {
        throw new Error(
          `INVALID_QUIZ_DRAFT: Question ${q.ordinal} (sequence_order) must have 3 or 4 options.`,
        );
      }
      for (let i = 0; i < ordinals.length; i++) {
        if (ordinals[i] !== i + 1) {
          throw new Error(
            `INVALID_QUIZ_DRAFT: Question ${q.ordinal} (sequence_order) options must have sequential ordinals 1..${q.options.length}.`,
          );
        }
      }
    } else if (qType === 'multiple_choice' || qType === 'photo_clue') {
      if (q.options.length !== 4) {
        throw new Error(`INVALID_QUIZ_DRAFT: Question ${q.ordinal} must have exactly 4 options.`);
      }
      for (let i = 0; i < 4; i++) {
        if (ordinals[i] !== i + 1) {
          throw new Error(`INVALID_QUIZ_DRAFT: Question ${q.ordinal} options must have ordinals 1..4.`);
        }
      }
      const correctCount = q.options.filter((opt) => opt.isCorrect).length;
      if (correctCount !== 1) {
        throw new Error(`INVALID_QUIZ_DRAFT: Question ${q.ordinal} must have exactly 1 correct answer.`);
      }
      if (qType === 'photo_clue') {
        const url = typeof q.mediaUrl === 'string' ? q.mediaUrl.trim() : '';
        if (!url) {
          throw new Error(`INVALID_PHOTO_CLUE: Question ${q.ordinal} (photo_clue) requires a media_url.`);
        }
        if (!allowedSpotPhotoUrls.has(url)) {
          throw new Error(
            `INVALID_PHOTO_CLUE: Question ${q.ordinal} media_url must belong to the destination's existing spot photos.`,
          );
        }
      }
    } else {
      throw new Error(`INVALID_QUIZ_DRAFT: Unsupported question_type '${qType}'.`);
    }
  }
}

// Haversine formula distance in meters
export function computeHaversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3; // Earth radius in meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(R * c);
}

export class CulturalQuizService {
  constructor(
    private readonly repo: CulturalQuizRepository,
    private readonly progressionRepo: ProgressionRepository,
    private readonly pool?: Pool,
  ) {}

  private getPool(): Pool {
    return this.pool ?? getPool()!;
  }

  // Test quizzes are only for test accounts; signed-out visitors and real travelers never see them.
  private async viewerIsTest(userId?: string): Promise<boolean> {
    if (!userId) return false;
    const { rows } = await this.getPool().query('SELECT is_test FROM users WHERE id = $1', [userId]);
    return Boolean(rows[0]?.is_test);
  }

  async getNearbyQuizzes(
    lat: number,
    lng: number,
    userId?: string,
    includeApproaching = false,
  ): Promise<NearbyQuizInvitation[]> {
    const viewerIsTest = await this.viewerIsTest(userId);
    const list = (await this.repo.listPublishedQuizzes()).filter((item) => item.quiz.is_test === viewerIsTest);
    const invitations: NearbyQuizInvitation[] = [];
    const cutoffBufferMeters = includeApproaching ? 500 : 50;

    for (const item of list) {
      const distance = computeHaversineMeters(lat, lng, item.destination.gps_lat, item.destination.gps_lng);

      // Offer invitation if traveler is within radius + cutoff buffer (50m default, 500m when approaching)
      if (distance <= item.version.radius_meters + cutoffBufferMeters) {
        let isCompleted = false;
        if (userId) {
          isCompleted = await this.repo.hasCompletedRewardScope(userId, item.quiz.reward_scope_id);
        }

        invitations.push({
          quiz_id: item.quiz.id,
          destination_id: item.destination.id,
          destination_name: item.destination.name,
          municipality: item.destination.municipality,
          title: item.version.title,
          description: item.version.description,
          radius_meters: item.version.radius_meters,
          distance_meters: distance,
          in_range: distance <= item.version.radius_meters,
          xp_reward: item.version.xp_reward,
          time_limit_minutes: item.version.time_limit_minutes,
          language: item.version.language,
          is_completed: isCompleted,
        });
      }
    }

    invitations.sort((a, b) => {
      const aCompleted = Boolean(a.is_completed);
      const bCompleted = Boolean(b.is_completed);
      if (aCompleted !== bCompleted) return aCompleted ? 1 : -1;
      if (a.in_range !== b.in_range) return a.in_range ? -1 : 1;
      if (a.distance_meters !== b.distance_meters) return a.distance_meters - b.distance_meters;
      return b.xp_reward - a.xp_reward;
    });

    return invitations;
  }

  async getQuizzesForSpot(spotId: string, userId?: string): Promise<SpotQuizSummary[]> {
    const viewerIsTest = await this.viewerIsTest(userId);
    const list = (await this.repo.listPublishedQuizzes()).filter((item) => item.quiz.is_test === viewerIsTest);
    const quizzes: SpotQuizSummary[] = [];

    for (const item of list) {
      if (item.quiz.destination_id !== spotId) continue;
      const summary: SpotQuizSummary = {
        quiz_id: item.quiz.id,
        title: item.version.title,
        xp_reward: item.version.xp_reward,
        radius_meters: item.version.radius_meters,
        language: item.version.language,
      };
      if (userId) {
        summary.is_completed = await this.repo.hasCompletedRewardScope(
          userId,
          item.quiz.reward_scope_id,
        );
      }
      quizzes.push(summary);
    }

    quizzes.sort((a, b) => {
      const aCompleted = Boolean(a.is_completed);
      const bCompleted = Boolean(b.is_completed);
      if (aCompleted !== bCompleted) return aCompleted ? 1 : -1;
      if (b.xp_reward !== a.xp_reward) return b.xp_reward - a.xp_reward;
      return a.title.localeCompare(b.title);
    });

    return quizzes;
  }

  async getQuizDetail(quizId: string, userId?: string): Promise<CulturalQuizDetail | null> {
    const quiz = await this.repo.findQuizById(quizId);
    if (!quiz) return null;
    if (quiz.is_test !== (await this.viewerIsTest(userId))) return null;

    const version = await this.repo.findVersion(quiz.id, quiz.current_version);
    if (!version) return null;

    const pool = this.getPool();
    const { rows: spotRows } = await pool.query(
      `SELECT id, name, municipality, gps_lat, gps_lng FROM spots WHERE id = $1`,
      [quiz.destination_id],
    );
    if (!spotRows.length) return null;
    const dest = {
      id: spotRows[0].id,
      name: spotRows[0].name,
      municipality: spotRows[0].municipality,
      gps_lat: Number(spotRows[0].gps_lat),
      gps_lng: Number(spotRows[0].gps_lng),
    };

    let isCompleted = false;
    let activeAttemptId: string | null = null;
    let cooldownUntil: string | null = null;

    if (userId) {
      isCompleted = await this.repo.hasCompletedRewardScope(userId, quiz.reward_scope_id);
      const active = await this.repo.findActiveAttempt(quiz.id, userId);
      if (active) {
        // check if expired
        if (new Date(active.expires_at).getTime() < Date.now()) {
          // expired; mark as expired
          await pool.query(`UPDATE cultural_quiz_attempts SET status = 'expired' WHERE id = $1`, [active.id]);
        } else {
          activeAttemptId = active.id;
        }
      }

      if (!activeAttemptId) {
        const lastFailed = await this.repo.findLastFailedAttempt(quiz.id, userId);
        if (lastFailed && lastFailed.completed_at) {
          const cooldownEnd = new Date(lastFailed.completed_at).getTime() + version.cooldown_hours * 3600 * 1000;
          if (cooldownEnd > Date.now()) {
            cooldownUntil = new Date(cooldownEnd).toISOString();
          }
        }
      }
    }

    return {
      quiz,
      version,
      destination: dest,
      is_completed: isCompleted,
      active_attempt_id: activeAttemptId,
      cooldown_until: cooldownUntil,
    };
  }

  async startAttempt(
    params: StartAttemptParams,
  ): Promise<{ attempt: CulturalQuizAttempt; questions: CulturalQuizQuestion[] }> {
    const pool = this.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Lock user row first for hierarchy
      const { rows: userRows } = await client.query('SELECT id, is_test FROM users WHERE id = $1 FOR UPDATE', [
        params.userId,
      ]);

      // 2. Fetch and lock quiz
      const { rows: quizRows } = await client.query('SELECT * FROM cultural_quizzes WHERE id = $1 FOR UPDATE', [
        params.quizId,
      ]);
      if (!quizRows.length) {
        throw new Error('QUIZ_NOT_FOUND: Cultural quiz does not exist.');
      }
      const quiz = quizRows[0];
      if (Boolean(quiz.is_test) !== Boolean(userRows[0]?.is_test)) {
        throw new Error('QUIZ_NOT_FOUND: Cultural quiz does not exist.');
      }
      if (quiz.status !== 'published') {
        throw new Error(`QUIZ_NOT_AVAILABLE: Cultural quiz is currently ${quiz.status}.`);
      }

      const version = await this.repo.findVersion(quiz.id, quiz.current_version, client);
      if (!version) {
        throw new Error('QUIZ_VERSION_NOT_FOUND: Current version is missing.');
      }

      // Check destination and validate Haversine radius
      const { rows: destRows } = await client.query('SELECT id, gps_lat, gps_lng FROM spots WHERE id = $1', [
        quiz.destination_id,
      ]);
      if (!destRows.length) {
        throw new Error('DESTINATION_NOT_FOUND: Quiz destination is missing.');
      }
      const dest = destRows[0];
      const distance = computeHaversineMeters(params.lat, params.lng, Number(dest.gps_lat), Number(dest.gps_lng));
      if (distance > version.radius_meters) {
        throw new Error(`OUT_OF_RANGE: You are ${distance}m away. Must be within ${version.radius_meters}m to start.`);
      }

      // 3. Expire any stale active attempt
      await client.query(
        `UPDATE cultural_quiz_attempts 
         SET status = 'expired', updated_at = NOW() 
         WHERE quiz_id = $1 AND user_id = $2 AND status = 'in_progress' AND expires_at < NOW()`,
        [quiz.id, params.userId],
      );

      // Check if there is still an unexpired active attempt
      const active = await this.repo.findActiveAttempt(quiz.id, params.userId, client);
      if (active) {
        // Return existing active attempt questions without is_correct, secret answer keys, or sequence ordinals
        const questions = await this.repo.findQuestionsWithOptions(active.version_id, client);
        const sanitized = sanitizeAttemptQuestions(questions, active.id, false);
        await client.query('COMMIT');
        return { attempt: active, questions: sanitized };
      }

      // Check cooldown on failed attempt
      const lastFailed = await this.repo.findLastFailedAttempt(quiz.id, params.userId, client);
      if (lastFailed && lastFailed.completed_at) {
        const cooldownEnd = new Date(lastFailed.completed_at).getTime() + version.cooldown_hours * 3600 * 1000;
        if (cooldownEnd > Date.now()) {
          throw new Error(`COOLDOWN_ACTIVE: Retries locked until ${new Date(cooldownEnd).toISOString()}.`);
        }
      }

      // 4. Create new attempt
      const attemptId = randomUUID();
      const expiresAt = new Date(Date.now() + version.time_limit_minutes * 60 * 1000).toISOString();

      const { rows: attemptRows } = await client.query(
        `INSERT INTO cultural_quiz_attempts (
           id, quiz_id, version_id, reward_scope_id, user_id, status,
           started_at, expires_at, score, total_questions, xp_awarded,
           location_validated, distance_meters, idempotency_key
         ) VALUES ($1, $2, $3, $4, $5, 'in_progress', NOW(), $6, NULL, 5, 0, TRUE, $7, $8)
         RETURNING *`,
        [
          attemptId,
          quiz.id,
          version.id,
          quiz.reward_scope_id,
          params.userId,
          expiresAt,
          distance,
          params.idempotencyKey || null,
        ],
      );

      const createdAttempt = (this.repo as any).mapAttempt(attemptRows[0]);
      const questions = await this.repo.findQuestionsWithOptions(version.id, client);

      // Sanitize: never reveal is_correct, answer_payload, or sequence ordinals to traveler
      const sanitized = sanitizeAttemptQuestions(questions, createdAttempt.id, false);

      await client.query('COMMIT');
      return { attempt: createdAttempt, questions: sanitized };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getAttemptForUser(
    attemptId: string,
    userId: string,
  ): Promise<{ attempt: CulturalQuizAttempt; questions: CulturalQuizQuestion[] } | null> {
    const attempt = await this.repo.findAttemptById(attemptId);
    if (!attempt || attempt.user_id !== userId) return null;

    const questions = await this.repo.findQuestionsWithOptions(attempt.version_id);
    const isFinished = attempt.status !== 'in_progress';
    const mappedQuestions = sanitizeAttemptQuestions(questions, attempt.id, isFinished);

    return { attempt, questions: mappedQuestions };
  }

  async useLifeline(params: {
    quizId: string;
    attemptId: string;
    userId: string;
    lifeline: 'fifty_fifty' | 'ask_local' | 'skip';
    questionId?: string;
  }): Promise<{
    lifeline: string;
    question_id?: string;
    eliminated_option_ids?: string[];
    hint?: string;
    skipped?: boolean;
    remaining_lifelines: string[];
  }> {
    const pool = this.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { rows: attemptRows } = await client.query(
        'SELECT * FROM cultural_quiz_attempts WHERE id = $1 FOR UPDATE',
        [params.attemptId],
      );
      if (!attemptRows.length) {
        throw new Error('ATTEMPT_NOT_FOUND: Attempt does not exist.');
      }
      const attempt = attemptRows[0];
      if (attempt.user_id !== params.userId) {
        throw new Error('UNAUTHORIZED_ATTEMPT: You do not own this quiz attempt.');
      }
      if (attempt.quiz_id !== params.quizId) {
        throw new Error('ATTEMPT_NOT_FOUND: Attempt does not belong to this quiz.');
      }
      if (attempt.status !== 'in_progress') {
        throw new Error(`ATTEMPT_NOT_ACTIVE: Attempt is already ${attempt.status}.`);
      }
      if (new Date(attempt.expires_at).getTime() < Date.now()) {
        throw new Error('ATTEMPT_EXPIRED: The time limit for this attempt has passed.');
      }

      // Lifelines only ever act on a question of this attempt's own quiz version.
      if (!params.questionId) {
        throw new Error(`MISSING_QUESTION_ID: Question ID is required for the ${params.lifeline} lifeline.`);
      }
      const { rows: questionRows } = await client.query(
        'SELECT id, hint, question_type FROM cultural_quiz_questions WHERE id = $1 AND version_id = $2',
        [params.questionId, attempt.version_id],
      );
      if (!questionRows.length) {
        throw new Error('INVALID_QUESTION_ID: Question is not part of this attempt.');
      }

      const usedLifelines: string[] = Array.isArray(attempt.lifelines_used) ? attempt.lifelines_used : [];
      if (usedLifelines.includes(params.lifeline)) {
        throw new Error(`LIFELINE_ALREADY_USED: Lifeline '${params.lifeline}' has already been used in this attempt.`);
      }

      const qType = (questionRows[0].question_type || 'multiple_choice') as CulturalQuizQuestionType;
      if (params.lifeline === 'fifty_fifty' && qType !== 'multiple_choice' && qType !== 'photo_clue') {
        throw new Error(
          `LIFELINE_NOT_AVAILABLE: 50:50 lifeline is only available for multiple_choice and photo_clue questions.`,
        );
      }

      const updatedLifelines = [...usedLifelines, params.lifeline];
      await client.query(`UPDATE cultural_quiz_attempts SET lifelines_used = $1, updated_at = NOW() WHERE id = $2`, [
        updatedLifelines,
        attempt.id,
      ]);

      const result: {
        lifeline: string;
        question_id?: string;
        eliminated_option_ids?: string[];
        hint?: string;
        skipped?: boolean;
        remaining_lifelines: string[];
      } = {
        lifeline: params.lifeline,
        question_id: params.questionId,
        remaining_lifelines: ['fifty_fifty', 'ask_local', 'skip'].filter((l) => !updatedLifelines.includes(l)),
      };

      if (params.lifeline === 'fifty_fifty') {
        const { rows: optRows } = await client.query(
          `SELECT id, is_correct FROM cultural_quiz_options WHERE question_id = $1 ORDER BY ordinal ASC`,
          [params.questionId],
        );
        const removable = Math.min(2, optRows.length - 2);
        if (removable < 1) {
          throw new Error('LIFELINE_NOT_AVAILABLE: 50:50 needs at least three options.');
        }
        const incorrectOpts = optRows.filter((opt) => !opt.is_correct).map((opt) => String(opt.id));
        result.eliminated_option_ids = incorrectOpts.slice(0, removable);
      } else if (params.lifeline === 'ask_local') {
        result.hint =
          questionRows[0].hint || 'Local Elder tip: Look closely at Pangasinan coastal traditions and history!';
      } else if (params.lifeline === 'skip') {
        result.skipped = true;
      }

      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async submitAttempt(params: SubmitAttemptParams): Promise<CulturalQuizGradedResult> {
    const pool = this.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Lock user row
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [params.userId]);

      // 2. Fetch and lock attempt row
      const { rows: attemptRows } = await client.query(
        'SELECT * FROM cultural_quiz_attempts WHERE id = $1 FOR UPDATE',
        [params.attemptId],
      );
      if (!attemptRows.length) {
        throw new Error('ATTEMPT_NOT_FOUND: Attempt does not exist.');
      }
      const attemptRow = attemptRows[0];
      if (attemptRow.user_id !== params.userId) {
        throw new Error('UNAUTHORIZED_ATTEMPT: You do not own this quiz attempt.');
      }

      // If already graded, return existing result idempotently
      if (attemptRow.status !== 'in_progress') {
        const answers = await this.repo.findAttemptAnswers(attemptRow.id, client);
        const questions = await this.repo.findQuestionsWithOptions(attemptRow.version_id, client);
        const alreadyAwarded = await this.repo.hasCompletedRewardScope(
          params.userId,
          attemptRow.reward_scope_id,
          client,
        );

        const breakdown = questions.map((q) => {
          const ans = answers.find((a) => a.question_id === q.id);
          const qType = q.question_type || 'multiple_choice';
          if (qType === 'sequence_order') {
            const sortedOpts = [...q.options].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
            const selectedIds = Array.isArray(ans?.submitted_payload?.ordered_option_ids)
              ? ans!.submitted_payload!.ordered_option_ids!
              : [];
            return {
              question_id: q.id,
              question_text: q.question_text,
              question_type: qType,
              selected_option_id: '',
              correct_option_id: '',
              selected_option_ids: selectedIds,
              correct_option_ids: sortedOpts.map((opt) => opt.id),
              correct_order: sortedOpts.map((opt) => ({
                id: opt.id,
                ordinal: opt.ordinal ?? 0,
                option_text: opt.option_text,
              })),
              is_correct: Boolean(ans?.is_correct),
              explanation: q.explanation,
              source_url: q.source_url,
            };
          }
          const correctOpt = q.options.find((opt) => opt.is_correct);
          return {
            question_id: q.id,
            question_text: q.question_text,
            question_type: qType,
            selected_option_id: ans?.selected_option_id || '',
            correct_option_id: correctOpt?.id || '',
            is_correct: Boolean(ans?.is_correct),
            explanation: q.explanation,
            source_url: q.source_url,
          };
        });

        await client.query('COMMIT');
        return {
          attempt: (this.repo as any).mapAttempt(attemptRow),
          passed: attemptRow.status === 'passed',
          score: Number(attemptRow.score || 0),
          total_questions: Number(attemptRow.total_questions),
          xp_awarded: Number(attemptRow.xp_awarded || 0),
          already_completed_prior: alreadyAwarded && attemptRow.xp_awarded === 0,
          breakdown,
        };
      }

      // Check expiry against server clock
      if (new Date(attemptRow.expires_at).getTime() < Date.now()) {
        await client.query(`UPDATE cultural_quiz_attempts SET status = 'expired', updated_at = NOW() WHERE id = $1`, [
          attemptRow.id,
        ]);
        await client.query('COMMIT');
        throw new Error('ATTEMPT_EXPIRED: The time limit for this attempt has passed.');
      }

      // 3. Load questions and grade answers
      const questions = await this.repo.findQuestionsWithOptions(attemptRow.version_id, client);
      if (questions.length !== 5) {
        throw new Error('INVALID_QUIZ_CONFIGURATION: Quiz must have 5 questions.');
      }

      // Validate answer count and uniqueness
      if (params.answers.length !== 5) {
        throw new Error(`MISSING_ANSWERS: Expected 5 answers, received ${params.answers.length}.`);
      }
      const answeredQIds = new Set(params.answers.map((a) => a.questionId));
      if (answeredQIds.size !== 5) {
        throw new Error('DUPLICATE_ANSWERS: Duplicate question answers provided.');
      }

      // A skip is honoured only after the Skip lifeline was used, for one question, and never scores.
      const skippedCount = params.answers.filter((a) => a.skipped).length;
      const skipUsed = Array.isArray(attemptRow.lifelines_used) && attemptRow.lifelines_used.includes('skip');
      if (skippedCount > 1 || (skippedCount === 1 && !skipUsed)) {
        throw new Error('INVALID_SKIP: Only one question can be skipped, and only with the Skip lifeline.');
      }

      let score = 0;
      const breakdown = [];

      for (const q of questions) {
        const submitted = params.answers.find((a) => a.questionId === q.id);
        if (!submitted) {
          throw new Error(`MISSING_QUESTION_ANSWER: Question ${q.ordinal} was not answered.`);
        }

        let isCorrect = false;
        let selectedOptId = '';
        let selectedOptionIds: string[] | undefined;
        let correctOptionIds: string[] | undefined;
        let correctOrder: Array<{ id: string; ordinal: number; option_text: string }> | undefined;
        let submittedPayload: { ordered_option_ids: string[] } | null = null;
        const qType = q.question_type || 'multiple_choice';
        const correctOpt = q.options.find((opt) => opt.is_correct);

        if (submitted.skipped) {
          // Skipped: no answer row and no point.
          if (qType === 'sequence_order') {
            const sortedOpts = [...q.options].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
            correctOptionIds = sortedOpts.map((opt) => opt.id);
            correctOrder = sortedOpts.map((opt) => ({
              id: opt.id,
              ordinal: opt.ordinal ?? 0,
              option_text: opt.option_text,
            }));
            selectedOptionIds = [];
          }
        } else if (qType === 'sequence_order') {
          if (submitted.selectedOptionId !== undefined || !Array.isArray(submitted.orderedOptionIds)) {
            throw new Error(
              `INVALID_ANSWER_PAYLOAD: Question ${q.ordinal} (sequence_order) requires ordered_option_ids.`,
            );
          }
          const optionIdsSet = new Set(q.options.map((o) => o.id));
          if (submitted.orderedOptionIds.length !== q.options.length) {
            throw new Error(
              `INVALID_ANSWER_PAYLOAD: Question ${q.ordinal} requires exactly ${q.options.length} ordered option IDs.`,
            );
          }
          const uniqueSubmitted = new Set(submitted.orderedOptionIds);
          if (uniqueSubmitted.size !== submitted.orderedOptionIds.length) {
            throw new Error(
              `INVALID_OPTION_ID: Duplicate option IDs provided for question ${q.ordinal}.`,
            );
          }
          for (const optId of submitted.orderedOptionIds) {
            if (!optionIdsSet.has(optId)) {
              throw new Error(
                `INVALID_OPTION_ID: Option '${optId}' is not valid for question ${q.ordinal}.`,
              );
            }
          }
          const sortedOpts = [...q.options].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
          const expectedOrder = sortedOpts.map((opt) => opt.id);
          isCorrect = submitted.orderedOptionIds.every((id, idx) => id === expectedOrder[idx]);
          selectedOptionIds = [...submitted.orderedOptionIds];
          correctOptionIds = expectedOrder;
          correctOrder = sortedOpts.map((opt) => ({
            id: opt.id,
            ordinal: opt.ordinal ?? 0,
            option_text: opt.option_text,
          }));
          submittedPayload = { ordered_option_ids: selectedOptionIds };
        } else {
          if (
            submitted.orderedOptionIds !== undefined ||
            typeof submitted.selectedOptionId !== 'string' ||
            submitted.selectedOptionId.length === 0
          ) {
            throw new Error(
              `INVALID_ANSWER_PAYLOAD: Question ${q.ordinal} (${qType}) requires selected_option_id.`,
            );
          }
          const selectedOpt = q.options.find((opt) => opt.id === submitted.selectedOptionId);
          if (!selectedOpt) {
            throw new Error(
              `INVALID_OPTION_ID: Option '${submitted.selectedOptionId}' is not valid for question ${q.ordinal}.`,
            );
          }
          selectedOptId = selectedOpt.id;
          isCorrect = Boolean(selectedOpt.is_correct);
        }

        if (isCorrect) score += 1;

        // Save answer record
        if (selectedOptId || submittedPayload) {
          await client.query(
            `INSERT INTO cultural_quiz_attempt_answers (attempt_id, question_id, selected_option_id, submitted_payload, is_correct, answered_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [
              attemptRow.id,
              q.id,
              selectedOptId || null,
              submittedPayload ? JSON.stringify(submittedPayload) : null,
              isCorrect,
            ],
          );
        }

        breakdown.push({
          question_id: q.id,
          question_text: q.question_text,
          question_type: qType,
          selected_option_id: selectedOptId,
          correct_option_id: qType === 'sequence_order' ? '' : correctOpt?.id || '',
          ...(selectedOptionIds !== undefined ? { selected_option_ids: selectedOptionIds } : {}),
          ...(correctOptionIds !== undefined ? { correct_option_ids: correctOptionIds } : {}),
          ...(correctOrder !== undefined ? { correct_order: correctOrder } : {}),
          is_correct: isCorrect,
          explanation: q.explanation,
          source_url: q.source_url,
        });
      }

      const passed = score >= 4;
      const finalStatus = passed ? 'passed' : 'failed';

      // 4. Progression & XP Award logic
      let xpToAward = 0;
      let alreadyCompletedPrior = false;

      if (passed) {
        alreadyCompletedPrior = await this.repo.hasCompletedRewardScope(
          params.userId,
          attemptRow.reward_scope_id,
          client,
        );

        if (!alreadyCompletedPrior) {
          const version = await this.repo.findVersionById(attemptRow.version_id, client);
          // Plan 65: a reigning quiz_arcade_xp_boost perk raises passed-quiz XP.
          const quizBonus = await perkBonus(client, false, (perk) => perk.key === 'quiz_arcade_xp_boost');
          xpToAward = Math.round((version?.xp_reward ?? 25) * (1 + quizBonus.value));

          // Record progression event
          const progressionEventId = randomUUID();
          const recordedEvent = await this.progressionRepo.recordProgressionEvent(
            {
              id: progressionEventId,
              user_id: params.userId,
              track: 'explorer',
              delta: xpToAward,
              source_type: 'cultural_quiz',
              source_id: attemptRow.reward_scope_id,
              award_kind: 'xp',
              rule_version: 'v1',
              earned_at: new Date().toISOString(),
              is_test: false,
            },
            client,
          );

          if (recordedEvent) {
            // Update user progression totals atomically
            await this.progressionRepo.updateProgressionTotals(params.userId, { explorerXp: xpToAward }, client);

            // Record completion receipt
            await client.query(
              `INSERT INTO cultural_quiz_completions (user_id, reward_scope_id, progression_event_id, completed_at)
               VALUES ($1, $2, $3, NOW())
               ON CONFLICT (user_id, reward_scope_id) DO NOTHING`,
              [params.userId, attemptRow.reward_scope_id, progressionEventId],
            );

            // P11: quiz_aced (score == max score, first completion only)
            if (score === breakdown.length) {
              await runIsolatedProducer(client, '[social:producer] Failed to record quiz_aced activity:', async () => {
                const qzRes = await client.query(
                  `SELECT v.title, q.is_test
                     FROM cultural_quizzes q
                     LEFT JOIN cultural_quiz_versions v ON v.quiz_id = q.id AND v.version = q.current_version
                    WHERE q.id = $1`,
                  [attemptRow.quiz_id],
                );
                const qzTitle = qzRes.rows[0]?.title || 'Cultural Quiz';
                const qzIsTest = Boolean(qzRes.rows[0]?.is_test);
                await recordActivity(client, {
                  eventKey: `quiz_aced:${attemptRow.quiz_id}:${params.userId}`,
                  actorId: params.userId,
                  verb: 'quiz_aced',
                  subjectType: 'quiz',
                  subjectId: attemptRow.quiz_id,
                  subjectTitle: qzTitle,
                  subjectHref: `/quizzes/${attemptRow.quiz_id}`,
                  payload: { score, max: breakdown.length },
                  isTest: qzIsTest,
                });
              });
            }
          } else {
            // Idempotent duplicate: already recorded
            xpToAward = 0;
            alreadyCompletedPrior = true;
          }
        }
      }

      // 5. Update attempt row with final grade and arcade style score
      const { rows: updatedAttemptRows } = await client.query(
        `UPDATE cultural_quiz_attempts
         SET status = $1, score = $2, xp_awarded = $3, completed_at = NOW(), updated_at = NOW(),
             style_score = $5, streak_max = $6
         WHERE id = $4
         RETURNING *`,
        [finalStatus, score, xpToAward, attemptRow.id, Number(params.styleScore || 0), Number(params.streakMax || 0)],
      );

      const finalAttempt = (this.repo as any).mapAttempt(updatedAttemptRows[0]);

      let cooldownUntil: string | null = null;
      if (!passed) {
        const version = await this.repo.findVersionById(attemptRow.version_id, client);
        const cdHours = version?.cooldown_hours ?? 24;
        cooldownUntil = new Date(Date.now() + cdHours * 3600 * 1000).toISOString();
      }

      await client.query('COMMIT');

      return {
        attempt: finalAttempt,
        passed,
        score,
        total_questions: 5,
        xp_awarded: xpToAward,
        already_completed_prior: alreadyCompletedPrior,
        cooldown_until: cooldownUntil,
        breakdown,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // --- Admin Authoring & Lifecycle Operations ---

  async createQuizDraft(params: CreateQuizDraftParams): Promise<{ quiz: CulturalQuiz; version: CulturalQuizVersion }> {
    const pool = this.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const allowedSpotPhotoUrls = await fetchDestinationPhotoUrls(client, params.destinationId);
      validateQuizDraftQuestions(params.questions, allowedSpotPhotoUrls);

      const quizId = randomUUID();
      const versionId = randomUUID();
      const rewardScopeId = randomUUID();

      const { rows: _quizRows } = await client.query(
        `INSERT INTO cultural_quizzes (id, destination_id, reward_scope_id, status, current_version, created_by, is_test)
         VALUES ($1, $2, $3, 'draft', 1, $4, $5)
         RETURNING *`,
        [quizId, params.destinationId, rewardScopeId, params.adminUserId, Boolean(params.isTest)],
      );

      const { rows: _vRows } = await client.query(
        `INSERT INTO cultural_quiz_versions (
           id, quiz_id, version, title, description, language, radius_meters,
           xp_reward, time_limit_minutes, cooldown_hours, created_by, published_at,
           host_lines, theme
         ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, $12)
         RETURNING *`,
        [
          versionId,
          quizId,
          params.title,
          params.description,
          params.language || 'en',
          params.radiusMeters || 200,
          params.xpReward || 25,
          params.timeLimitMinutes || 30,
          params.cooldownHours || 24,
          params.adminUserId,
          params.hostLines ? JSON.stringify(params.hostLines) : null,
          params.theme || 'crt',
        ],
      );

      for (const q of params.questions) {
        const qId = randomUUID();
        await client.query(
          `INSERT INTO cultural_quiz_questions (
             id, version_id, ordinal, question_text, explanation, source_url,
             question_type, media_url, hint, round, answer_payload
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            qId,
            versionId,
            q.ordinal,
            q.questionText,
            q.explanation,
            q.sourceUrl || null,
            q.questionType || 'multiple_choice',
            q.mediaUrl || null,
            q.hint || null,
            q.round || 'main',
            q.answerPayload ? JSON.stringify(q.answerPayload) : null,
          ],
        );

        for (const opt of q.options) {
          const optId = randomUUID();
          await client.query(
            `INSERT INTO cultural_quiz_options (id, question_id, ordinal, option_text, is_correct)
             VALUES ($1, $2, $3, $4, $5)`,
            [optId, qId, opt.ordinal, opt.optionText, opt.isCorrect],
          );
        }
      }

      await client.query('COMMIT');
      const createdQuiz = await this.repo.findQuizById(quizId);
      const createdVersion = await this.repo.findVersion(quizId, 1);
      return {
        quiz: createdQuiz!,
        version: createdVersion!,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getQuizForAdmin(quizId: string): Promise<{
    quiz: CulturalQuiz;
    version: CulturalQuizVersion;
    destination: { id: string; name: string; municipality: string; gps_lat: number; gps_lng: number };
    questions: CulturalQuizQuestion[];
  } | null> {
    const quiz = await this.repo.findQuizById(quizId);
    if (!quiz) return null;

    const version = await this.repo.findVersion(quiz.id, quiz.current_version);
    if (!version) return null;

    const questions = await this.repo.findQuestionsWithOptions(version.id);

    const pool = this.getPool();
    const { rows } = await pool.query(`SELECT id, name, municipality, gps_lat, gps_lng FROM spots WHERE id = $1`, [
      quiz.destination_id,
    ]);
    if (!rows.length) return null;

    return {
      quiz,
      version,
      questions,
      destination: {
        id: rows[0].id,
        name: rows[0].name,
        municipality: rows[0].municipality,
        gps_lat: Number(rows[0].gps_lat),
        gps_lng: Number(rows[0].gps_lng),
      },
    };
  }

  async updateQuizDraft(
    quizId: string,
    params: CreateQuizDraftParams,
  ): Promise<{
    quiz: CulturalQuiz;
    version: CulturalQuizVersion;
    destination: { id: string; name: string; municipality: string; gps_lat: number; gps_lng: number };
    questions: CulturalQuizQuestion[];
  }> {
    const pool = this.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const allowedSpotPhotoUrls = await fetchDestinationPhotoUrls(client, params.destinationId);
      validateQuizDraftQuestions(params.questions, allowedSpotPhotoUrls);

      const { rows: quizRows } = await client.query('SELECT * FROM cultural_quizzes WHERE id = $1 FOR UPDATE', [
        quizId,
      ]);
      if (!quizRows.length) {
        throw new Error('QUIZ_NOT_FOUND: Cultural quiz does not exist.');
      }
      const quiz = quizRows[0];
      if (quiz.status !== 'draft') {
        throw new Error(
          'QUIZ_IMMUTABLE: Published quiz versions are immutable. Pause or archive this quiz, or create a new draft.',
        );
      }

      const version = await this.repo.findVersion(quiz.id, Number(quiz.current_version), client);
      if (!version) {
        throw new Error('QUIZ_VERSION_NOT_FOUND: Current version is missing.');
      }
      if (version.published_at) {
        throw new Error('QUIZ_IMMUTABLE: A published version can never be edited in place.');
      }

      await client.query(
        `UPDATE cultural_quizzes SET destination_id = $1, is_test = $2, updated_at = NOW() WHERE id = $3`,
        [params.destinationId, params.isTest === undefined ? Boolean(quiz.is_test) : Boolean(params.isTest), quiz.id],
      );

      await client.query(
        `UPDATE cultural_quiz_versions
         SET title = $1, description = $2, language = $3, radius_meters = $4,
             xp_reward = $5, time_limit_minutes = $6, cooldown_hours = $7, created_by = $8,
             host_lines = $10, theme = $11
         WHERE id = $9`,
        [
          params.title,
          params.description,
          params.language || version.language,
          params.radiusMeters || version.radius_meters,
          params.xpReward || version.xp_reward,
          params.timeLimitMinutes || version.time_limit_minutes,
          params.cooldownHours || version.cooldown_hours,
          params.adminUserId,
          version.id,
          params.hostLines !== undefined
            ? JSON.stringify(params.hostLines)
            : version.host_lines
              ? JSON.stringify(version.host_lines)
              : null,
          params.theme || version.theme || 'crt',
        ],
      );

      // Draft-only replacement: no attempts can exist for an unpublished quiz.
      await client.query('DELETE FROM cultural_quiz_questions WHERE version_id = $1', [version.id]);

      for (const q of params.questions) {
        const qId = randomUUID();
        await client.query(
          `INSERT INTO cultural_quiz_questions (
             id, version_id, ordinal, question_text, explanation, source_url,
             question_type, media_url, hint, round, answer_payload
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            qId,
            version.id,
            q.ordinal,
            q.questionText,
            q.explanation,
            q.sourceUrl || null,
            q.questionType || 'multiple_choice',
            q.mediaUrl || null,
            q.hint || null,
            q.round || 'main',
            q.answerPayload ? JSON.stringify(q.answerPayload) : null,
          ],
        );

        for (const opt of q.options) {
          const optId = randomUUID();
          await client.query(
            `INSERT INTO cultural_quiz_options (id, question_id, ordinal, option_text, is_correct)
             VALUES ($1, $2, $3, $4, $5)`,
            [optId, qId, opt.ordinal, opt.optionText, opt.isCorrect],
          );
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const detail = await this.getQuizForAdmin(quizId);
    if (!detail) throw new Error('QUIZ_NOT_FOUND: Cultural quiz does not exist.');
    return detail;
  }

  async publishQuiz(quizId: string): Promise<CulturalQuiz> {
    const pool = this.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const quiz = await this.repo.findQuizById(quizId, client);
      if (!quiz) throw new Error('Cultural quiz not found.');

      const version = await this.repo.findVersion(quiz.id, quiz.current_version, client);
      if (!version) throw new Error('Quiz version not found.');

      const questions = await this.repo.findQuestionsWithOptions(version.id, client);
      if (questions.length !== 5) {
        throw new Error('Cannot publish quiz: exactly 5 questions are required.');
      }
      for (const q of questions) {
        const qType = q.question_type || 'multiple_choice';
        if (qType === 'true_false') {
          if (q.options.length !== 2) {
            throw new Error(`Question ${q.ordinal} (true_false) must have exactly 2 options.`);
          }
          const correctCount = q.options.filter((o) => o.is_correct).length;
          if (correctCount !== 1) {
            throw new Error(`Question ${q.ordinal} must have exactly one correct option.`);
          }
        } else if (qType === 'sequence_order') {
          if (q.options.length < 3 || q.options.length > 4) {
            throw new Error(`Question ${q.ordinal} (sequence_order) must have 3 to 4 options.`);
          }
        } else {
          if (q.options.length !== 4) {
            throw new Error(`Question ${q.ordinal} does not have 4 options.`);
          }
          const correctCount = q.options.filter((o) => o.is_correct).length;
          if (correctCount !== 1) {
            throw new Error(`Question ${q.ordinal} must have exactly one correct option.`);
          }
          if (qType === 'photo_clue' && !q.media_url) {
            throw new Error(`Question ${q.ordinal} (photo_clue) requires a destination photo.`);
          }
        }
      }

      await client.query(`UPDATE cultural_quiz_versions SET published_at = NOW() WHERE id = $1`, [version.id]);

      const { rows: _rows } = await client.query(
        `UPDATE cultural_quizzes SET status = 'published', updated_at = NOW() WHERE id = $1 RETURNING *`,
        [quiz.id],
      );

      await client.query('COMMIT');
      const updated = await this.repo.findQuizById(quiz.id);
      return updated!;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async setQuizStatus(quizId: string, status: 'published' | 'paused' | 'archived'): Promise<CulturalQuiz> {
    const pool = this.getPool();
    const { rows } = await pool.query(
      `UPDATE cultural_quizzes SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, quizId],
    );
    if (!rows.length) throw new Error('Cultural quiz not found.');
    const updated = await this.repo.findQuizById(quizId);
    return updated!;
  }

  async revokeQuiz(quizId: string, _reason: string): Promise<void> {
    const pool = this.getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE cultural_quizzes SET status = 'archived', updated_at = NOW() WHERE id = $1`, [quizId]);
      // Invalidate active in-progress attempts
      await client.query(
        `UPDATE cultural_quiz_attempts SET status = 'abandoned', updated_at = NOW() WHERE quiz_id = $1 AND status = 'in_progress'`,
        [quizId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
