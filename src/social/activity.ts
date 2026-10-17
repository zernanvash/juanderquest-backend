import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { enqueueFriendActivityPush } from '../push/enqueue.js';

export type ActivityVerb =
  | 'quest_completed'
  | 'trail_completed'
  | 'town_completed'
  | 'badge_earned'
  | 'level_up'
  | 'streak_milestone'
  | 'rank_top10'
  | 'weekly_champion'
  | 'spot_posted'
  | 'first_photo'
  | 'juanchoice_voted'
  | 'quiz_aced';

export type ActivitySubjectType =
  | 'quest'
  | 'trail'
  | 'town'
  | 'badge'
  | 'level'
  | 'streak'
  | 'rank'
  | 'spot'
  | 'campaign'
  | 'quiz';

export interface RecordActivityInput {
  eventKey: string;
  actorId: string;
  verb: ActivityVerb;
  subjectType: ActivitySubjectType | string;
  subjectId: string;
  subjectTitle: string;
  subjectHref: string;
  municipality?: string | null;
  payload?: Record<string, unknown>;
  isTest: boolean;
}

export const FRIEND_PUSH_VERBS: readonly ActivityVerb[] = [
  'quest_completed',
  'trail_completed',
  'town_completed',
  'weekly_champion',
];

export interface Queryable {
  query(text: string, params?: any[]): Promise<any>;
}

/**
 * Inserts a new social activity with ON CONFLICT (event_key) DO NOTHING.
 * Returns the activity id, or null if the event was already recorded.
 * Social features require PostgreSQL; returns null if in-memory fallback.
 */
export async function recordActivity(
  client: Queryable | null | undefined,
  input: RecordActivityInput,
): Promise<string | null> {
  const queryable = client ?? getPool();
  if (!queryable) return null;

  if (!input.subjectHref.startsWith('/') || input.subjectHref.startsWith('//')) {
    throw new Error(`INVALID_SUBJECT_HREF: subjectHref must start with single '/': ${input.subjectHref}`);
  }

  const subjectTitle = input.subjectTitle.trim().slice(0, 200);
  const id = `act_${randomUUID()}`;

  const res = await queryable.query(
    `INSERT INTO social_activities (
      id, event_key, actor_id, verb, subject_type, subject_id,
      subject_title, subject_href, municipality, payload, is_test
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (event_key) DO NOTHING
    RETURNING id, actor_id, verb, subject_title, is_test`,
    [
      id,
      input.eventKey,
      input.actorId,
      input.verb,
      input.subjectType,
      input.subjectId,
      subjectTitle,
      input.subjectHref,
      input.municipality ?? null,
      JSON.stringify(input.payload ?? {}),
      Boolean(input.isTest),
    ],
  );

  if (!res.rows.length || res.rows[0].id !== id) {
    return null;
  }

  const inserted = res.rows[0];

  if (FRIEND_PUSH_VERBS.includes(input.verb)) {
    try {
      await enqueueFriendActivityPush(queryable, {
        id: inserted.id,
        actor_id: inserted.actor_id,
        verb: inserted.verb,
        subject_title: inserted.subject_title,
        is_test: inserted.is_test,
      });
    } catch (err) {
      console.error('[social:activity] Failed to enqueue friend activity push:', err);
    }
  }

  return inserted.id;
}
