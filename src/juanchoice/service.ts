import { createHash, randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { progressionRepo } from '../progression/repository.js';
import { evaluateFinalizedCampaignRetention } from '../progression/retention.js';
import { evaluateCandidatePromotionEligibility } from './promotion-safety.js';
import { env, extractDatabaseName, isPresentationDatabaseName, UUID_V4_REGEX } from '../config/env.js';

export class JuanChoiceError extends Error {
  constructor(public readonly code: string, public readonly status: number, message = code) { super(message); }
}

function pool() {
  const result = getPool();
  if (!result) throw new JuanChoiceError('DATABASE_OUTAGE', 503);
  return result;
}

async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    const committed = await client.query('COMMIT');
    if (committed.command !== 'COMMIT') throw new JuanChoiceError('COMMIT_FAILED', 503);
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

const policyVersion = 'juanchoice-pilot-v1';
const supporterRuleVersion = 'juanchoice-supporter-v1';
const supporterExplorerXp = 300;

async function assertPresentationCampaignAccess(
  client: PoolClient,
  campaignId: string,
  campaign: { is_test: boolean; series_key: string | null; round_number: number | null; counts_for_streak: boolean } | null
): Promise<void> {
  if (!env.JUANCHOICE_PRESENTATION_MODE) return;
  if (campaignId.toLowerCase() !== env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID.toLowerCase() || !campaign ||
      Boolean(campaign.is_test) || campaign.series_key != null || campaign.round_number != null ||
      campaign.counts_for_streak !== false) {
    throw new JuanChoiceError('CAMPAIGN_NOT_FOUND', 404);
  }
  const databaseName = (await client.query('SELECT current_database() AS name')).rows[0]?.name;
  if (databaseName !== env.JUANCHOICE_PRESENTATION_DB_NAME ||
      !isPresentationDatabaseName(databaseName, env.NODE_ENV) ||
      extractDatabaseName(env.DATABASE_URL) !== databaseName) {
    throw new JuanChoiceError('PRESENTATION_DATABASE_MISMATCH', 503);
  }
  const scheduled = await client.query(
    'SELECT 1 FROM juanchoice_schedule_periods WHERE campaign_id = $1 LIMIT 1', [campaignId]
  );
  if (scheduled.rowCount) throw new JuanChoiceError('CAMPAIGN_NOT_FOUND', 404);
}

export interface VoterEligibilityInput {
  actorCreatedAt: Date;
  actorIsTest: boolean;
  campaignId: string;
  campaignIsTest: boolean;
  hasVerifiedVisit: boolean;
  now: Date;
}

export interface VoterEligibilityResult {
  eligible: boolean;
  reason: 'ACCOUNT_TOO_NEW' | null;
  eligibleAt: Date | null;
  isPresentationException: boolean;
}

/**
 * Pure eligibility predicate enforcing the fail-closed JuanChoice rules:
 * - Standard rule: Account age >= 72 hours OR a non-revoked verified visit.
 * - Presentation exception: Allows fresh guests only when:
 *   1. JUANCHOICE_PRESENTATION_MODE is true
 *   2. ALLOW_IN_MEMORY_FALLBACK is false
 *   3. If NODE_ENV === 'production', WALLET_AUTH_MODE === 'signature'
 *   4. JUANCHOICE_PRESENTATION_CAMPAIGN_ID is a valid UUID matching campaignId exactly
 *   5. JUANCHOICE_PRESENTATION_DB_NAME is set and matches the database name in DATABASE_URL exactly
 *   6. Neither actor nor campaign is a test/QA entity (actorIsTest === false && campaignIsTest === false)
 */
export function evaluateVoterEligibility(input: VoterEligibilityInput): VoterEligibilityResult {
  const eligibleAt = new Date(input.actorCreatedAt.getTime() + 72 * 3_600_000);
  const oldEnough = input.now.getTime() >= eligibleAt.getTime();
  const standardEligible = oldEnough || input.hasVerifiedVisit;

  if (standardEligible) {
    return {
      eligible: true,
      reason: null,
      eligibleAt: null,
      isPresentationException: false,
    };
  }

  // Fail-closed presentation exception check
  if (
    env.JUANCHOICE_PRESENTATION_MODE &&
    !env.ALLOW_IN_MEMORY_FALLBACK &&
    (env.NODE_ENV !== 'production' || env.WALLET_AUTH_MODE === 'signature') &&
    !input.actorIsTest &&
    !input.campaignIsTest
  ) {
    const configuredCampaignId = env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID?.trim();
    const configuredDbName = env.JUANCHOICE_PRESENTATION_DB_NAME?.trim();
    const actualDbName = extractDatabaseName(env.DATABASE_URL);

    if (
      configuredCampaignId &&
      UUID_V4_REGEX.test(configuredCampaignId) &&
      configuredCampaignId.toLowerCase() === input.campaignId.trim().toLowerCase() &&
      configuredDbName &&
      isPresentationDatabaseName(configuredDbName, env.NODE_ENV) &&
      actualDbName &&
      configuredDbName === actualDbName
    ) {
      return {
        eligible: true,
        reason: null,
        eligibleAt: null,
        isPresentationException: true,
      };
    }
  }

  return {
    eligible: false,
    reason: 'ACCOUNT_TOO_NEW',
    eligibleAt,
    isPresentationException: false,
  };
}

/** Called only after castBallot has locked the actor row FOR UPDATE. */
async function awardFirstBallotParticipation(
  client: PoolClient, userId: string, campaignId: string, isTest: boolean, earnedAt: Date
) {
  // Both logical awards are inserted together. A partial duplicate is an
  // integrity conflict, not permission to increment the totals again.
  const awards = await client.query(
    `INSERT INTO progression_events
       (id,user_id,track,delta,source_type,source_id,award_kind,rule_version,earned_at,is_test)
     VALUES
       ($1,$3,'civic',25,'juanchoice_participation',$4,'xp',$5,$6,$7),
       ($2,$3,'civic',1,'juanchoice_participation',$4,'stamp',$5,$6,$7)
     ON CONFLICT (user_id,source_type,source_id,award_kind) DO NOTHING
     RETURNING award_kind`,
    [randomUUID(), randomUUID(), userId, campaignId, policyVersion, earnedAt.toISOString(), isTest]
  );
  if (awards.rowCount !== 2 ||
      new Set(awards.rows.map(row => row.award_kind)).size !== 2) {
    throw new JuanChoiceError('REWARD_CONFLICT', 409);
  }

  // The user lock serializes this with grant writers and projection rebuilds.
  // The conditional upsert preserves the safe-integer ceiling atomically.
  const totals = await client.query(
    `INSERT INTO progression_totals
       (user_id,explorer_xp,civic_xp,civic_stamps,last_event_at,updated_at)
     VALUES ($1,0,25,1,NOW(),NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       civic_xp=progression_totals.civic_xp+25,
       civic_stamps=progression_totals.civic_stamps+1,
       last_event_at=NOW(),updated_at=NOW()
     WHERE progression_totals.civic_xp <= 9007199254740966
       AND progression_totals.civic_stamps <= 9007199254740990
     RETURNING user_id`,
    [userId]
  );
  if (totals.rowCount !== 1) throw new JuanChoiceError('TOTALS_OUT_OF_BOUNDS', 409);
}

async function writeBallotBatch(client: PoolClient, input: {
  campaignId: string; userId: string; candidateId: string; expectedVersion: number; idempotencyKey: string;
}, version: number, previousCandidateId: string | null, isTest: boolean,
requestHash: string, response: object, earnedAt: Date) {
  // PostgreSQL data-modifying CTEs share one statement/round trip. Each step
  // depends on RETURNING from its predecessor; the caller checks every count
  // before COMMIT. Any partial write or unsafe totals projection is rolled back.
  const result = (await client.query(
    `WITH ballot_write AS (
       INSERT INTO juanchoice_ballots(campaign_id,user_id,candidate_id,version,is_test)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (campaign_id,user_id) DO UPDATE SET
         candidate_id=EXCLUDED.candidate_id,version=EXCLUDED.version,updated_at=NOW()
       WHERE juanchoice_ballots.version=$6
       RETURNING user_id
     ), participation_write AS (
       INSERT INTO juanchoice_participations(campaign_id,user_id,is_test)
       SELECT $1,user_id,$5 FROM ballot_write WHERE $4=1
       ON CONFLICT (campaign_id,user_id) DO NOTHING
       RETURNING user_id
     ), reward_write AS (
       INSERT INTO progression_events
         (id,user_id,track,delta,source_type,source_id,award_kind,rule_version,earned_at,is_test)
       SELECT award.id,p.user_id,'civic',award.delta,'juanchoice_participation',$1,
         award.kind,$15,$14,$5
       FROM participation_write p
       CROSS JOIN (VALUES ($12::uuid,25::bigint,'xp'::varchar),
                          ($13::uuid,1::bigint,'stamp'::varchar)) AS award(id,delta,kind)
       ON CONFLICT (user_id,source_type,source_id,award_kind) DO NOTHING
       RETURNING award_kind
     ), totals_write AS (
       INSERT INTO progression_totals
         (user_id,explorer_xp,civic_xp,civic_stamps,last_event_at,updated_at)
       SELECT user_id,0,25,1,NOW(),NOW() FROM participation_write
       WHERE (SELECT COUNT(*) FROM reward_write)=2
       ON CONFLICT (user_id) DO UPDATE SET
         civic_xp=progression_totals.civic_xp+25,
         civic_stamps=progression_totals.civic_stamps+1,
         last_event_at=NOW(),updated_at=NOW()
       WHERE progression_totals.civic_xp<=9007199254740966
         AND progression_totals.civic_stamps<=9007199254740990
       RETURNING user_id
     ), event_write AS (
       INSERT INTO juanchoice_ballot_events
         (id,campaign_id,user_id,previous_candidate_id,candidate_id,version,idempotency_key)
       SELECT $7,$1,user_id,$8,$3,$4,$9 FROM ballot_write
       RETURNING id
     ), receipt_write AS (
       INSERT INTO juanchoice_receipts
         (campaign_id,user_id,idempotency_key,request_hash,response)
       SELECT $1,$2,$9,$10,$11::jsonb FROM event_write
       WHERE $4>1 OR EXISTS(SELECT 1 FROM totals_write)
       RETURNING idempotency_key
     )
     SELECT (SELECT COUNT(*)::int FROM ballot_write) AS ballots,
       (SELECT COUNT(*)::int FROM participation_write) AS participations,
       (SELECT COUNT(*)::int FROM reward_write) AS rewards,
       (SELECT COUNT(*)::int FROM totals_write) AS totals,
       (SELECT COUNT(*)::int FROM event_write) AS events,
       (SELECT COUNT(*)::int FROM receipt_write) AS receipts`,
    [input.campaignId,input.userId,input.candidateId,version,isTest,input.expectedVersion,
      randomUUID(),previousCandidateId,input.idempotencyKey,requestHash,JSON.stringify(response),
      randomUUID(),randomUUID(),earnedAt.toISOString(),policyVersion]
  )).rows[0];
  if (Number(result.ballots) !== 1) throw new JuanChoiceError('VERSION_CONFLICT',409);
  if (version === 1) {
    if (Number(result.participations) !== 1 || Number(result.rewards) !== 2) {
      throw new JuanChoiceError('REWARD_CONFLICT',409);
    }
    if (Number(result.totals) !== 1) throw new JuanChoiceError('TOTALS_OUT_OF_BOUNDS',409);
  } else if (Number(result.participations) !== 0 || Number(result.rewards) !== 0 || Number(result.totals) !== 0) {
    throw new JuanChoiceError('REWARD_CONFLICT',409);
  }
  if (Number(result.events) !== 1 || Number(result.receipts) !== 1) {
    throw new JuanChoiceError('BALLOT_WRITE_INCOMPLETE',503);
  }
}

async function loadSupporterQuest(campaignId?: string, allowTest = false, client: Pool | PoolClient = pool()) {
  const campaigns = (await client.query(
    `SELECT c.id,c.theme,c.region,c.is_test,r.co_winner_ids,r.finalized_at
     FROM juanchoice_results r JOIN juanchoice_campaigns c ON c.id=r.campaign_id
     WHERE c.status IN ('finalized','archived') AND ($1::uuid IS NULL OR c.id=$1)
       AND ($2::boolean OR c.is_test=FALSE)
       AND r.finalized_at > NOW() - INTERVAL '7 days'
     ORDER BY r.finalized_at DESC LIMIT 10`, [campaignId ?? null, allowTest]
  )).rows;
  for (const campaign of campaigns) {
    const winners = Array.isArray(campaign.co_winner_ids) ? campaign.co_winner_ids : [];
    // A tie is not resolved arbitrarily; no limited quest is exposed.
    if (winners.length !== 1) continue;
    const winnerId = winners[0];
    const eligibility = await evaluateCandidatePromotionEligibility(campaign.id, winnerId, Boolean(campaign.is_test), client);
    if (!eligibility.eligible) continue;

    const row = (await client.query(
      `SELECT c.id AS candidate_id,c.spot_id,s.slug AS spot_slug,s.name AS spot_name,
              s.municipality,b.id AS binding_id,b.quest_id,q.title AS quest_title,
              q.description AS quest_description,q.radius_meters,q.gps_lat,q.gps_lng
       FROM juanchoice_candidates c
       JOIN spots s ON s.id=c.spot_id
       JOIN reviewed_quest_spot_bindings b ON b.spot_id=s.id AND b.status='active'
       JOIN quests q ON q.id=b.quest_id AND q.is_active=TRUE
       WHERE c.id=$1 AND c.campaign_id=$2 AND c.status='eligible'
         AND c.is_test=$3 AND s.is_test=$3 AND b.is_test=$3
         AND s.status='published' AND s.recommendation_suppressed=FALSE
       ORDER BY b.created_at DESC LIMIT 1`, [winnerId, campaign.id, campaign.is_test]
    )).rows[0];
    if (!row) continue;
    return { campaign_id: campaign.id, theme: campaign.theme, region: campaign.region,
      finalized_at: campaign.finalized_at,
      expires_at: new Date(new Date(campaign.finalized_at).getTime() + 7 * 86400000).toISOString(),
      explorer_xp: supporterExplorerXp, is_test: Boolean(campaign.is_test), ...row };
  }
  return null;
}

export async function getSupporterQuest(userId?: string, allowTest = false) {
  const quest = await loadSupporterQuest(undefined, allowTest);
  if (!quest) return null;
  const claim = userId ? (await pool().query(
    `SELECT claimed_at,verified_visit_id FROM juanchoice_supporter_quest_claims
     WHERE campaign_id=$1 AND user_id=$2`, [quest.campaign_id, userId]
  )).rows[0] ?? null : null;
  return { ...quest, claimed: Boolean(claim), claim };
}

export async function claimSupporterQuest(campaignId: string, userId: string) {
  if (!env.JUANCHOICE_WRITES_ENABLED || !env.PROGRESSION_ENABLED) throw new JuanChoiceError('WRITES_DISABLED', 503);
  return transaction(async client => {
    const campaign = (await client.query(
      'SELECT id,is_test FROM juanchoice_campaigns WHERE id=$1 FOR UPDATE', [campaignId]
    )).rows[0];
    const actor = (await client.query('SELECT id,is_test FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
    if (!campaign || !actor || Boolean(campaign.is_test) !== Boolean(actor.is_test)) {
      throw new JuanChoiceError('SUPPORTER_QUEST_NOT_FOUND', 404);
    }
    const replay = (await client.query(
      'SELECT * FROM juanchoice_supporter_quest_claims WHERE campaign_id=$1 AND user_id=$2', [campaignId,userId]
    )).rows[0];
    if (replay) return { claim: replay, replayed: true };
    const quest = await loadSupporterQuest(campaignId, Boolean(campaign.is_test), client);
    if (!quest || Boolean(quest.is_test) !== Boolean(actor.is_test)) throw new JuanChoiceError('SUPPORTER_QUEST_NOT_FOUND',404);
    const visit = (await client.query(
      `SELECT id FROM verified_visits WHERE user_id=$1 AND spot_id=$2 AND binding_id=$3
         AND is_test=$4 AND revoked_at IS NULL AND verified_at >= $5 AND verified_at < $6
       ORDER BY verified_at LIMIT 1 FOR UPDATE`,
      [userId,quest.spot_id,quest.binding_id,campaign.is_test,quest.finalized_at,quest.expires_at]
    )).rows[0];
    if (!visit) throw new JuanChoiceError('VERIFIED_VISIT_REQUIRED',422,
      'Complete the destination quest during the spotlight period before claiming.');
    const eventId = randomUUID();
    const event = await progressionRepo.recordProgressionEvent({
      id:eventId,user_id:userId,track:'explorer',delta:supporterExplorerXp,
      source_type:'juanchoice_supporter_visit',source_id:campaignId,award_kind:'xp',
      rule_version:supporterRuleVersion,earned_at:new Date().toISOString(),
      is_test:Boolean(campaign.is_test),reversal_of:null,
    },client);
    if (!event) throw new JuanChoiceError('REWARD_CONFLICT',409);
    await progressionRepo.updateProgressionTotals(userId,{explorerXp:supporterExplorerXp},client);
    const claim = (await client.query(
      `INSERT INTO juanchoice_supporter_quest_claims
       (id,campaign_id,user_id,spot_id,quest_id,binding_id,verified_visit_id,progression_event_id,is_test)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [randomUUID(),campaignId,userId,quest.spot_id,quest.quest_id,quest.binding_id,visit.id,eventId,campaign.is_test]
    )).rows[0];
    return { claim, replayed:false };
  });
}

export async function castBallot(input: {
  campaignId: string; userId: string; candidateId: string;
  expectedVersion: number; idempotencyKey: string;
}) {
  if (!env.JUANCHOICE_WRITES_ENABLED || !env.PROGRESSION_ENABLED) throw new JuanChoiceError('WRITES_DISABLED', 503);
  if (env.JUANCHOICE_PRESENTATION_MODE &&
      input.campaignId.toLowerCase() !== env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID.toLowerCase()) {
    throw new JuanChoiceError('CAMPAIGN_NOT_FOUND', 404);
  }
  return transaction(async client => {
    // Global ordering: campaign, user, ballot, participation. Concurrent ballots
    // may share the campaign read lock; finalization/moderation take FOR UPDATE
    // and still wait for every in-flight ballot before changing round state.
    const campaignResult = await client.query('SELECT * FROM juanchoice_campaigns WHERE id = $1 FOR SHARE', [input.campaignId]);
    const campaign = campaignResult.rows[0];
    if (!campaign) throw new JuanChoiceError('CAMPAIGN_NOT_FOUND', 404);
    await assertPresentationCampaignAccess(client, input.campaignId, campaign);
    const actorResult = await client.query('SELECT id, created_at, is_test FROM users WHERE id = $1 FOR UPDATE', [input.userId]);
    const actor = actorResult.rows[0];
    if (!actor || Boolean(actor.is_test) !== Boolean(campaign.is_test)) throw new JuanChoiceError('CAMPAIGN_NOT_FOUND', 404);

    const requestHash = createHash('sha256').update(`${input.candidateId}:${input.expectedVersion}`).digest('hex');
    // The actor row is already locked. It serializes this user's ballot writes,
    // so the prior ballot does not require a second row lock. The snapshot also
    // carries receipt, clock, eligibility and candidate checks in one trip.
    const ballotChecks = (await client.query(
      `SELECT clock_timestamp() AS now,
        EXISTS (SELECT 1 FROM verified_visits
          WHERE user_id = $1 AND is_test = $2 AND revoked_at IS NULL) AS has_visit,
        EXISTS (SELECT 1 FROM juanchoice_candidates c JOIN spots s ON s.id = c.spot_id
          WHERE c.id = $3 AND c.campaign_id = $4 AND c.status = 'eligible'
            AND c.is_test = $2 AND s.is_test = $2 AND s.status = 'published'
            AND s.recommendation_suppressed = FALSE) AS candidate_valid,
        r.request_hash AS receipt_hash, r.response AS receipt_response,
        b.candidate_id AS prior_candidate_id, b.version AS prior_version
       FROM juanchoice_campaigns round_row
       LEFT JOIN juanchoice_receipts r ON r.campaign_id=round_row.id
         AND r.user_id=$1 AND r.idempotency_key=$5
       LEFT JOIN juanchoice_ballots b ON b.campaign_id=round_row.id AND b.user_id=$1
       WHERE round_row.id=$4`,
      [input.userId, campaign.is_test, input.candidateId, input.campaignId, input.idempotencyKey]
    )).rows[0];
    if (ballotChecks.receipt_hash != null) {
      if (ballotChecks.receipt_hash !== requestHash) throw new JuanChoiceError('IDEMPOTENCY_CONFLICT', 409);
      return { ...ballotChecks.receipt_response, replayed: true };
    }
    const now = new Date(ballotChecks.now);
    if (!['scheduled','voting'].includes(campaign.status) || now < new Date(campaign.opens_at) || now >= new Date(campaign.closes_at)) {
      throw new JuanChoiceError('ROUND_CLOSED', 409);
    }

    const eligibility = evaluateVoterEligibility({
      actorCreatedAt: new Date(actor.created_at),
      actorIsTest: Boolean(actor.is_test),
      campaignId: input.campaignId,
      campaignIsTest: Boolean(campaign.is_test),
      hasVerifiedVisit: Boolean(ballotChecks.has_visit),
      now,
    });
    if (!eligibility.eligible) {
      throw new JuanChoiceError('NOT_ELIGIBLE', 403, 'Account must be 72 hours old or have a verified visit.');
    }

    if (!ballotChecks.candidate_valid) throw new JuanChoiceError('INVALID_CANDIDATE', 422);

    const prior = ballotChecks.prior_version == null ? null : {
      candidate_id: ballotChecks.prior_candidate_id, version: ballotChecks.prior_version,
    };
    const currentVersion = prior?.version ?? 0;
    if (input.expectedVersion !== currentVersion) throw new JuanChoiceError('VERSION_CONFLICT', 409);
    const version = currentVersion + 1;
    const response = {
      ballot: { candidate_id: input.candidateId, version },
      participation: { civic_xp: 25, stamps: 1, token_grant_mjdq: '0' },
      replayed: false, policy_version: policyVersion, server_time: now.toISOString(),
    };
    if (env.JUANCHOICE_BATCH_WRITES_ENABLED) {
      await writeBallotBatch(client,input,version,prior?.candidate_id ?? null,
        Boolean(campaign.is_test),requestHash,response,now);
      return response;
    }
    if (prior) {
      await client.query(
        'UPDATE juanchoice_ballots SET candidate_id = $3, version = $4, updated_at = NOW() WHERE campaign_id = $1 AND user_id = $2',
        [input.campaignId, input.userId, input.candidateId, version]
      );
    } else {
      await client.query(
        'INSERT INTO juanchoice_ballots(campaign_id,user_id,candidate_id,version,is_test) VALUES($1,$2,$3,$4,$5)',
        [input.campaignId, input.userId, input.candidateId, version, campaign.is_test]
      );
      await client.query(
        'INSERT INTO juanchoice_participations(campaign_id,user_id,is_test) VALUES($1,$2,$3)',
        [input.campaignId, input.userId, campaign.is_test]
      );
      await awardFirstBallotParticipation(client, input.userId, input.campaignId, Boolean(campaign.is_test), now);
    }

    await client.query(
      `INSERT INTO juanchoice_ballot_events(id,campaign_id,user_id,previous_candidate_id,candidate_id,version,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), input.campaignId, input.userId, prior?.candidate_id ?? null, input.candidateId, version, input.idempotencyKey]
    );
    await client.query(
      `INSERT INTO juanchoice_receipts(campaign_id,user_id,idempotency_key,request_hash,response)
       VALUES($1,$2,$3,$4,$5::jsonb)`,
      [input.campaignId, input.userId, input.idempotencyKey, requestHash, JSON.stringify(response)]
    );
    return response;
  });
}

export async function getMyJuanChoiceCampaignState(campaignId: string, userId: string) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const campaign = (await client.query(
      'SELECT is_test,status,opens_at,closes_at,series_key,round_number,counts_for_streak FROM juanchoice_campaigns WHERE id=$1', [campaignId]
    )).rows[0];
    await assertPresentationCampaignAccess(client, campaignId, campaign);
    const actor = (await client.query(
      'SELECT is_test,created_at FROM users WHERE id=$1', [userId]
    )).rows[0];
    if (!campaign || !actor || Boolean(actor.is_test) !== Boolean(campaign.is_test) || campaign.status === 'draft') {
      throw new JuanChoiceError('CAMPAIGN_NOT_FOUND', 404);
    }
    const now = new Date((await client.query('SELECT clock_timestamp() AS now')).rows[0].now);
    const hasVisit = Boolean((await client.query(
      'SELECT 1 FROM verified_visits WHERE user_id=$1 AND is_test=$2 AND revoked_at IS NULL LIMIT 1',
      [userId, campaign.is_test]
    )).rowCount);
    const eligibility = evaluateVoterEligibility({
      actorCreatedAt: new Date(actor.created_at),
      actorIsTest: Boolean(actor.is_test),
      campaignId,
      campaignIsTest: Boolean(campaign.is_test),
      hasVerifiedVisit: hasVisit,
      now,
    });
    const eligible = eligibility.eligible;
    const inWindow = ['scheduled', 'voting'].includes(campaign.status)
      && now >= new Date(campaign.opens_at) && now < new Date(campaign.closes_at);
    const ballot = (await client.query(
      'SELECT candidate_id,version FROM juanchoice_ballots WHERE campaign_id=$1 AND user_id=$2',
      [campaignId, userId]
    )).rows[0] ?? null;
    const result = {
      ballot,
      eligibility: {
        eligible,
        reason: eligibility.reason,
        eligible_at: eligibility.eligibleAt ? eligibility.eligibleAt.toISOString() : null,
      },
      can_vote_now: eligible && inWindow && env.JUANCHOICE_WRITES_ENABLED && env.PROGRESSION_ENABLED,
      vote_unavailable_reason: !eligible ? 'ACCOUNT_TOO_NEW'
        : !inWindow ? now < new Date(campaign.opens_at) ? 'ROUND_NOT_OPEN' : 'ROUND_CLOSED'
        : !env.JUANCHOICE_WRITES_ENABLED || !env.PROGRESSION_ENABLED ? 'WRITES_DISABLED' : null,
      server_time: now.toISOString(),
    };
    const committed = await client.query('COMMIT');
    if (committed.command !== 'COMMIT') throw new JuanChoiceError('COMMIT_FAILED', 503);
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function queryStandings(campaignId: string, allowTest: boolean) {
  if (env.JUANCHOICE_PRESENTATION_MODE &&
      campaignId.toLowerCase() !== env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID.toLowerCase()) {
    throw new JuanChoiceError('CAMPAIGN_NOT_FOUND', 404);
  }
  const campaign = (await pool().query(
    `SELECT id,slug,region,theme,status,opens_at,closes_at,is_test,policy_version,series_key,round_number,counts_for_streak
     FROM juanchoice_campaigns WHERE id = $1 AND status <> 'draft' AND ($2::boolean OR is_test = FALSE)`,
    [campaignId, allowTest]
  )).rows[0];
  if (!campaign) throw new JuanChoiceError('CAMPAIGN_NOT_FOUND', 404);
  if (env.JUANCHOICE_PRESENTATION_MODE) {
    const client = await pool().connect();
    try { await assertPresentationCampaignAccess(client, campaignId, campaign); }
    finally { client.release(); }
  }
  if (campaign.status === 'finalized' || campaign.status === 'archived') {
    const result = (await pool().query(
      'SELECT standings,co_winner_ids,valid_ballots,policy_version,finalized_at FROM juanchoice_results WHERE campaign_id = $1',
      [campaignId]
    )).rows[0];
    if (result) return { campaign, standings: result.standings, result };
  }
  const rows = (await pool().query(
    `SELECT c.id AS candidate_id, c.spot_id, s.slug AS spot_slug, s.name AS spot_name, COUNT(b.user_id)::int AS votes
     FROM juanchoice_candidates c JOIN spots s ON s.id = c.spot_id
     LEFT JOIN juanchoice_ballots b ON b.campaign_id = c.campaign_id AND b.candidate_id = c.id
     WHERE c.campaign_id = $1 AND c.status = 'eligible' AND c.is_test = $2 AND s.is_test = $2 AND s.status = 'published' AND s.recommendation_suppressed = FALSE
     GROUP BY c.id,c.spot_id,s.slug,s.name ORDER BY votes DESC,c.id`,
    [campaignId, campaign.is_test]
  )).rows;
  return { campaign, standings: rows, result: null };
}

const standingsInFlight = new Map<string, Promise<Awaited<ReturnType<typeof queryStandings>>>>();

// A polling burst should not queue dozens of identical aggregate reads behind
// ballots. This shares only the in-flight read; after completion every new
// request rechecks candidate safety, tallies and finalization state.
export function getStandings(campaignId: string, allowTest = false) {
  const key = JSON.stringify([campaignId, allowTest]);
  const existing = standingsInFlight.get(key);
  if (existing) return existing;
  const pending = queryStandings(campaignId, allowTest);
  standingsInFlight.set(key, pending);
  const clear = () => { if (standingsInFlight.get(key) === pending) standingsInFlight.delete(key); };
  void pending.then(clear, clear);
  return pending;
}

export async function getPublicSpotlight() {
  const latest = (await pool().query(
    `SELECT c.id AS campaign_id,c.theme,c.region,r.co_winner_ids,r.valid_ballots,r.finalized_at
     FROM juanchoice_campaigns c JOIN juanchoice_results r ON r.campaign_id=c.id
     WHERE c.status='finalized' AND c.is_test=FALSE AND r.valid_ballots > 0
       AND r.finalized_at <= NOW() AND r.finalized_at > NOW() - INTERVAL '7 days'
     ORDER BY r.finalized_at DESC,c.id DESC LIMIT 1`
  )).rows[0];
  if (!latest) return null;
  const ids: unknown = typeof latest.co_winner_ids === 'string' ? JSON.parse(latest.co_winner_ids) : latest.co_winner_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20 || ids.some(id => typeof id !== 'string')) return null;
  const winners = await Promise.all(ids.map(async candidateId => {
    // All co-winners must qualify for promotion eligibility; no partial tie.
    const eligibility = await evaluateCandidatePromotionEligibility(latest.campaign_id, candidateId, false, pool());
    if (!eligibility.eligible) return null;

    const row = (await pool().query(
      `SELECT c.id AS candidate_id,s.id AS spot_id,s.slug AS spot_slug,s.name AS spot_name,s.municipality
       FROM juanchoice_candidates c JOIN spots s ON s.id=c.spot_id
       WHERE c.id=$1 AND c.campaign_id=$2 AND c.status='eligible' AND c.is_test=FALSE
         AND s.is_test=FALSE AND s.status='published' AND s.recommendation_suppressed=FALSE`,
      [candidateId, latest.campaign_id]
    )).rows[0];
    return row ?? null;
  }));
  // Never promote only a subset of tied winners or a destination withdrawn for safety or without valid clearance.
  if (winners.some(winner => !winner)) return null;
  return {
    kind: 'juanchoice_spotlight' as const,
    campaign_id: latest.campaign_id,
    theme: latest.theme,
    region: latest.region,
    valid_ballots: Number(latest.valid_ballots),
    finalized_at: latest.finalized_at,
    expires_at: new Date(new Date(latest.finalized_at).getTime() + 7 * 86_400_000).toISOString(),
    winners,
  };
}

export async function finalizeCampaign(campaignId: string, actorId?: string) {
  return transaction(async client => {
    const campaign = (await client.query('SELECT * FROM juanchoice_campaigns WHERE id = $1 FOR UPDATE', [campaignId])).rows[0];
    if (!campaign) throw new JuanChoiceError('CAMPAIGN_NOT_FOUND', 404);
    const existing = (await client.query('SELECT * FROM juanchoice_results WHERE campaign_id = $1', [campaignId])).rows[0];
    if (existing) return existing;
    const now = new Date((await client.query('SELECT clock_timestamp() AS now')).rows[0].now);
    if (now < new Date(campaign.closes_at) || !['scheduled','voting','closed'].includes(campaign.status)) {
      throw new JuanChoiceError('ROUND_NOT_CLOSED', 409);
    }
    const standings = (await client.query(
      `SELECT c.id AS candidate_id, c.spot_id, s.slug AS spot_slug, s.name AS spot_name, COUNT(b.user_id)::int AS votes
       FROM juanchoice_candidates c JOIN spots s ON s.id = c.spot_id
       LEFT JOIN juanchoice_ballots b ON b.campaign_id = c.campaign_id AND b.candidate_id = c.id
       WHERE c.campaign_id = $1 AND c.status = 'eligible' AND c.is_test = $2 AND s.is_test = $2 AND s.status = 'published' AND s.recommendation_suppressed = FALSE
       GROUP BY c.id,c.spot_id,s.slug,s.name ORDER BY votes DESC,c.id`, [campaignId, campaign.is_test]
    )).rows;
    const maximum = Number(standings[0]?.votes ?? 0);
    const coWinners = maximum > 0 ? standings.filter(row => Number(row.votes) === maximum).map(row => row.candidate_id) : [];
    const validBallots = standings.reduce((sum, row) => sum + Number(row.votes), 0);
    const result = (await client.query(
      `INSERT INTO juanchoice_results(campaign_id,standings,co_winner_ids,valid_ballots,policy_version)
       VALUES($1,$2::jsonb,$3::jsonb,$4,$5) RETURNING *`,
      [campaignId, JSON.stringify(standings), JSON.stringify(coWinners), validBallots, policyVersion]
    )).rows[0];
    await client.query("UPDATE juanchoice_campaigns SET status = 'finalized', finalized_at = NOW() WHERE id = $1", [campaignId]);
    await evaluateFinalizedCampaignRetention(campaignId, coWinners, client);
    await client.query(
      'INSERT INTO juanchoice_campaign_audit(id,campaign_id,actor_id,action) VALUES($1,$2,$3,$4)',
      [randomUUID(), campaignId, actorId ?? null, 'finalized']
    );
    return result;
  });
}

export async function publishCampaign(campaignId: string, actorId: string) {
  return transaction(async client => {
    const identity = (await client.query('SELECT region FROM juanchoice_campaigns WHERE id = $1', [campaignId])).rows[0];
    if (!identity) throw new JuanChoiceError('INVALID_CAMPAIGN_STATE', 409);
    // Shared publication order: region -> campaign. Ballots never acquire the region lock.
    await client.query('INSERT INTO juanchoice_region_locks(region) VALUES($1) ON CONFLICT (region) DO NOTHING', [identity.region]);
    await client.query('SELECT region FROM juanchoice_region_locks WHERE region = $1 FOR UPDATE', [identity.region]);
    const campaign = (await client.query('SELECT * FROM juanchoice_campaigns WHERE id = $1 FOR UPDATE', [campaignId])).rows[0];
    if (!campaign || campaign.status !== 'draft' || campaign.region !== identity.region) throw new JuanChoiceError('INVALID_CAMPAIGN_STATE', 409);
    const overlap = (await client.query(
      `SELECT id FROM juanchoice_campaigns WHERE id <> $1 AND region = $2 AND is_test = $3
       AND status IN ('scheduled','voting','closed','finalized')
       AND opens_at < $4 AND closes_at > $5 LIMIT 1`,
      [campaignId,campaign.region,campaign.is_test,campaign.closes_at,campaign.opens_at]
    )).rows[0];
    if (overlap) throw new JuanChoiceError('REGIONAL_ROUND_OVERLAP', 409);
    const candidates = (await client.query(
      `SELECT COUNT(*)::int AS count FROM juanchoice_candidates c JOIN spots s ON s.id = c.spot_id
       WHERE c.campaign_id = $1 AND c.status = 'eligible' AND c.is_test = $2
         AND s.is_test = $2 AND s.status = 'published' AND s.recommendation_suppressed = FALSE`, [campaignId,campaign.is_test]
    )).rows[0];
    const now = new Date((await client.query('SELECT clock_timestamp() AS now')).rows[0].now);
    if (Number(candidates.count) < 1 || now >= new Date(campaign.closes_at)) throw new JuanChoiceError('INVALID_CAMPAIGN_STATE',409);
    const status = now >= new Date(campaign.opens_at) ? 'voting' : 'scheduled';
    const published = (await client.query('UPDATE juanchoice_campaigns SET status=$2 WHERE id=$1 RETURNING *',[campaignId,status])).rows[0];
    await client.query('INSERT INTO juanchoice_campaign_audit(id,campaign_id,actor_id,action) VALUES($1,$2,$3,$4)',
      [randomUUID(),campaignId,actorId,'published']);
    return published;
  });
}

export async function addCandidate(campaignId: string, spotId: string) {
  return transaction(async client => {
    const campaign = (await client.query('SELECT status,is_test FROM juanchoice_campaigns WHERE id=$1 FOR UPDATE',[campaignId])).rows[0];
    if (!campaign || campaign.status !== 'draft') throw new JuanChoiceError('INVALID_CAMPAIGN_STATE',409);
    const spot = (await client.query("SELECT id FROM spots WHERE id=$1 AND is_test=$2 AND status='published' AND recommendation_suppressed=FALSE",[spotId,campaign.is_test])).rows[0];
    if (!spot) throw new JuanChoiceError('INVALID_SPOT',422);
    return (await client.query('INSERT INTO juanchoice_candidates(id,campaign_id,spot_id,is_test) VALUES($1,$2,$3,$4) RETURNING *',
      [randomUUID(),campaignId,spot.id,campaign.is_test])).rows[0];
  });
}

export async function moderateCandidate(campaignId: string, candidateId: string, status: 'eligible'|'suspended', actorId: string, reason: string) {
  return transaction(async client => {
    const campaign = (await client.query('SELECT status FROM juanchoice_campaigns WHERE id=$1 FOR UPDATE',[campaignId])).rows[0];
    if (!campaign || !['draft','scheduled','voting'].includes(campaign.status)) throw new JuanChoiceError('INVALID_CAMPAIGN_STATE',409);
    const candidate = (await client.query(
      'UPDATE juanchoice_candidates SET status=$3 WHERE campaign_id=$1 AND id=$2 RETURNING *',
      [campaignId,candidateId,status]
    )).rows[0];
    if (!candidate) throw new JuanChoiceError('INVALID_CANDIDATE',404);
    await client.query('INSERT INTO juanchoice_campaign_audit(id,campaign_id,actor_id,action,reason) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(),campaignId,actorId,`candidate_${status}:${candidateId}`,reason]);
    return candidate;
  });
}

export async function cancelCampaign(campaignId: string, actorId: string, reason: string) {
  return transaction(async client => {
    const campaign = (await client.query('SELECT * FROM juanchoice_campaigns WHERE id=$1 FOR UPDATE',[campaignId])).rows[0];
    if (!campaign) throw new JuanChoiceError('CAMPAIGN_NOT_FOUND',404);
    if (!['draft','scheduled','voting','closed'].includes(campaign.status)) throw new JuanChoiceError('INVALID_CAMPAIGN_STATE',409);
    const cancelled = (await client.query("UPDATE juanchoice_campaigns SET status='cancelled' WHERE id=$1 RETURNING *",[campaignId])).rows[0];
    await client.query('INSERT INTO juanchoice_campaign_audit(id,campaign_id,actor_id,action,reason) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(),campaignId,actorId,'cancelled',reason]);
    return cancelled;
  });
}

export async function finalizeDueCampaigns(limit = 20) {
  if (!env.JUANCHOICE_ENABLED || !env.JUANCHOICE_WRITES_ENABLED) return { processed: 0 };
  const due = (await pool().query(
    `SELECT id FROM juanchoice_campaigns WHERE status IN ('scheduled','voting','closed')
     AND closes_at <= clock_timestamp() ORDER BY closes_at,id LIMIT $1`, [limit]
  )).rows;
  let processed = 0;
  for (const row of due) {
    try { await finalizeCampaign(row.id); processed++; }
    catch (error) {
      if (!(error instanceof JuanChoiceError && error.code === 'ROUND_NOT_CLOSED')) throw error;
    }
  }
  return { processed };
}
