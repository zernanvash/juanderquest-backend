import { db } from '../db/index.js';
import { governanceStore } from '../routes/proposals.js';
import type { PoolClient } from 'pg';
import { settleFundingHold } from './holds.js';
import type { CommittedLedgerGroup } from './ledger.js';
import { FundingError } from './transaction.js';

import { recordActivity } from '../social/activity.js';

export interface RewardSettlementClient {
  query(text: string, params?: any[]): Promise<any>;
}

export interface SettleRewardInput {
  userId: string;
  questId: string;
  referenceId: string;
  actorId: string;
  rewardPoints: number;
  client?: RewardSettlementClient;
}

export interface SettleRewardResult {
  awardedPoints: number;
  newPoints: number;
  governanceResult?: Awaited<ReturnType<typeof governanceStore.creditQuestReward>>;
  fundedGroups?: CommittedLedgerGroup[];
  fundedAttemptId?: string;
  voucherPerk?: { redemption_id: string; code: string; title: string };
}

async function recordQuestCompletionSocialActivities(
  client: RewardSettlementClient,
  userId: string,
  questId: string,
  awardedPoints: number,
) {
  try {
    const qRes = await client.query(
      `SELECT q.title, q.location_name, q.is_test,
              COALESCE(s.municipality, q.location_name) AS municipality
         FROM quests q
         LEFT JOIN reviewed_quest_spot_bindings b ON b.quest_id = q.id AND b.status = 'active'
         LEFT JOIN spots s ON s.id = b.spot_id
        WHERE q.id = $1
        LIMIT 1`,
      [questId],
    );
    if (!qRes.rows.length) return;
    const questRow = qRes.rows[0];

    const uRes = await client.query('SELECT is_test FROM users WHERE id = $1', [userId]);
    const userIsTest = uRes.rows[0]?.is_test ?? questRow.is_test;

    // P1: quest_completed
    await recordActivity(client, {
      eventKey: `quest_completed:${userId}:${questId}`,
      actorId: userId,
      verb: 'quest_completed',
      subjectType: 'quest',
      subjectId: questId,
      subjectTitle: questRow.title,
      subjectHref: `/quests/${questId}`,
      municipality: questRow.municipality || null,
      payload: { points: awardedPoints },
      isTest: Boolean(userIsTest),
    });

    // P2: town_completed
    const municipality = questRow.municipality;
    if (municipality) {
      const muniSlug = municipality.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const totalQuestsRes = await client.query(
        `SELECT COUNT(DISTINCT q.id)::int AS count
           FROM quests q
           LEFT JOIN reviewed_quest_spot_bindings b ON b.quest_id = q.id AND b.status = 'active'
           LEFT JOIN spots s ON s.id = b.spot_id
          WHERE q.is_active = TRUE
            AND q.status = 'published'
            AND q.is_test = $1
            AND COALESCE(s.municipality, q.location_name) = $2`,
        [Boolean(userIsTest), municipality],
      );
      const totalMuniQuests = Number(totalQuestsRes.rows[0]?.count || 0);

      if (totalMuniQuests >= 2) {
        const userQuestsRes = await client.query(
          `SELECT COUNT(DISTINCT q.id)::int AS count
             FROM quests q
             LEFT JOIN reviewed_quest_spot_bindings b ON b.quest_id = q.id AND b.status = 'active'
             LEFT JOIN spots s ON s.id = b.spot_id
            WHERE q.is_active = TRUE
              AND q.status = 'published'
              AND q.is_test = $1
              AND COALESCE(s.municipality, q.location_name) = $2
              AND (
                EXISTS (SELECT 1 FROM submissions sub WHERE sub.user_id = $3 AND sub.quest_id = q.id AND sub.status = 'approved')
                OR EXISTS (SELECT 1 FROM quest_attempts qa WHERE qa.user_id = $3 AND qa.quest_id = q.id AND qa.status = 'completed')
              )`,
          [Boolean(userIsTest), municipality, userId],
        );
        const userCompletedCount = Number(userQuestsRes.rows[0]?.count || 0);

        if (userCompletedCount === totalMuniQuests) {
          await recordActivity(client, {
            eventKey: `town_completed:${userId}:${muniSlug}`,
            actorId: userId,
            verb: 'town_completed',
            subjectType: 'town',
            subjectId: muniSlug,
            subjectTitle: municipality,
            subjectHref: `/map?area=${muniSlug}`,
            municipality,
            payload: { quests: totalMuniQuests },
            isTest: Boolean(userIsTest),
          });
        }
      }
    }
  } catch (err) {
    console.error('[social:producer] Failed to record quest/town completion activity:', err);
  }
}

/**
 * The only reward entry point for approved quest proofs and progressive
 * attempts. Funding-plan settlement is dispatched here as that ledger ships;
 * legacy quests continue to use the existing issuance account.
 */
export async function settleReward(input: SettleRewardInput): Promise<SettleRewardResult> {
  const { userId, questId, referenceId, actorId, rewardPoints, client } = input;
  if (!Number.isSafeInteger(rewardPoints) || rewardPoints < 0) throw new Error('INVALID_QUEST_REWARD');

  if (client) {
    const funded = await settleFundingHold(client as PoolClient, userId, questId, referenceId, actorId);
    let result: SettleRewardResult;
    if (funded) {
      result = funded;
    } else {
      const requirement = await client.query('SELECT funding_required FROM quests WHERE id=$1', [questId]);
      if (requirement.rows[0]?.funding_required) throw new FundingError('FUNDED_ATTEMPT_REQUIRED', 409, 'A reserved funded reward is required.');
      const balance = await client.query(
        'UPDATE users SET demo_points = demo_points + ($2)::int, updated_at = NOW() WHERE id = $1 RETURNING demo_points',
        [userId, rewardPoints],
      );
      const newPoints = balance.rows[0]?.demo_points;
      if (newPoints === undefined) throw new Error('USER_NOT_FOUND');
      const governanceResult = rewardPoints > 0
        ? await governanceStore.creditQuestReward(userId, questId, referenceId, rewardPoints, actorId, client)
        : null;
      result = { awardedPoints: rewardPoints, newPoints: Number(newPoints), governanceResult };
    }

    await recordQuestCompletionSocialActivities(client, userId, questId, result.awardedPoints);
    return result;
  }

  const newPoints = db.applyDemoPointsDelta(userId, rewardPoints);
  const governanceResult = rewardPoints > 0
    ? await governanceStore.creditQuestReward(userId, questId, referenceId, rewardPoints, actorId)
    : null;
  return { awardedPoints: rewardPoints, newPoints, governanceResult };
}
