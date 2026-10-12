import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import {
  CulturalQuiz,
  CulturalQuizVersion,
  CulturalQuizQuestion,
  CulturalQuizOption,
  CulturalQuizAttempt,
  CulturalQuizAttemptAnswer,
  CulturalQuizStatus,
  CulturalQuizAttemptStatus,
} from './types.js';

type QueryExecutor = Pool | PoolClient;

export class CulturalQuizRepository {
  constructor(private readonly pool?: Pool) {}

  private getExecutor(client?: QueryExecutor): QueryExecutor | null {
    return client ?? this.pool ?? getPool();
  }

  async findQuizById(id: string, client?: QueryExecutor): Promise<CulturalQuiz | null> {
    const executor = this.getExecutor(client);
    if (!executor) return null;

    const { rows } = await executor.query(
      `SELECT * FROM cultural_quizzes WHERE id = $1`,
      [id]
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id,
      destination_id: r.destination_id,
      reward_scope_id: r.reward_scope_id,
      status: r.status as CulturalQuizStatus,
      current_version: Number(r.current_version),
      created_by: r.created_by,
      is_test: Boolean(r.is_test),
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    };
  }

  async findQuizByDestinationId(destinationId: string, client?: QueryExecutor): Promise<CulturalQuiz | null> {
    const executor = this.getExecutor(client);
    if (!executor) return null;

    const { rows } = await executor.query(
      `SELECT * FROM cultural_quizzes WHERE destination_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [destinationId]
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id,
      destination_id: r.destination_id,
      reward_scope_id: r.reward_scope_id,
      status: r.status as CulturalQuizStatus,
      current_version: Number(r.current_version),
      created_by: r.created_by,
      is_test: Boolean(r.is_test),
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    };
  }

  async findVersion(quizId: string, versionNumber: number, client?: QueryExecutor): Promise<CulturalQuizVersion | null> {
    const executor = this.getExecutor(client);
    if (!executor) return null;

    const { rows } = await executor.query(
      `SELECT * FROM cultural_quiz_versions WHERE quiz_id = $1 AND version = $2`,
      [quizId, versionNumber]
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id,
      quiz_id: r.quiz_id,
      version: Number(r.version),
      title: r.title,
      description: r.description,
      language: r.language,
      radius_meters: Number(r.radius_meters),
      xp_reward: Number(r.xp_reward),
      time_limit_minutes: Number(r.time_limit_minutes),
      cooldown_hours: Number(r.cooldown_hours),
      created_by: r.created_by,
      published_at: r.published_at ? new Date(r.published_at).toISOString() : null,
      created_at: new Date(r.created_at).toISOString(),
    };
  }

  async findQuestionsWithOptions(versionId: string, client?: QueryExecutor): Promise<CulturalQuizQuestion[]> {
    const executor = this.getExecutor(client);
    if (!executor) return [];

    const { rows: qRows } = await executor.query(
      `SELECT * FROM cultural_quiz_questions WHERE version_id = $1 ORDER BY ordinal ASC`,
      [versionId]
    );
    if (!qRows.length) return [];

    const questionIds = qRows.map((q) => q.id);
    const placeholders = questionIds.map((_, i) => `$${i + 1}`).join(', ');
    const { rows: optRows } = await executor.query(
      `SELECT * FROM cultural_quiz_options WHERE question_id IN (${placeholders}) ORDER BY ordinal ASC`,
      questionIds
    );

    const optionsByQ = new Map<string, CulturalQuizOption[]>();
    for (const opt of optRows) {
      const list = optionsByQ.get(opt.question_id) ?? [];
      list.push({
        id: opt.id,
        question_id: opt.question_id,
        ordinal: Number(opt.ordinal),
        option_text: opt.option_text,
        is_correct: Boolean(opt.is_correct),
        created_at: new Date(opt.created_at).toISOString(),
      });
      optionsByQ.set(opt.question_id, list);
    }

    return qRows.map((q) => ({
      id: q.id,
      version_id: q.version_id,
      ordinal: Number(q.ordinal),
      question_text: q.question_text,
      explanation: q.explanation,
      source_url: q.source_url,
      created_at: new Date(q.created_at).toISOString(),
      options: optionsByQ.get(q.id) ?? [],
    }));
  }

  async findActiveAttempt(quizId: string, userId: string, client?: QueryExecutor): Promise<CulturalQuizAttempt | null> {
    const executor = this.getExecutor(client);
    if (!executor) return null;

    const { rows } = await executor.query(
      `SELECT * FROM cultural_quiz_attempts 
       WHERE quiz_id = $1 AND user_id = $2 AND status = 'in_progress'
       ORDER BY started_at DESC LIMIT 1`,
      [quizId, userId]
    );
    if (!rows.length) return null;
    return this.mapAttempt(rows[0]);
  }

  async findAttemptById(attemptId: string, client?: QueryExecutor): Promise<CulturalQuizAttempt | null> {
    const executor = this.getExecutor(client);
    if (!executor) return null;

    const { rows } = await executor.query(
      `SELECT * FROM cultural_quiz_attempts WHERE id = $1`,
      [attemptId]
    );
    if (!rows.length) return null;
    return this.mapAttempt(rows[0]);
  }

  async findLastFailedAttempt(quizId: string, userId: string, client?: QueryExecutor): Promise<CulturalQuizAttempt | null> {
    const executor = this.getExecutor(client);
    if (!executor) return null;

    const { rows } = await executor.query(
      `SELECT * FROM cultural_quiz_attempts 
       WHERE quiz_id = $1 AND user_id = $2 AND status = 'failed'
       ORDER BY completed_at DESC LIMIT 1`,
      [quizId, userId]
    );
    if (!rows.length) return null;
    return this.mapAttempt(rows[0]);
  }

  async hasCompletedRewardScope(userId: string, rewardScopeId: string, client?: QueryExecutor): Promise<boolean> {
    const executor = this.getExecutor(client);
    if (!executor) return false;

    const { rows } = await executor.query(
      `SELECT 1 FROM cultural_quiz_completions WHERE user_id = $1 AND reward_scope_id = $2`,
      [userId, rewardScopeId]
    );
    return rows.length > 0;
  }

  async findAttemptAnswers(attemptId: string, client?: QueryExecutor): Promise<CulturalQuizAttemptAnswer[]> {
    const executor = this.getExecutor(client);
    if (!executor) return [];

    const { rows } = await executor.query(
      `SELECT * FROM cultural_quiz_attempt_answers WHERE attempt_id = $1 ORDER BY answered_at ASC`,
      [attemptId]
    );
    return rows.map((r) => ({
      attempt_id: r.attempt_id,
      question_id: r.question_id,
      selected_option_id: r.selected_option_id,
      is_correct: Boolean(r.is_correct),
      answered_at: new Date(r.answered_at).toISOString(),
    }));
  }

  async listUserHistory(userId: string, limit = 50, client?: QueryExecutor): Promise<CulturalQuizAttempt[]> {
    const executor = this.getExecutor(client);
    if (!executor) return [];

    const { rows } = await executor.query(
      `SELECT * FROM cultural_quiz_attempts 
       WHERE user_id = $1 AND status IN ('passed', 'failed', 'expired')
       ORDER BY completed_at DESC NULLS LAST, started_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return rows.map((r) => this.mapAttempt(r));
  }

  async listPublishedQuizzes(client?: QueryExecutor): Promise<Array<{ quiz: CulturalQuiz; version: CulturalQuizVersion; destination: { id: string; name: string; municipality: string; gps_lat: number; gps_lng: number } }>> {
    const executor = this.getExecutor(client);
    if (!executor) return [];

    const { rows } = await executor.query(
      `SELECT q.*, v.id as v_id, v.version, v.title, v.description, v.language, v.radius_meters, v.xp_reward, v.time_limit_minutes, v.cooldown_hours, v.published_at, v.created_at as v_created_at,
              s.name as spot_name, s.municipality as spot_municipality, s.gps_lat, s.gps_lng
       FROM cultural_quizzes q
       JOIN cultural_quiz_versions v ON v.quiz_id = q.id AND v.version = q.current_version
       JOIN spots s ON s.id = q.destination_id
       WHERE q.status = 'published'`
    );

    return rows.map((r) => ({
      quiz: {
        id: r.id,
        destination_id: r.destination_id,
        reward_scope_id: r.reward_scope_id,
        status: r.status as CulturalQuizStatus,
        current_version: Number(r.current_version),
        created_by: r.created_by,
        is_test: Boolean(r.is_test),
        created_at: new Date(r.created_at).toISOString(),
        updated_at: new Date(r.updated_at).toISOString(),
      },
      version: {
        id: r.v_id,
        quiz_id: r.id,
        version: Number(r.version),
        title: r.title,
        description: r.description,
        language: r.language,
        radius_meters: Number(r.radius_meters),
        xp_reward: Number(r.xp_reward),
        time_limit_minutes: Number(r.time_limit_minutes),
        cooldown_hours: Number(r.cooldown_hours),
        created_by: r.created_by,
        published_at: r.published_at ? new Date(r.published_at).toISOString() : null,
        created_at: new Date(r.v_created_at).toISOString(),
      },
      destination: {
        id: r.destination_id,
        name: r.spot_name,
        municipality: r.spot_municipality,
        gps_lat: Number(r.gps_lat),
        gps_lng: Number(r.gps_lng),
      },
    }));
  }

  async listAllQuizzesForAdmin(client?: QueryExecutor): Promise<Array<{ quiz: CulturalQuiz; version: CulturalQuizVersion; destination_name: string }>> {
    const executor = this.getExecutor(client);
    if (!executor) return [];

    const { rows } = await executor.query(
      `SELECT q.*, v.id as v_id, v.version, v.title, v.description, v.language, v.radius_meters, v.xp_reward, v.time_limit_minutes, v.cooldown_hours, v.published_at, v.created_at as v_created_at,
              s.name as spot_name
       FROM cultural_quizzes q
       JOIN cultural_quiz_versions v ON v.quiz_id = q.id AND v.version = q.current_version
       JOIN spots s ON s.id = q.destination_id
       ORDER BY q.created_at DESC`
    );

    return rows.map((r) => ({
      quiz: {
        id: r.id,
        destination_id: r.destination_id,
        reward_scope_id: r.reward_scope_id,
        status: r.status as CulturalQuizStatus,
        current_version: Number(r.current_version),
        created_by: r.created_by,
        is_test: Boolean(r.is_test),
        created_at: new Date(r.created_at).toISOString(),
        updated_at: new Date(r.updated_at).toISOString(),
      },
      version: {
        id: r.v_id,
        quiz_id: r.id,
        version: Number(r.version),
        title: r.title,
        description: r.description,
        language: r.language,
        radius_meters: Number(r.radius_meters),
        xp_reward: Number(r.xp_reward),
        time_limit_minutes: Number(r.time_limit_minutes),
        cooldown_hours: Number(r.cooldown_hours),
        created_by: r.created_by,
        published_at: r.published_at ? new Date(r.published_at).toISOString() : null,
        created_at: new Date(r.v_created_at).toISOString(),
      },
      destination_name: r.spot_name,
    }));
  }

  private mapAttempt(r: any): CulturalQuizAttempt {
    return {
      id: r.id,
      quiz_id: r.quiz_id,
      version_id: r.version_id,
      reward_scope_id: r.reward_scope_id,
      user_id: r.user_id,
      status: r.status as CulturalQuizAttemptStatus,
      started_at: new Date(r.started_at).toISOString(),
      expires_at: new Date(r.expires_at).toISOString(),
      completed_at: r.completed_at ? new Date(r.completed_at).toISOString() : null,
      score: r.score !== null ? Number(r.score) : null,
      total_questions: Number(r.total_questions),
      xp_awarded: Number(r.xp_awarded || 0),
      location_validated: Boolean(r.location_validated),
      distance_meters: r.distance_meters !== null ? Number(r.distance_meters) : null,
      idempotency_key: r.idempotency_key,
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    };
  }
}
