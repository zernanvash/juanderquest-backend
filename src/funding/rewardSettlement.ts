import { db } from '../db/index.js';
import { governanceStore } from '../routes/proposals.js';
import type { PoolClient } from 'pg';
import { settleFundingHold } from './holds.js';
import type { CommittedLedgerGroup } from './ledger.js';
import { FundingError } from './transaction.js';

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
    if (funded) return funded;
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
    return { awardedPoints: rewardPoints, newPoints: Number(newPoints), governanceResult };
  }

  const newPoints = db.applyDemoPointsDelta(userId, rewardPoints);
  const governanceResult = rewardPoints > 0
    ? await governanceStore.creditQuestReward(userId, questId, referenceId, rewardPoints, actorId)
    : null;
  return { awardedPoints: rewardPoints, newPoints, governanceResult };
}
