import { perkBonus } from '../juanchoice/perks.js';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { commitGovernanceTransaction, lockGovernanceSnapshot } from '../governance/transaction.js';
import { getExplorerLevel } from '../progression/levels.js';
import { recordActivity, runIsolatedProducer } from '../social/activity.js';
import { fundingCommand, FundingError, fundingTx, publishFunding } from '../funding/transaction.js';
import { loadTrailEconomy } from './economy.js';

export class TrailProgressError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

const json = (value: any) => typeof value === 'string' ? JSON.parse(value) : value;

function isAvailable(trail: any, now: Date): boolean {
  return (!trail.available_from || new Date(trail.available_from).getTime() <= now.getTime()) &&
    (!trail.available_until || new Date(trail.available_until).getTime() > now.getTime());
}

async function findUnlockRuleFailure(client: { query: (sql: string, values?: any[]) => Promise<any> }, trail: any, userId: string, isTest: boolean) {
  const rule = json(trail.unlock_rule) ?? {};
  if (rule.type === 'free' || rule.type === 'points') return { rule, failure: null as string | null };
  if (rule.type === 'level') {
    const result = await client.query('SELECT explorer_xp FROM progression_totals WHERE user_id=$1', [userId]);
    const level = getExplorerLevel(Number(result.rows[0]?.explorer_xp ?? 0)).level;
    return { rule, failure: level >= Number(rule.min_level) ? null : 'RULE_NOT_MET' };
  }
  if (rule.type === 'badge' && typeof rule.badge_id === 'string') {
    const result = await client.query(`SELECT 1 FROM achievement_awards
      WHERE user_id=$1 AND achievement_id=$2 AND is_test=$3 AND revoked_at IS NULL LIMIT 1`, [userId, rule.badge_id, isTest]);
    return { rule, failure: result.rowCount ? null : 'RULE_NOT_MET' };
  }
  return { rule, failure: 'RULE_NOT_MET' };
}

export async function unlockTrail(pool: Pool, userId: string, trailId: string, idempotencyKey: string) {
  if (!idempotencyKey || idempotencyKey.length > 200) throw new TrailProgressError('IDEMPOTENCY_KEY_REQUIRED', 400, 'A valid Idempotency-Key header is required.');
  try {
    return await fundingCommand(pool, userId, 'trail_unlock', idempotencyKey, { trail_id: trailId }, async tx => {
      const userResult = await tx.client.query('SELECT id,is_test FROM users WHERE id=$1', [userId]);
      if (!userResult.rows[0]) throw new TrailProgressError('USER_NOT_FOUND', 404, 'Traveler account was not found.');
      const isTest = Boolean(userResult.rows[0].is_test);
      const trailResult = await tx.client.query(`SELECT * FROM trails WHERE id=$1 AND is_test=$2 FOR UPDATE`, [trailId, isTest]);
      const trail = trailResult.rows[0];
      if (!trail || (trail.tier === 'personal' && trail.owner_user_id !== userId)) throw new TrailProgressError('TRAIL_NOT_FOUND', 404, 'Trail was not found.');
      const prior = await tx.client.query('SELECT method,price_points,ledger_group_id,unlocked_at FROM trail_unlocks WHERE trail_id=$1 AND user_id=$2', [trailId, userId]);
      if (prior.rows[0]) return { trail_id: trailId, ...prior.rows[0], already_unlocked: true };
      const now = new Date();
      if (trail.status !== 'published' || !isAvailable(trail, now) ||
          (trail.tier === 'legendary' && (!trail.available_from || !trail.available_until))) {
        throw new TrailProgressError('NOT_AVAILABLE', 409, 'This trail is not currently available to unlock.');
      }
      const economy = await loadTrailEconomy(tx.client);
      const storedRule=json(trail.unlock_rule) ?? {};
      const configuredRule = trail.tier === 'starter' ? { type:'free' }
        : trail.tier === 'explorer' ? storedRule.type === 'badge' ? storedRule
          : { type:'level',min_level:storedRule.type==='level'?storedRule.min_level:economy.explorerMinLevel }
          : trail.tier === 'signature' ? storedRule.type === 'points' ? storedRule : { type:'points',price_points:economy.signatureUnlockPoints }
            : trail.tier === 'legendary' ? storedRule.type === 'points' ? storedRule : { type:'points',price_points:economy.legendaryUnlockPoints }
              : storedRule;
      const { rule, failure } = await findUnlockRuleFailure(tx.client, { ...trail, unlock_rule:configuredRule }, userId, isTest);
      if (failure) throw new TrailProgressError(failure, 409, 'Your account does not meet this trail’s unlock requirement.');
      let method = String(rule.type);
      let price = rule.type === 'points' ? Number(rule.price_points) : 0;
      if (price > 0) method = 'points';
      if (trail.tier === 'personal' && trail.owner_user_id === userId) { method = 'owner'; price = 0; }
      if (!Number.isSafeInteger(price) || price < 0) throw new TrailProgressError('INVALID_UNLOCK_RULE', 503, 'Trail unlock configuration is invalid.');
      // Plan 65: a reigning corridor_trail_discount makes Hiyas Trails through that town cheaper
      // (never below 1 point). Replays return the stored price above, so a perk change cannot re-price.
      let perkKeys: string[] = [];
      if (price > 0 && (trail.tier === 'signature' || trail.tier === 'legendary')) {
        const towns: string[] = Array.isArray(trail.municipalities) ? trail.municipalities : [];
        const discount = await perkBonus(tx.client, isTest, perk => perk.key === 'corridor_trail_discount' && towns.includes(perk.municipality));
        if (discount.value > 0) {
          price = Math.max(1, Math.round(price * (1 - Math.min(discount.value, 0.9))));
          perkKeys = discount.keys;
        }
      }
      let ledgerGroupId: string | null = null;
      if (price > 0) {
        const sinkId = `trail_sink:${isTest ? 'test' : 'live'}`;
        await tx.client.query(`INSERT INTO points_accounts(id,kind,is_test) VALUES($1,'treasury',$2) ON CONFLICT(id) DO NOTHING`, [sinkId, isTest]);
        const group = await tx.transfer({ from: { id: userId, kind: 'traveler', userId }, to: { id: sinkId, kind: 'treasury' },
          points: price, type: 'trail_unlock_debit', referenceType: 'trail', referenceId: trailId, actorId: userId,
          idempotencyKey, metadata: { trail_id: trailId, tier: trail.tier, points_unit: 'mJDQ prototype points', is_test: isTest,
            ...(perkKeys.length ? { juanchoice_perks: perkKeys } : {}) } });
        ledgerGroupId = group.entries[0]?.transaction_group_id ?? null;
      }
      // The table's idempotency key is globally unique; scope the caller's key to this traveler.
      const scopedIdempotencyKey = `${userId}:${idempotencyKey}`;
      const saved = await tx.client.query(`INSERT INTO trail_unlocks(trail_id,user_id,method,price_points,ledger_group_id,idempotency_key)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING unlocked_at`, [trailId,userId,method,price,ledgerGroupId,scopedIdempotencyKey]);
      return { trail_id: trailId, method, price_points: price, ledger_group_id: ledgerGroupId,
        unlocked_at: saved.rows[0].unlocked_at, already_unlocked: false };
    });
  } catch (error) {
    if (error instanceof TrailProgressError) throw error;
    if ((error instanceof FundingError && error.code === 'INSUFFICIENT_TRAVELER_POINTS') ||
        (error instanceof Error && error.message === 'INSUFFICIENT_TRAVELER_POINTS')) {
      throw new TrailProgressError('INSUFFICIENT_POINTS', 409, 'You do not have enough points to unlock this trail.');
    }
    throw error;
  }
}

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1), dLng = radians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface TrailCheckinInput { lat: number; lng: number; accuracy_m: number }

export async function checkinTrailStop(pool: Pool, userId: string, trailId: string, position: number, input: TrailCheckinInput) {
  if (![input.lat,input.lng,input.accuracy_m].every(Number.isFinite) || Math.abs(input.lat) > 90 || Math.abs(input.lng) > 180 || input.accuracy_m < 0) {
    throw new TrailProgressError('VALIDATION_ERROR', 400, 'Provide a valid location and non-negative accuracy.');
  }
  if (input.accuracy_m > 100) throw new TrailProgressError('LOCATION_ACCURACY_TOO_LOW', 422, 'Location accuracy must be 100 m or better.');
  const client = await pool.connect();
  const tx = fundingTx(client);
  try {
    await client.query('BEGIN');
    // Keep accounting lock order consistent with all other point movements: governance snapshot, then trail/user rows.
    await lockGovernanceSnapshot(client);
    const userResult = await client.query('SELECT id,is_test FROM users WHERE id=$1', [userId]);
    if (!userResult.rows[0]) throw new TrailProgressError('USER_NOT_FOUND', 404, 'Traveler account was not found.');
    const isTest = Boolean(userResult.rows[0].is_test);
    const result = await client.query(`SELECT t.id,t.title,t.status,t.tier,t.owner_user_id,t.is_test,t.version,
        s.position,s.spot_id,s.checkin_radius_m,p.gps_lat,p.gps_lng,p.name AS spot_name,p.municipality
      FROM trails t JOIN trail_stops s ON s.trail_id=t.id JOIN spots p ON p.id=s.spot_id
      WHERE t.id=$1 AND s.position=$2 AND t.is_test=$3 FOR UPDATE OF t`, [trailId,position,isTest]);
    const stop = result.rows[0];
    if (!stop || (stop.tier === 'personal' && stop.owner_user_id !== userId)) throw new TrailProgressError('TRAIL_STOP_NOT_FOUND', 404, 'Trail stop was not found.');
    if (stop.status !== 'published' && stop.owner_user_id !== userId) throw new TrailProgressError('NOT_AVAILABLE', 409, 'This trail is not currently available.');
    const unlock = await client.query('SELECT 1 FROM trail_unlocks WHERE trail_id=$1 AND user_id=$2', [trailId,userId]);
    if (!unlock.rowCount && stop.owner_user_id !== userId) throw new TrailProgressError('TRAIL_LOCKED', 403, 'Unlock this trail before checking in.');
    const lat = Number(stop.gps_lat), lng = Number(stop.gps_lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new TrailProgressError('STOP_LOCATION_UNAVAILABLE', 409, 'This trail stop does not have a verifiable location.');
    const distance = haversineMeters(input.lat,input.lng,lat,lng);
    if (distance > Number(stop.checkin_radius_m)) throw new TrailProgressError('TOO_FAR_FROM_STOP', 422, 'Move closer to the destination before checking in.');
    const checkin = await client.query(`INSERT INTO trail_checkins(trail_id,user_id,position,distance_m,accuracy_m)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(trail_id,user_id,position) DO NOTHING RETURNING verified_at`,
      [trailId,userId,position,Math.round(distance),Math.ceil(input.accuracy_m)]);
    const savedCheckin = checkin.rows[0] ?? (await client.query(
      'SELECT verified_at FROM trail_checkins WHERE trail_id=$1 AND user_id=$2 AND position=$3', [trailId,userId,position])).rows[0];
    const completedBefore = await client.query('SELECT 1 FROM trail_completions WHERE trail_id=$1 AND user_id=$2', [trailId,userId]);
    let completion: any = null;
    if (!completedBefore.rowCount) {
      const progress = await client.query(`SELECT COUNT(*)::int AS checked,
          (SELECT COUNT(*)::int FROM trail_stops WHERE trail_id=$1) AS total
        FROM trail_checkins WHERE trail_id=$1 AND user_id=$2`, [trailId,userId]);
      if (Number(progress.rows[0].total) > 0 && Number(progress.rows[0].checked) >= Number(progress.rows[0].total)) {
        const config = await loadTrailEconomy(client);
        const baseRewardPoints = stop.tier === 'legendary' ? config.legendaryRewardPoints
          : stop.tier === 'signature' ? config.signatureRewardPoints
            : stop.tier === 'explorer' ? config.explorerRewardPoints
              : stop.tier === 'personal' ? config.personalRewardPoints : config.starterRewardPoints;
        if (!Number.isSafeInteger(baseRewardPoints) || baseRewardPoints < 0) throw new TrailProgressError('INVALID_REWARD_CONFIG', 503, 'Trail reward configuration is invalid.');
        // Plan 65: a reigning trail_completion_bonus pays +X% on completion.
        const completionBonus = await perkBonus(client, isTest, perk => perk.key === 'trail_completion_bonus');
        const rewardPoints = Math.round(baseRewardPoints * (1 + completionBonus.value));
        let ledgerGroupId: string | null = null;
        if (rewardPoints > 0) {
          const issuanceId = `trail_reward_issuance:${isTest ? 'test' : 'live'}`;
          await client.query(`INSERT INTO points_accounts(id,kind,is_test) VALUES($1,'issuance',$2) ON CONFLICT(id) DO NOTHING`, [issuanceId,isTest]);
          const group = await tx.transfer({ from:{id:issuanceId,kind:'issuance'},to:{id:userId,kind:'traveler',userId},points:rewardPoints,
            type:'trail_reward_credit',referenceType:'trail',referenceId:trailId,actorId:userId,
            idempotencyKey:`trail-completion:${trailId}:${userId}`,metadata:{trail_id:trailId,tier:stop.tier,points_unit:'mJDQ prototype points',is_test:isTest} });
          ledgerGroupId = group.entries[0]?.transaction_group_id ?? null;
        }
        const insert = await client.query(`INSERT INTO trail_completions(trail_id,user_id,trail_version,reward_points,ledger_group_id)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(trail_id,user_id) DO NOTHING RETURNING completed_at`,
          [trailId,userId,stop.version,rewardPoints,ledgerGroupId]);
        if (insert.rowCount) {
          completion = { trail_id:trailId,reward_points:rewardPoints,ledger_group_id:ledgerGroupId,completed_at:insert.rows[0].completed_at };
          if (stop.tier === 'legendary') await awardLegendaryBadge(client,userId,trailId,isTest);
          await runIsolatedProducer(client,'[social:producer] Failed to record trail_completed activity:',async()=>{
            await recordActivity(client,{eventKey:`trail_completed:${userId}:${trailId}`,actorId:userId,verb:'trail_completed',subjectType:'trail',
              subjectId:trailId,subjectTitle:String(stop.title),subjectHref:`/trails/${encodeURIComponent(trailId)}`,
              municipality:stop.municipality,payload:{stops:Number(progress.rows[0].total),reward_points:rewardPoints},isTest});
          });
        }
      }
    }
    const progress = await readTrailProgress(client,userId,trailId);
    await commitGovernanceTransaction(client);
    publishFunding(tx.groups);
    return { trail_id:trailId,position,spot_id:stop.spot_id,spot_name:stop.spot_name,
      verified_at:savedCheckin?.verified_at ?? null,distance_m:Math.round(distance),already_checked_in:!checkin.rowCount,
      completion,progress };
  } catch (error) {
    await client.query('ROLLBACK').catch(()=>undefined);
    if (error instanceof TrailProgressError) throw error;
    if ((error instanceof FundingError && error.code === 'INSUFFICIENT_TRAVELER_POINTS') ||
        (error instanceof Error && error.message === 'INSUFFICIENT_TRAVELER_POINTS')) {
      throw new TrailProgressError('INSUFFICIENT_POINTS',409,'Trail reward could not be settled.');
    }
    throw error;
  } finally { client.release(); }
}

async function awardLegendaryBadge(client: any,userId: string,trailId: string,isTest: boolean) {
  const badgeId='legendary_trailblazer';
  await client.query(`INSERT INTO achievement_definitions(id,track,title,description,badge_icon,category,threshold,criteria_version)
    VALUES($1,'explorer','Legendary Trailblazer','Completed a Legendary trail.','compass','trail',1,'v1') ON CONFLICT(id) DO NOTHING`,[badgeId]);
  await client.query(`INSERT INTO achievement_awards(id,user_id,achievement_id,season,source_evidence_id,evidence_version,criteria_version,
      criteria_snapshot,awarded_at,is_test)
    SELECT $1,$2,$3,'all_time',$4,'v1',d.criteria_version,
      jsonb_build_object('track',d.track,'title',d.title,'description',d.description,'badge_icon',d.badge_icon,'category',d.category,'threshold',d.threshold,'criteria_version',d.criteria_version),
      clock_timestamp(),$5 FROM achievement_definitions d WHERE d.id=$3
    ON CONFLICT(user_id,achievement_id,season) DO NOTHING`,[randomUUID(),userId,badgeId,`trail:${trailId}`,isTest]);
}

export async function getTrailProgress(pool: Pool,userId: string,trailId: string) {
  return readTrailProgress(pool,userId,trailId);
}

async function readTrailProgress(client: { query: (sql: string, values?: any[]) => Promise<any> },userId: string,trailId: string) {
  const result = await client.query(`SELECT s.position,s.spot_id,s.arrive_offset_min,s.dwell_min,s.leg_minutes,s.leg_km,s.narration,
      c.verified_at,c.distance_m,c.accuracy_m
    FROM trail_stops s LEFT JOIN trail_checkins c ON c.trail_id=s.trail_id AND c.user_id=$2 AND c.position=s.position
    WHERE s.trail_id=$1 ORDER BY s.position`,[trailId,userId]);
  return result.rows.map((row: any)=>({position:Number(row.position),spot_id:row.spot_id,arrive_offset_min:Number(row.arrive_offset_min),
    dwell_min:Number(row.dwell_min),leg_minutes:Number(row.leg_minutes),leg_km:Number(row.leg_km),narration:row.narration,
    checked_in:Boolean(row.verified_at),verified_at:row.verified_at ?? null,distance_m:row.distance_m === null ? null : Number(row.distance_m),
    accuracy_m:row.accuracy_m === null ? null : Number(row.accuracy_m)}));
}

