import { createHash, randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { env } from '../config/env.js';
import { finalizeDueCampaigns, JuanChoiceError } from './service.js';
import { localMonth, monthlyWindow, nextMonth, selectMonthlyCandidates, themeForPeriod, MonthlyCandidate, MonthlyTheme } from './monthly-policy.js';
import { isMonday, isoWeekKey, localWeek, nextWeek, roundTier, weeklyRoundNumber, weeklyWindow } from './weekly-policy.js';
import { buildManifesto, markMystery, pickMysteryCandidate, unlockedPerkCount } from './perks.js';
import { WEEKLY_POLICY_VERSION } from './promotion-safety.js';

export interface MonthlySchedule {
  id: string; schedule_key: string; region_key: string; display_region: string; timezone: string;
  enabled: boolean; effective_period: string | Date; preparation_lead_days: number;
  minimum_candidates: number; target_candidates: number; maximum_candidates: number;
  themes: MonthlyTheme[]; policy_version: string; is_test: boolean;
  /** Plan 65: weekly rounds (Monday to Monday, Asia/Manila) beside the original monthly cadence. */
  cadence?: 'monthly' | 'weekly';
  winner_cooldown_weeks?: number; minister_cooldown_weeks?: number; special_round_interval_weeks?: number;
}

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const isWeekly = (schedule: Pick<MonthlySchedule, 'cadence'>) => schedule.cadence === 'weekly';
const periodWindow = (schedule: MonthlySchedule, period: string) =>
  isWeekly(schedule) ? weeklyWindow(period, schedule.timezone) : monthlyWindow(period, schedule.timezone);
/** Winner cooldown: 90 days for monthly rounds; Plan 65 D9 weeks for weekly rounds. */
const winnerCooldownMs = (schedule: MonthlySchedule) =>
  isWeekly(schedule) ? (schedule.winner_cooldown_weeks ?? 4) * WEEK_MS : 90 * DAY_MS;

function pool(): Pool {
  const value = getPool();
  if (!value) throw new JuanChoiceError('DATABASE_OUTAGE', 503);
  return value;
}

function dateOnly(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

export function validateMonthlyThemes(themes: MonthlyTheme[]): void {
  const validCategories = new Set(['eat_drink', 'nature_outdoors', 'culture_heritage', 'activities_wellness', 'shopping_local', 'stay']);
  if (!Array.isArray(themes) || themes.length < 1 || themes.length > 12) throw new JuanChoiceError('INVALID_MONTHLY_THEMES', 400);
  const names = new Set<string>();
  for (const theme of themes) {
    if (!theme || typeof theme.name !== 'string' || theme.name.trim().length < 3 || theme.name.length > 100 || names.has(theme.name)
      || !Array.isArray(theme.categories) || theme.categories.length < 1 || theme.categories.length > 6
      || theme.categories.some(category => !validCategories.has(category))) throw new JuanChoiceError('INVALID_MONTHLY_THEMES', 400);
    names.add(theme.name);
  }
}

export async function createMonthlySchedule(input: Omit<MonthlySchedule, 'id'>, actorId?:string): Promise<MonthlySchedule> {
  validateMonthlyThemes(input.themes);
  const weekly = input.cadence === 'weekly';
  if (input.timezone !== 'Asia/Manila' || input.region_key !== 'pangasinan'
    || (weekly ? !isMonday(dateOnly(input.effective_period)) || input.policy_version !== WEEKLY_POLICY_VERSION
      : !/^\d{4}-\d{2}-01$/.test(dateOnly(input.effective_period)))) {
    throw new JuanChoiceError('UNSUPPORTED_MONTHLY_SCHEDULE', 400);
  }
  const client=await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO juanchoice_schedules
       (id,schedule_key,region_key,display_region,timezone,enabled,effective_period,preparation_lead_days,
        minimum_candidates,target_candidates,maximum_candidates,themes,policy_version,is_test,cadence)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)
       ON CONFLICT(schedule_key,is_test) DO NOTHING RETURNING *`,
      [randomUUID(),input.schedule_key,input.region_key,input.display_region,input.timezone,input.enabled,dateOnly(input.effective_period),
        input.preparation_lead_days,input.minimum_candidates,input.target_candidates,input.maximum_candidates,
        JSON.stringify(input.themes),input.policy_version,input.is_test,weekly?'weekly':'monthly']
    );
    let row=result.rows[0] as MonthlySchedule|undefined;
    if (row) {
      await client.query(`INSERT INTO juanchoice_schedule_audit(id,schedule_id,actor_kind,actor_id,action)
        VALUES($1,$2,$3,$4,'created')`,[randomUUID(),row.id,actorId?'admin':'system',actorId??null]);
    } else {
      row=(await client.query('SELECT * FROM juanchoice_schedules WHERE schedule_key=$1 AND is_test=$2',
        [input.schedule_key,input.is_test])).rows[0] as MonthlySchedule|undefined;
      if(!row || row.region_key!==input.region_key || row.display_region!==input.display_region ||
        row.timezone!==input.timezone || dateOnly(row.effective_period)!==dateOnly(input.effective_period) ||
        row.policy_version!==input.policy_version || row.minimum_candidates!==input.minimum_candidates ||
        row.target_candidates!==input.target_candidates || row.maximum_candidates!==input.maximum_candidates ||
        JSON.stringify(row.themes)!==JSON.stringify(input.themes)) throw new JuanChoiceError('SCHEDULE_EXISTS',409);
    }
    const committed=await client.query('COMMIT');
    if(committed.command!=='COMMIT')throw new JuanChoiceError('COMMIT_FAILED',503);
    return row;
  } catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

async function audit(client: PoolClient, scheduleId: string, periodId: string | null, action: string, reason?: string): Promise<void> {
  await client.query(
    `INSERT INTO juanchoice_schedule_audit(id,schedule_id,period_id,actor_kind,action,reason_code)
     VALUES($1,$2,$3,'system',$4,$5)`, [randomUUID(),scheduleId,periodId,action,reason ?? null]
  );
}

async function ensurePeriod(client: PoolClient, schedule: MonthlySchedule, period: string, now: Date): Promise<any> {
  const existing=(await client.query('SELECT * FROM juanchoice_schedule_periods WHERE schedule_id=$1 AND period_start=$2 FOR UPDATE',
    [schedule.id,period])).rows[0];
  if(existing)return existing;
  const { opensAt, closesAt } = periodWindow(schedule,period);
  // A weekly booth may still open late in its own week (no empty booth after a deploy),
  // but not in its final day.
  const missed = isWeekly(schedule) ? now >= new Date(closesAt.getTime() - DAY_MS) : now >= opensAt;
  const result = await client.query(
    `INSERT INTO juanchoice_schedule_periods
     (id,schedule_id,period_start,opens_at,closes_at,status,reason_code,policy_snapshot)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     ON CONFLICT(schedule_id,period_start) DO NOTHING RETURNING *`,
    [randomUUID(),schedule.id,period,opensAt,closesAt,missed?'missed':'planned',missed?'PREPARATION_WINDOW_MISSED':null,
      JSON.stringify({version:schedule.policy_version,themes:schedule.themes,
        minimum_candidates:schedule.minimum_candidates,target_candidates:schedule.target_candidates,
        maximum_candidates:schedule.maximum_candidates,preparation_lead_days:schedule.preparation_lead_days})]
  );
  if (result.rows[0]) {
    if (missed) await audit(client,schedule.id,result.rows[0].id,'missed','PREPARATION_WINDOW_MISSED');
    return result.rows[0];
  }
  return (await client.query('SELECT * FROM juanchoice_schedule_periods WHERE schedule_id=$1 AND period_start=$2 FOR UPDATE',
    [schedule.id,period])).rows[0];
}

async function eligibleCandidates(client: PoolClient, schedule: MonthlySchedule, now: Date): Promise<MonthlyCandidate[]> {
  // This pilot's taxonomy is Pangasinan-only. Reject other region keys until spots have durable region identity.
  if (schedule.region_key !== 'pangasinan') throw new JuanChoiceError('UNSUPPORTED_REGION', 400);
  const spots = (await client.query(
    `SELECT id,category,municipality,crowd_capacity_band,recommendation_suppressed
     FROM spots WHERE status='published' AND is_test=$1 AND recommendation_suppressed=FALSE ORDER BY id`,
    [schedule.is_test]
  )).rows;
  if (!spots.length) return [];
  const [events, prior] = await Promise.all([
    client.query(`SELECT spot_id,user_id,activity_type,created_at,is_test FROM spot_activity_events
                  WHERE created_at >= $1 AND is_test=$2`,[new Date(now.getTime()-86400000),schedule.is_test]),
    client.query(`SELECT c.spot_id,c.created_at AS nominated_at,p.closes_at,r.co_winner_ids,c.id AS candidate_id
                  FROM juanchoice_candidates c JOIN juanchoice_campaigns p ON p.id=c.campaign_id
                  LEFT JOIN juanchoice_results r ON r.campaign_id=p.id
                  WHERE c.is_test=$1 AND p.is_test=$1 AND p.status <> 'cancelled'`,[schedule.is_test]),
  ]);
  const nomination = new Map<string,number>();
  const won = new Map<string,number>();
  for (const row of prior.rows) {
    const time = new Date(row.nominated_at).getTime();
    nomination.set(row.spot_id,Math.max(nomination.get(row.spot_id) ?? -Infinity,time));
    if (Array.isArray(row.co_winner_ids) && row.co_winner_ids.includes(row.candidate_id)) {
      won.set(row.spot_id,Math.max(won.get(row.spot_id) ?? -Infinity,new Date(row.closes_at).getTime()));
    }
  }
  const weight: Record<string,number> = {view:.25,directions:3,save:2,visit:5};
  return spots.map(spot => {
    const related = events.rows.filter(row => row.spot_id === spot.id);
    const score = related.reduce((sum,row) => sum + (weight[row.activity_type] ?? 0) * Math.pow(.5,
      (now.getTime()-new Date(row.created_at).getTime())/21600000),0);
    const threshold = {low:8,medium:15,high:30}[spot.crowd_capacity_band as 'low'|'medium'|'high'] ?? 15;
    const lastNominated = nomination.get(spot.id);
    const lastWon = won.get(spot.id);
    return {id:spot.id,category:spot.category,municipality:spot.municipality,
      recommendation_suppressed:Boolean(spot.recommendation_suppressed),
      crowd_status:related.length===0?'unknown':Number(score.toFixed(2))>=threshold?'estimated_busy':'moderate',
      last_nominated_at:lastNominated===undefined?null:new Date(lastNominated).toISOString(),
      last_won_at:lastWon===undefined?null:new Date(lastWon).toISOString()} as MonthlyCandidate;
  });
}

interface SpotElectionState { consecutive_losses: number; last_won_at: Date | null; last_minister_at: Date | null }

async function loadElectionState(client: PoolClient, isTest: boolean): Promise<Map<string, SpotElectionState>> {
  const rows = (await client.query(
    'SELECT spot_id,consecutive_losses,last_won_at,last_minister_at FROM juanchoice_spot_election_state WHERE is_test=$1',
    [isTest])).rows;
  return new Map(rows.map(row => [row.spot_id, {
    consecutive_losses: Number(row.consecutive_losses),
    last_won_at: row.last_won_at ? new Date(row.last_won_at) : null,
    last_minister_at: row.last_minister_at ? new Date(row.last_minister_at) : null,
  }]));
}

/** Plan 65 D9: a weekly Champion sits out 4 weeks and a Minister 2 (per schedule). */
function passesWeeklyCooldown(schedule: MonthlySchedule, state: SpotElectionState | undefined, opensAt: Date): boolean {
  if (!state) return true;
  const won = state.last_won_at && state.last_won_at.getTime() > opensAt.getTime() - (schedule.winner_cooldown_weeks ?? 4) * WEEK_MS;
  const minister = state.last_minister_at
    && state.last_minister_at.getTime() > opensAt.getTime() - (schedule.minister_cooldown_weeks ?? 2) * WEEK_MS;
  return !won && !minister;
}

/**
 * Insert a round's candidates. Weekly rounds carry a deterministic manifesto whose size grows
 * with the spot's losing streak (2 to 4 perks), and one mystery perk per round.
 */
async function insertCandidates(client: PoolClient, schedule: MonthlySchedule, campaignId: string, seed: string,
  spotIds: string[], festival: boolean, now: Date, allowMystery = true): Promise<void> {
  if (!isWeekly(schedule)) {
    for (const spotId of spotIds) {
      await client.query('INSERT INTO juanchoice_candidates(id,campaign_id,spot_id,is_test) VALUES($1,$2,$3,$4)',
        [randomUUID(),campaignId,spotId,schedule.is_test]);
    }
    return;
  }
  if (!spotIds.length) return;
  const spots = new Map((await client.query('SELECT id,name,municipality,category FROM spots WHERE id = ANY($1::text[])',
    [spotIds])).rows.map(row => [row.id, row]));
  const state = await loadElectionState(client, schedule.is_test);
  // A safety replacement never adds a second mystery perk to a round.
  const mysteryId = allowMystery ? pickMysteryCandidate(seed, spotIds) : null;
  for (const spotId of spotIds) {
    const spot = spots.get(spotId);
    if (!spot) throw new JuanChoiceError('INVALID_SPOT', 422);
    const losses = Math.min(10, state.get(spotId)?.consecutive_losses ?? 0);
    const count = unlockedPerkCount(losses);
    let perks = buildManifesto({ seed, spotId, spotName: spot.name, municipality: spot.municipality, category: spot.category,
      count, festival });
    if (spotId === mysteryId) perks = markMystery(perks);
    await client.query(
      `INSERT INTO juanchoice_candidates(id,campaign_id,spot_id,is_test,manifesto_perks,prior_loss_streak,unlocked_perk_count)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [randomUUID(),campaignId,spotId,schedule.is_test,JSON.stringify(perks),losses,count]);
    await client.query(
      `INSERT INTO juanchoice_spot_election_state(spot_id,is_test,last_nominated_at,updated_at) VALUES($1,$2,$3,NOW())
       ON CONFLICT(spot_id,is_test) DO UPDATE SET last_nominated_at=EXCLUDED.last_nominated_at,updated_at=NOW()`,
      [spotId,schedule.is_test,now]);
  }
}

async function recheckPreparedPeriod(client:PoolClient,schedule:MonthlySchedule,row:any,now:Date):Promise<'unchanged'|'replaced'|'cancelled'> {
  if(!row.campaign_id || now >= new Date(row.opens_at))return 'unchanged';
  // Match ballot/moderation lock order: campaign before its candidates. A terminal
  // campaign belongs to history; reconciliation must not re-edit its roster.
  const campaign=(await client.query('SELECT status,is_test,round_tier FROM juanchoice_campaigns WHERE id=$1 FOR UPDATE',
    [row.campaign_id])).rows[0];
  if(!campaign || !['scheduled','voting'].includes(campaign.status))return 'unchanged';
  if(campaign.is_test!==schedule.is_test)throw new JuanChoiceError('SCOPE_MISMATCH',409);
  const ballotCount=(await client.query('SELECT 1 FROM juanchoice_ballots WHERE campaign_id=$1 LIMIT 1',[row.campaign_id])).rowCount;
  if(ballotCount)return 'unchanged';
  const existing=(await client.query(`SELECT c.id,c.spot_id,c.status,c.is_test AS candidate_is_test,s.municipality,s.category,s.status AS spot_status,
       s.recommendation_suppressed
     FROM juanchoice_candidates c JOIN spots s ON s.id=c.spot_id
     WHERE c.campaign_id=$1 ORDER BY c.created_at,c.id FOR UPDATE`,[row.campaign_id])).rows;
  const poolCandidates=await eligibleCandidates(client,schedule,now);
  const eligibleById=new Map(poolCandidates.map(candidate=>[candidate.id,candidate]));
  const opensAt=new Date(row.opens_at);
  const state=isWeekly(schedule)?await loadElectionState(client,schedule.is_test):null;
  const cooledDown=(candidate:MonthlyCandidate)=>
    (!candidate.last_won_at||Date.parse(candidate.last_won_at)<opensAt.getTime()-winnerCooldownMs(schedule))
    &&(!state||passesWeeklyCooldown(schedule,state.get(candidate.id),opensAt));
  const live=existing.filter(item=>{
    const candidate=eligibleById.get(item.spot_id);
    return candidate!==undefined&&item.candidate_is_test===schedule.is_test
      &&item.status==='eligible'&&item.spot_status==='published'&&!item.recommendation_suppressed
      &&candidate.crowd_status!=='estimated_busy'&&cooledDown(candidate);
  });
  const invalid=existing.filter(item=>item.status==='eligible'&&!live.some(kept=>kept.id===item.id));
  if(!invalid.length&&live.length>=schedule.minimum_candidates)return 'unchanged';
  for(const item of invalid){
    await client.query("UPDATE juanchoice_candidates SET status='suspended' WHERE id=$1",[item.id]);
  }
  const selectedTheme=String(row.selected_theme);
  const theme=schedule.themes.find(item=>item.name===selectedTheme);
  if(!theme)throw new JuanChoiceError('SCHEDULE_THEME_MISSING',409);
  const oldIds=new Set(existing.map(item=>item.spot_id));
  const countByMunicipality=new Map<string,number>();
  for(const item of live)countByMunicipality.set(item.municipality,(countByMunicipality.get(item.municipality)??0)+1);
  const alternatives=poolCandidates.filter(candidate=>!oldIds.has(candidate.id)&&theme.categories.includes(candidate.category)
    &&candidate.crowd_status!=='estimated_busy'&&!candidate.recommendation_suppressed&&cooledDown(candidate));
  alternatives.sort((a,b)=>{
    const left=a.last_nominated_at?Date.parse(a.last_nominated_at):-Infinity;
    const right=b.last_nominated_at?Date.parse(b.last_nominated_at):-Infinity;
    if(left!==right)return left-right;
    return createHash('sha256').update(`${dateOnly(row.period_start)}:${a.id}`).digest('hex')
      .localeCompare(createHash('sha256').update(`${dateOnly(row.period_start)}:${b.id}`).digest('hex'));
  });
  const replacements:MonthlyCandidate[]=[];
  for(const option of alternatives){
    if(live.length+replacements.length>=schedule.target_candidates)break;
    const count=countByMunicipality.get(option.municipality)??0;
    if(count>=2)continue;
    replacements.push(option);countByMunicipality.set(option.municipality,count+1);
  }
  if(live.length+replacements.length<schedule.minimum_candidates){
    await client.query("UPDATE juanchoice_campaigns SET status='cancelled' WHERE id=$1",[row.campaign_id]);
    await client.query(`UPDATE juanchoice_schedule_periods SET status='cancelled',reason_code='CANDIDATES_WITHDRAWN',updated_at=NOW()
      WHERE id=$1`,[row.id]);
    await audit(client,schedule.id,row.id,'cancelled','CANDIDATES_WITHDRAWN');
    return 'cancelled';
  }
  await insertCandidates(client,schedule,row.campaign_id,String(row.selection_seed ?? row.id),
    replacements.map(item=>item.id),campaign.round_tier==='special_festival',now,false);
  await audit(client,schedule.id,row.id,replacements.length?'candidates_replaced':'candidates_suspended','SAFETY_RECHECK');
  return 'replaced';
}

async function reconcileSchedule(scheduleId: string, now: Date): Promise<{prepared:number;postponed:number;missed:number}> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    // Region lock precedes schedule/period/campaign locks; admin publication must use the same order.
    const identity = (await client.query('SELECT region_key,display_region FROM juanchoice_schedules WHERE id=$1',[scheduleId])).rows[0];
    if (!identity) throw new JuanChoiceError('SCHEDULE_NOT_FOUND',404);
    await client.query('INSERT INTO juanchoice_region_locks(region) VALUES($1) ON CONFLICT(region) DO NOTHING',[identity.display_region]);
    await client.query('SELECT region FROM juanchoice_region_locks WHERE region=$1 FOR UPDATE',[identity.display_region]);
    const schedule = (await client.query('SELECT * FROM juanchoice_schedules WHERE id=$1 FOR UPDATE',[scheduleId])).rows[0] as MonthlySchedule;
    if (!schedule.enabled) { await client.query('COMMIT'); return {prepared:0,postponed:0,missed:0}; }
    validateMonthlyThemes(schedule.themes);
    const weekly = isWeekly(schedule);
    const current = weekly ? localWeek(now,schedule.timezone) : localMonth(now,schedule.timezone);
    const first = dateOnly(schedule.effective_period);
    const periods = [current,weekly ? nextWeek(current) : nextMonth(current)].filter(period => period >= first);
    const festivals = weekly ? (await client.query(
      `SELECT name,to_char(starts_on,'YYYY-MM-DD') AS starts_on,to_char(ends_on,'YYYY-MM-DD') AS ends_on,boost_multiplier
       FROM juanchoice_festivals WHERE is_test=$1`,[schedule.is_test])).rows : [];
    const outcome = {prepared:0,postponed:0,missed:0};
    for (const period of periods) {
      const row = await ensurePeriod(client,schedule,period,now);
      if (row.status === 'missed') { outcome.missed++; continue; }
      if (row.status === 'prepared') { await recheckPreparedPeriod(client,schedule,row,now); continue; }
      if (row.status !== 'planned') continue;
      const opensAt = new Date(row.opens_at);
      const lateWeeklyStart = weekly && now < new Date(new Date(row.closes_at).getTime() - DAY_MS);
      if (now >= opensAt && !lateWeeklyStart) {
        await client.query("UPDATE juanchoice_schedule_periods SET status='missed',reason_code='PREPARATION_WINDOW_MISSED',updated_at=NOW() WHERE id=$1",[row.id]);
        await audit(client,schedule.id,row.id,'missed','PREPARATION_WINDOW_MISSED'); outcome.missed++; continue;
      }
      if (now.getTime() < opensAt.getTime()-schedule.preparation_lead_days*86400000) continue;
      const round = weekly ? weeklyRoundNumber(period,first) : 0;
      const primaryTheme = weekly ? schedule.themes[(round - 1) % schedule.themes.length] : themeForPeriod(period,schedule.themes,first);
      let candidates = await eligibleCandidates(client,schedule,now);
      if (weekly) {
        const state = await loadElectionState(client,schedule.is_test);
        candidates = candidates.filter(candidate => passesWeeklyCooldown(schedule,state.get(candidate.id),opensAt));
      }
      const selected = selectMonthlyCandidates({candidates,themes:schedule.themes,primaryTheme,period,
        minimum:schedule.minimum_candidates,target:Math.min(schedule.target_candidates,schedule.maximum_candidates),
        cooldownMs:winnerCooldownMs(schedule),closesAt:opensAt});
      if (!selected) {
        await client.query(`UPDATE juanchoice_schedule_periods SET status='postponed',reason_code='INSUFFICIENT_CANDIDATES',
          attempt_count=attempt_count+1,last_attempt_at=NOW(),updated_at=NOW() WHERE id=$1`,[row.id]);
        await audit(client,schedule.id,row.id,'postponed','INSUFFICIENT_CANDIDATES'); outcome.postponed++; continue;
      }
      const overlap = (await client.query(
        `SELECT id FROM juanchoice_campaigns WHERE region=$1 AND is_test=$2 AND status IN ('scheduled','voting','closed','finalized')
         AND opens_at < $3 AND closes_at > $4 LIMIT 1`,
        [schedule.display_region,schedule.is_test,row.closes_at,row.opens_at])).rows[0];
      if (overlap) {
        await client.query(`UPDATE juanchoice_schedule_periods SET status='postponed',reason_code='REGIONAL_ROUND_OVERLAP',
          attempt_count=attempt_count+1,last_attempt_at=NOW(),updated_at=NOW() WHERE id=$1`,[row.id]);
        await audit(client,schedule.id,row.id,'postponed','REGIONAL_ROUND_OVERLAP'); outcome.postponed++; continue;
      }
      const campaignId = randomUUID();
      // schedule_key is only unique within its real/test scope; campaign slugs
      // are globally unique. Include the durable schedule identity in new URLs.
      const seed = createHash('sha256').update(`${schedule.schedule_key}:${period}:${schedule.policy_version}`).digest('hex');
      const tier = weekly ? roundTier({ roundNumber: round, intervalWeeks: schedule.special_round_interval_weeks ?? 4, period, festivals })
        : { tier: 'standard' as const, festivalName: null, multiplier: 1 };
      const slug = weekly ? `weekly-${isoWeekKey(period)}-${schedule.id}` : `monthly-${period.slice(0,7)}-${schedule.id}`;
      const theme = weekly
        ? (tier.festivalName ? `${tier.festivalName} — Festival Election` : tier.tier === 'special_festival'
          ? `${selected.theme.name} — Special Election` : selected.theme.name)
        : selected.theme.name;
      await client.query(
        `INSERT INTO juanchoice_campaigns(id,slug,region,theme,status,opens_at,closes_at,is_test,policy_version,
           round_tier,festival_name,blind_tally_hours)
         VALUES($1,$2,$3,$4,'scheduled',$5,$6,$7,$8,$9,$10,$11)`,
        [campaignId,slug,schedule.display_region,theme,row.opens_at,row.closes_at,schedule.is_test,schedule.policy_version,
          tier.tier,tier.festivalName,weekly?24:0]
      );
      await insertCandidates(client,schedule,campaignId,seed,selected.selected.map(candidate=>candidate.id),
        tier.tier==='special_festival',now);
      await client.query(
        `UPDATE juanchoice_schedule_periods SET status='prepared',campaign_id=$2,selected_theme=$3,selection_seed=$4,
         prepared_at=NOW(),attempt_count=attempt_count+1,last_attempt_at=NOW(),updated_at=NOW() WHERE id=$1`,
        [row.id,campaignId,selected.theme.name,seed]
      );
      await audit(client,schedule.id,row.id,'prepared'); outcome.prepared++;
    }
    const commit = await client.query('COMMIT');
    if (commit.command !== 'COMMIT') throw new JuanChoiceError('COMMIT_FAILED',503);
    return outcome;
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }
}

export async function reconcileMonthlySchedules(limit=20): Promise<{schedules:number;prepared:number;postponed:number;missed:number;finalized:number;failed:number}> {
  if (!env.JUANCHOICE_ENABLED || !env.JUANCHOICE_SCHEDULER_ENABLED) {
    return {schedules:0,prepared:0,postponed:0,missed:0,finalized:0,failed:0};
  }
  const now = new Date((await pool().query('SELECT clock_timestamp() AS now')).rows[0].now);
  return reconcileMonthlySchedulesAt(now,limit);
}

// Internal deterministic test seam. Public routes and workers always use database time above.
export async function reconcileMonthlySchedulesAt(now:Date,limit=20): Promise<{schedules:number;prepared:number;postponed:number;missed:number;finalized:number;failed:number}> {
  if (!env.JUANCHOICE_ENABLED || !env.JUANCHOICE_SCHEDULER_ENABLED) {
    return {schedules:0,prepared:0,postponed:0,missed:0,finalized:0,failed:0};
  }
  const rows = (await pool().query('SELECT id FROM juanchoice_schedules WHERE enabled=TRUE ORDER BY schedule_key,is_test LIMIT $1',[limit])).rows;
  const summary = {schedules:0,prepared:0,postponed:0,missed:0,finalized:0,failed:0};
  for (const row of rows) {
    try {
      const result = await reconcileSchedule(row.id,now);
      summary.schedules++; summary.prepared += result.prepared; summary.postponed += result.postponed; summary.missed += result.missed;
    } catch (error) { summary.failed++; console.error('[juanchoice-scheduler]',row.id,error); }
  }
  summary.finalized = (await finalizeDueCampaigns(limit)).processed;
  return summary;
}
