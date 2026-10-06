/** Disposable, loopback-only JuanChoice browser rehearsal. Never point at alpha/production. */
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb } from '../src/db/testHarness.js';
import { createMonthlySchedule, reconcileMonthlySchedulesAt } from '../src/juanchoice/monthly-service.js';
import { localMonth, monthlyWindow, nextMonth } from '../src/juanchoice/monthly-policy.js';
import { finalizeCampaign } from '../src/juanchoice/service.js';

if (!process.env.JDQ_REAL_PG_URL) throw new Error('JDQ_REAL_PG_URL is required; the harness only permits loopback jdq_reliability_test');
if (env.NODE_ENV === 'production') throw new Error('This fixture must not run in production mode');

async function main() {
const fixture = await createTestDb();
setPool(fixture.pool);
db.usersRepo.setPool(fixture.pool);
Object.assign(env, {
  JUANCHOICE_ENABLED: true, JUANCHOICE_SCHEDULER_ENABLED: true,
  JUANCHOICE_WRITES_ENABLED: true, PROGRESSION_ENABLED: true,
  GUEST_LOGIN_ENABLED: true, CORS_ORIGIN: 'http://127.0.0.1:3100',
});

let server: ReturnType<typeof app.listen> | undefined;
let closing = false;
async function stopApi() {
  if (!server) return;
  const active = server;
  server = undefined;
  active.close();
  await once(active, 'close');
}
async function startApi() {
  if (server) return;
  server = app.listen(4100, '127.0.0.1');
  await once(server, 'listening');
}
async function close() {
  if (closing) return;
  closing = true;
  await stopApi();
  setPool(null);
  db.usersRepo.setPool(null);
  await fixture.close();
  process.stdout.write('FIXTURE_CLOSED disposable schema dropped\n');
}

try {
  const now = new Date();
  // The Flutter prototype still uses the legacy demo-login endpoint. Give it
  // a real row in this disposable schema so its protected requests can resolve
  // the same account that received the JWT; never rely on the memory fallback.
  const demoTraveler = db.findUserBySeed('user-1');
  if (!demoTraveler) throw new Error('Demo traveler seed is unavailable');
  await db.usersRepo.findOrCreateBySeedId({
    id: demoTraveler.id, seed_id: demoTraveler.seed_id,
    display_name: demoTraveler.display_name, email: demoTraveler.email,
    avatar_url: demoTraveler.avatar_url, role: demoTraveler.role,
    demo_points: demoTraveler.demo_points,
  });
  // Prepare a future calendar period so reconciliation cannot finalize it
  // against real PostgreSQL time before this disposable fixture moves its window.
  const period = nextMonth(localMonth(now, 'Asia/Manila'));
  for (let index = 0; index < 4; index++) {
    const id = `browser-fixture-spot-${index}`;
    const municipality = ['Bolinao', 'Anda', 'Sual', 'Lingayen'][index];
    await fixture.pool.query(`INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,
      gps_lat,gps_lng,source_type,source_name,is_test)
      VALUES($1,$2,$3,'Disposable browser fixture','nature_outdoors','coast',$4,$5,16,120,'lgu','Fixture',false)`,
      [id, id, `Browser destination ${index + 1}`, municipality, municipality]);
  }
  await createMonthlySchedule({
    schedule_key: 'browser-rehearsal', region_key: 'pangasinan', display_region: 'Pangasinan',
    timezone: 'Asia/Manila', enabled: true, effective_period: period, preparation_lead_days: 7,
    minimum_candidates: 2, target_candidates: 4, maximum_candidates: 6,
    themes: [{ name: 'Coastal discovery', categories: ['nature_outdoors'] }],
    policy_version: 'juanchoice-monthly-v1', is_test: false,
  });
  const opening = monthlyWindow(period, 'Asia/Manila').opensAt;
  const prepared = await reconcileMonthlySchedulesAt(new Date(opening.getTime() - 3 * 86_400_000));
  if (prepared.prepared !== 1) throw new Error(`Expected one prepared campaign; got ${JSON.stringify(prepared)}`);
  const row = (await fixture.pool.query(`SELECT id,campaign_id FROM juanchoice_schedule_periods WHERE period_start=$1`, [period])).rows[0];
  const opensAt = new Date(now.getTime() - 15 * 60_000);
  const closesAt = new Date(now.getTime() + 60 * 60_000);
  await fixture.pool.query('UPDATE juanchoice_schedule_periods SET opens_at=$2,closes_at=$3 WHERE id=$1', [row.id, opensAt, closesAt]);
  await fixture.pool.query('UPDATE juanchoice_campaigns SET opens_at=$2,closes_at=$3 WHERE id=$1', [row.campaign_id, opensAt, closesAt]);
  await startApi();
  process.stdout.write(`FIXTURE_READY campaign=${row.campaign_id} origin=http://127.0.0.1:4100\n`);
  process.stdout.write('Fixture commands: schedule-future, open-round, disable-writes, enable-writes, age-guests, suspend-unvoted, finalize, api-offline, api-online, inspect, stop\n');
  const input = createInterface({ input: process.stdin, terminal: false });
  input.on('line', async line => {
    try {
      const command = line.trim();
      if (command === 'schedule-future' || command === 'open-round') {
        const current = new Date();
        const nextOpen = new Date(current.getTime() + (command === 'schedule-future' ? 60 : -15) * 60_000);
        const nextClose = new Date(current.getTime() + (command === 'schedule-future' ? 120 : 60) * 60_000);
        const client = await fixture.pool.connect();
        try {
          await client.query('BEGIN');
          const changed = await client.query("UPDATE juanchoice_campaigns SET opens_at=$2,closes_at=$3 WHERE id=$1 AND status='scheduled'", [row.campaign_id, nextOpen, nextClose]);
          if (changed.rowCount !== 1) throw new Error('Campaign is no longer scheduled');
          await client.query('UPDATE juanchoice_schedule_periods SET opens_at=$2,closes_at=$3 WHERE id=$1', [row.id, nextOpen, nextClose]);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
        process.stdout.write(`FIXTURE_WINDOW ${command} opens=${nextOpen.toISOString()} closes=${nextClose.toISOString()}\n`);
      } else if (command === 'disable-writes' || command === 'enable-writes') {
        (env as any).JUANCHOICE_WRITES_ENABLED = command === 'enable-writes';
        process.stdout.write(`FIXTURE_WRITES ${env.JUANCHOICE_WRITES_ENABLED}\n`);
      } else if (command === 'age-guests') {
        const result = await fixture.pool.query("UPDATE users SET created_at=NOW()-INTERVAL '4 days' WHERE seed_id LIKE 'guest:%'");
        process.stdout.write(`AGED_GUESTS ${result.rowCount}\n`);
      } else if (command === 'suspend-unvoted') {
        const candidate = (await fixture.pool.query(`SELECT c.id FROM juanchoice_candidates c
          WHERE c.campaign_id=$1 AND c.status='eligible'
            AND NOT EXISTS(SELECT 1 FROM juanchoice_ballots b WHERE b.candidate_id=c.id)
          ORDER BY c.id LIMIT 1`, [row.campaign_id])).rows[0];
        if (!candidate) throw new Error('No unvoted eligible candidate');
        await fixture.pool.query("UPDATE juanchoice_candidates SET status='suspended' WHERE id=$1", [candidate.id]);
        process.stdout.write(`FIXTURE_SUSPENDED ${candidate.id}\n`);
      } else if (command === 'finalize') {
        const pastClose = new Date(Date.now() - 60_000);
        await fixture.pool.query('UPDATE juanchoice_schedule_periods SET closes_at=$2 WHERE id=$1', [row.id, pastClose]);
        await fixture.pool.query("UPDATE juanchoice_campaigns SET closes_at=$2,status='closed' WHERE id=$1", [row.campaign_id, pastClose]);
        const result = await finalizeCampaign(row.campaign_id);
        process.stdout.write(`FIXTURE_FINALIZED ballots=${result.valid_ballots} winners=${JSON.stringify(result.co_winner_ids)}\n`);
      } else if (command === 'api-offline') {
        await stopApi();
        process.stdout.write('FIXTURE_API_OFFLINE\n');
      } else if (command === 'api-online') {
        await startApi();
        process.stdout.write('FIXTURE_API_ONLINE\n');
      } else if (command === 'inspect') {
        const result = await fixture.pool.query(`SELECT
          (SELECT COUNT(*) FROM juanchoice_ballots) AS ballots,
          (SELECT COUNT(*) FROM juanchoice_participations) AS participations,
          (SELECT COALESCE(SUM(delta),0) FROM progression_events WHERE award_kind='xp' AND source_type='juanchoice_participation') AS civic_xp,
          (SELECT COALESCE(SUM(delta),0) FROM progression_events WHERE award_kind='stamp' AND source_type='juanchoice_participation') AS stamps`);
        process.stdout.write(`FIXTURE_COUNTS ${JSON.stringify(result.rows[0])}\n`);
      } else if (command === 'stop') {
        input.close();
        await close();
      }
    } catch (error) { process.stderr.write(`FIXTURE_COMMAND_ERROR ${String(error)}\n`); }
  });
  process.once('SIGINT', () => { void close().finally(() => process.exit()); });
  process.once('SIGTERM', () => { void close().finally(() => process.exit()); });
} catch (error) {
  await close();
  throw error;
}
}

void main().catch(error => {
  process.stderr.write(`FIXTURE_START_ERROR ${String(error)}\n`);
  process.exitCode = 1;
});
