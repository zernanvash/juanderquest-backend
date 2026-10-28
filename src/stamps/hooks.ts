import type { Pool } from 'pg';
import { recordMissionEvent } from './service.js';

async function safeHook<T>(label: string, work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    console.error(`[stamps] ${label}`, error);
    return null;
  }
}

export interface PlazaCheerHookInput {
  viewerId: string;
  activityOwnerId: string;
  activityId: string;
  now?: Date;
}

/** Cheering your own Plaza post never advances a mission or awards stamps. */
export async function handlePlazaCheer(pool: Pool | null, input: PlazaCheerHookInput) {
  if (!pool) return null;
  if (input.viewerId === input.activityOwnerId) return { completed: false, reason: 'self_content' as const };
  return safeHook('[stamps] cheer mission failed', () => recordMissionEvent(pool, input.viewerId, 'cheer_post', {
    now: input.now,
    sourceKey: `cheer:${input.activityId}:${input.viewerId}`,
  }));
}

export interface QuestStepHookInput {
  userId: string;
  questId: string;
  evidenceId: string;
  now?: Date;
}

/** Playing a quest you authored never advances a mission or awards stamps. */
export async function handleQuestStepVerified(pool: Pool | null, input: QuestStepHookInput) {
  if (!pool) return null;
  return safeHook('[stamps] quest step mission failed', async () => {
    const quest = await pool.query('SELECT author_id FROM quests WHERE id = $1', [input.questId]);
    if (quest.rows[0]?.author_id === input.userId) {
      return { completed: false, reason: 'self_content' as const };
    }
    return recordMissionEvent(pool, input.userId, 'quest_step', {
      now: input.now,
      sourceKey: `quest_step:${input.evidenceId}`,
    });
  });
}

export interface SpotInteractionHookInput {
  userId: string;
  spotId: string;
  type: 'view' | 'visit' | 'directions' | 'helpful' | string;
  now?: Date;
}

/**
 * Checking in at or reading a destination you created never advances a mission
 * or awards stamps. Other interaction types are ignored.
 */
export async function handleSpotInteraction(pool: Pool | null, input: SpotInteractionHookInput) {
  if (!pool) return null;
  const kind = input.type === 'visit' ? 'check_in' : input.type === 'view' ? 'read_story' : null;
  if (!kind) return null;
  return safeHook('[stamps] spot mission failed', async () => {
    const spot = await pool.query('SELECT created_by FROM spots WHERE id = $1', [input.spotId]);
    if (spot.rows[0]?.created_by === input.userId) {
      return { completed: false, reason: 'self_content' as const };
    }
    return recordMissionEvent(pool, input.userId, kind, {
      now: input.now,
      sourceKey: `spot_${input.type}:${input.spotId}:${input.userId}`,
    });
  });
}

export interface QotdAnsweredHookInput {
  userId: string;
  date: string;
  now?: Date;
}

export async function handleQotdAnswered(pool: Pool | null, input: QotdAnsweredHookInput) {
  if (!pool) return null;
  return safeHook('[stamps] qotd mission failed', () => recordMissionEvent(pool, input.userId, 'qotd', {
    now: input.now,
    sourceKey: `qotd:${input.date}`,
  }));
}
