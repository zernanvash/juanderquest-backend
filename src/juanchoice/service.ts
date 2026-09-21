import { createHash, randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { progressionRepo } from '../progression/repository.js';
import { evaluateFinalizedCampaignRetention } from '../progression/retention.js';
import { env } from '../config/env.js';

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
       ORDER BY b.created_at DESC LIMIT 1`, [winners[0], campaign.id, campaign.is_test]
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
  return transaction(async client => {
    // Global ordering: campaign, user, ballot, participation. Finalizer locks campaign too.
    const campaignResult = await client.query('SELECT * FROM juanchoice_campaigns WHERE id = $1 FOR UPDATE', [input.campaignId]);
    const campaign = campaignResult.rows[0];
    if (!campaign) throw new JuanChoiceError('CAMPAIGN_NOT_FOUND', 404);
    const actorResult = await client.query('SELECT id, created_at, is_test FROM users WHERE id = $1 FOR UPDATE', [input.userId]);
    const actor = actorResult.rows[0];
    if (!actor || Boolean(actor.is_test) !== Boolean(campaign.is_test)) throw new JuanChoiceError('CAMPAIGN_NOT_FOUND', 404);

    const requestHash = createHash('sha256').update(`${input.candidateId}:${input.expectedVersion}`).digest('hex');
    const receipt = (await client.query(
      'SELECT request_hash, response FROM juanchoice_receipts WHERE campaign_id = $1 AND user_id = $2 AND idempotency_key = $3',
      [input.campaignId, input.userId, input.idempotencyKey]
    )).rows[0];
    if (receipt) {
      if (receipt.request_hash !== requestHash) throw new JuanChoiceError('IDEMPOTENCY_CONFLICT', 409);
      return { ...receipt.response, replayed: true };
    }

    const now = new Date((await client.query('SELECT clock_timestamp() AS now')).rows[0].now);
    if (!['scheduled','voting'].includes(campaign.status) || now < new Date(campaign.opens_at) || now >= new Date(campaign.closes_at)) {
      throw new JuanChoiceError('ROUND_CLOSED', 409);
    }

    const visit = (await client.query(
      'SELECT 1 FROM verified_visits WHERE user_id = $1 AND is_test = $2 AND revoked_at IS NULL LIMIT 1',
      [input.userId, campaign.is_test]
    )).rowCount;
    if (now.getTime() - new Date(actor.created_at).getTime() < 72 * 3600000 && !visit) {
      throw new JuanChoiceError('NOT_ELIGIBLE', 403, 'Account must be 72 hours old or have a verified visit.');
    }

    const candidate = (await client.query(
      `SELECT c.id FROM juanchoice_candidates c JOIN spots s ON s.id = c.spot_id
       WHERE c.id = $1 AND c.campaign_id = $2 AND c.status = 'eligible'
         AND c.is_test = $3 AND s.is_test = $3 AND s.status = 'published' AND s.recommendation_suppressed = FALSE`,
      [input.candidateId, input.campaignId, campaign.is_test]
    )).rows[0];
    if (!candidate) throw new JuanChoiceError('INVALID_CANDIDATE', 422);

    const prior = (await client.query(
      'SELECT candidate_id, version FROM juanchoice_ballots WHERE campaign_id = $1 AND user_id = $2 FOR UPDATE',
      [input.campaignId, input.userId]
    )).rows[0];
    const currentVersion = prior?.version ?? 0;
    if (input.expectedVersion !== currentVersion) throw new JuanChoiceError('VERSION_CONFLICT', 409);
    const version = currentVersion + 1;
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
      const xp = await progressionRepo.recordProgressionEvent({
        id: randomUUID(), user_id: input.userId, track: 'civic', delta: 25,
        source_type: 'juanchoice_participation', source_id: input.campaignId,
        award_kind: 'xp', rule_version: policyVersion, earned_at: now.toISOString(),
        is_test: campaign.is_test, reversal_of: null,
      }, client);
      const stamp = await progressionRepo.recordProgressionEvent({
        id: randomUUID(), user_id: input.userId, track: 'civic', delta: 1,
        source_type: 'juanchoice_participation', source_id: input.campaignId,
        award_kind: 'stamp', rule_version: policyVersion, earned_at: now.toISOString(),
        is_test: campaign.is_test, reversal_of: null,
      }, client);
      if (!xp || !stamp) throw new JuanChoiceError('REWARD_CONFLICT', 409);
      await progressionRepo.updateProgressionTotals(input.userId, { civicXp: 25, civicStamps: 1 }, client);
    }

    await client.query(
      `INSERT INTO juanchoice_ballot_events(id,campaign_id,user_id,previous_candidate_id,candidate_id,version,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), input.campaignId, input.userId, prior?.candidate_id ?? null, input.candidateId, version, input.idempotencyKey]
    );
    const response = {
      ballot: { candidate_id: input.candidateId, version },
      participation: { civic_xp: 25, stamps: 1, token_grant_mjdq: '0' },
      replayed: false, policy_version: policyVersion,
    };
    await client.query(
      `INSERT INTO juanchoice_receipts(campaign_id,user_id,idempotency_key,request_hash,response)
       VALUES($1,$2,$3,$4,$5::jsonb)`,
      [input.campaignId, input.userId, input.idempotencyKey, requestHash, JSON.stringify(response)]
    );
    return response;
  });
}

export async function getStandings(campaignId: string, allowTest = false) {
  const campaign = (await pool().query(
    `SELECT id,slug,region,theme,status,opens_at,closes_at,is_test,policy_version
     FROM juanchoice_campaigns WHERE id = $1 AND status <> 'draft' AND ($2::boolean OR is_test = FALSE)`,
    [campaignId, allowTest]
  )).rows[0];
  if (!campaign) throw new JuanChoiceError('CAMPAIGN_NOT_FOUND', 404);
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
    const row = (await pool().query(
      `SELECT c.id AS candidate_id,s.id AS spot_id,s.slug AS spot_slug,s.name AS spot_name,s.municipality
       FROM juanchoice_candidates c JOIN spots s ON s.id=c.spot_id
       WHERE c.id=$1 AND c.campaign_id=$2 AND c.status='eligible' AND c.is_test=FALSE
         AND s.is_test=FALSE AND s.status='published' AND s.recommendation_suppressed=FALSE`,
      [candidateId, latest.campaign_id]
    )).rows[0];
    return row ?? null;
  }));
  // Never promote only a subset of tied winners or a destination withdrawn for safety.
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
    const campaign = (await client.query('SELECT * FROM juanchoice_campaigns WHERE id = $1 FOR UPDATE', [campaignId])).rows[0];
    if (!campaign || campaign.status !== 'draft') throw new JuanChoiceError('INVALID_CAMPAIGN_STATE', 409);
    // Lock ordering for admin publication: campaign -> region row. Voting only locks campaign.
    await client.query('INSERT INTO juanchoice_region_locks(region) VALUES($1) ON CONFLICT (region) DO NOTHING', [campaign.region]);
    await client.query('SELECT region FROM juanchoice_region_locks WHERE region = $1 FOR UPDATE', [campaign.region]);
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
