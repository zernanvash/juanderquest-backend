import { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { env } from '../config/env.js';
import { JuanChoiceError } from './service.js';

async function queryMonthlyOverview(regionKey: string, isTest: boolean) {
  const pool = getPool();
  if (!pool) throw new JuanChoiceError('DATABASE_OUTAGE',503);
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const now = new Date((await client.query('SELECT clock_timestamp() AS now')).rows[0].now);
    const schedule = (await client.query(
      `SELECT id,region_key,display_region,timezone,enabled FROM juanchoice_schedules
       WHERE region_key=$1 AND is_test=$2 ORDER BY created_at,id LIMIT 1`,[regionKey,isTest])).rows[0];
    if (!schedule) {
      await client.query('COMMIT');
      return {server_time:now.toISOString(),region:{key:regionKey,label:regionKey==='pangasinan'?'Pangasinan':regionKey,timezone:'Asia/Manila'},
        view:'between' as const,availability:{voting_enabled:false,reason:'NO_SCHEDULE'},current:null,next:null,previous:null,
        notice:{code:'NO_SCHEDULE',message:'The first community round has not been scheduled yet.'}};
    }
    const current = (await client.query(
      `SELECT c.id,c.slug,c.region,c.theme,c.status,c.opens_at,c.closes_at,c.policy_version,p.period_start
       FROM juanchoice_schedule_periods p JOIN juanchoice_campaigns c ON c.id=p.campaign_id
       WHERE p.schedule_id=$1 AND p.status='prepared' AND c.status IN ('scheduled','voting')
         AND p.opens_at <= $2 AND p.closes_at > $2
       ORDER BY p.period_start DESC,p.id DESC LIMIT 1`,[schedule.id,now])).rows[0] ?? null;
    const next = (await client.query(
      `SELECT opens_at,closes_at,selected_theme,status,period_start FROM juanchoice_schedule_periods
       WHERE schedule_id=$1 AND opens_at > $2 AND status IN ('planned','prepared')
       ORDER BY opens_at,id LIMIT 1`,[schedule.id,now])).rows[0] ?? null;
    const previous = (await client.query(
      `SELECT c.id AS campaign_id,c.theme,p.period_start,p.opens_at,p.closes_at,
         r.finalized_at,r.valid_ballots,r.co_winner_ids,r.standings
       FROM juanchoice_schedule_periods p JOIN juanchoice_campaigns c ON c.id=p.campaign_id
       JOIN juanchoice_results r ON r.campaign_id=c.id
       WHERE p.schedule_id=$1 AND c.status IN ('finalized','archived')
       ORDER BY p.period_start DESC,c.id DESC LIMIT 1`,[schedule.id])).rows[0] ?? null;
    const pending = (await client.query(
      `SELECT 1 FROM juanchoice_schedule_periods p JOIN juanchoice_campaigns c ON c.id=p.campaign_id
       LEFT JOIN juanchoice_results r ON r.campaign_id=c.id
       WHERE p.schedule_id=$1 AND p.closes_at <= $2 AND r.campaign_id IS NULL
         AND c.status IN ('scheduled','voting','closed') LIMIT 1`,[schedule.id,now])).rowCount;
    const postponed = (await client.query(
      `SELECT period_start FROM juanchoice_schedule_periods
       WHERE schedule_id=$1 AND status='postponed' AND period_start >= CURRENT_DATE - INTERVAL '2 months'
       ORDER BY period_start DESC LIMIT 1`,[schedule.id])).rows[0] ?? null;
    const availability = {
      voting_enabled: Boolean(schedule.enabled && env.JUANCHOICE_ENABLED && env.JUANCHOICE_WRITES_ENABLED && env.PROGRESSION_ENABLED),
      reason: !schedule.enabled ? 'SCHEDULE_PAUSED'
        : !env.JUANCHOICE_ENABLED ? 'FEATURE_DISABLED'
        : !env.JUANCHOICE_WRITES_ENABLED ? 'WRITES_DISABLED'
        : !env.PROGRESSION_ENABLED ? 'PROGRESSION_DISABLED' : null,
    };
    const notice = pending ? {code:'RESULTS_PENDING',message:'Voting has closed. Results are being finalized.'}
      : postponed ? {code:'ROUND_POSTPONED',message:'A monthly round was postponed because too few destinations were eligible.'}
      : !previous ? {code:'FIRST_ROUND',message:'Results will appear after the first community round.'} : null;
    const dto = {
      server_time:now.toISOString(),
      region:{key:schedule.region_key,label:schedule.display_region,timezone:schedule.timezone},
      view:current?'open' as const:'between' as const,availability,current,
      next:next?{opens_at:next.opens_at,closes_at:next.closes_at,theme:next.selected_theme,
        schedule_status:'scheduled' as const}:null,
      previous:previous?{...previous,period_label:new Intl.DateTimeFormat('en-PH',{timeZone:schedule.timezone,
        month:'long',year:'numeric'}).format(new Date(previous.opens_at))}:null,
      notice,
    };
    await client.query('COMMIT');
    return dto;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

const overviewInFlight = new Map<string, Promise<Awaited<ReturnType<typeof queryMonthlyOverview>>>>();

// Coalesce only overlapping identical reads. Do not retain a cached response:
// the server clock, round boundary and feature flags must be re-evaluated on
// the next polling wave. Public and QA scopes never share a promise.
export function getMonthlyOverview(regionKey: string, isTest = false) {
  const key = JSON.stringify([regionKey, isTest, env.JUANCHOICE_ENABLED,
    env.JUANCHOICE_WRITES_ENABLED, env.PROGRESSION_ENABLED]);
  const existing = overviewInFlight.get(key);
  if (existing) return existing;
  const pending = queryMonthlyOverview(regionKey, isTest);
  overviewInFlight.set(key, pending);
  const clear = () => { if (overviewInFlight.get(key) === pending) overviewInFlight.delete(key); };
  void pending.then(clear, clear);
  return pending;
}
