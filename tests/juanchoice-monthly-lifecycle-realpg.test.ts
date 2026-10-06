import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db as domainDb } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { createMonthlySchedule, reconcileMonthlySchedulesAt } from '../src/juanchoice/monthly-service.js';
import { getMonthlyOverview } from '../src/juanchoice/monthly-overview.js';
import { getStandings } from '../src/juanchoice/service.js';
import { localMonth, monthlyWindow, nextMonth } from '../src/juanchoice/monthly-policy.js';

const realIt = process.env.JDQ_REAL_PG_URL ? it : it.skip;

describe('monthly JuanChoice API lifecycle on isolated real PostgreSQL', () => {
  let fixture: TestDbInstance;
  const voterId = `monthly-voter-${randomUUID()}`;
  const adminId = `monthly-admin-${randomUUID()}`;
  const originalFlags = {
    JUANCHOICE_ENABLED: env.JUANCHOICE_ENABLED,
    JUANCHOICE_SCHEDULER_ENABLED: env.JUANCHOICE_SCHEDULER_ENABLED,
    JUANCHOICE_WRITES_ENABLED: env.JUANCHOICE_WRITES_ENABLED,
    PROGRESSION_ENABLED: env.PROGRESSION_ENABLED,
  };

  beforeAll(async () => {
    if (!process.env.JDQ_REAL_PG_URL) return;
    fixture = await createTestDb();
    setPool(fixture.pool);
    domainDb.usersRepo.setPool(fixture.pool);
    Object.assign(env, {
      JUANCHOICE_ENABLED: true,
      JUANCHOICE_SCHEDULER_ENABLED: true,
      JUANCHOICE_WRITES_ENABLED: false,
      PROGRESSION_ENABLED: true,
    });
  }, 120_000);

  afterAll(async () => {
    if (!fixture) return;
    setPool(null);
    domainDb.usersRepo.setPool(null);
    Object.assign(env, originalFlags);
    await fixture.close();
  });

  realIt('prepares, opens, ballots, closes, finalizes and projects the next/previous round without duplicate rewards', async () => {
    const now = new Date();
    const period = localMonth(now, 'Asia/Manila');
    const monthlyOpening = monthlyWindow(period, 'Asia/Manila').opensAt;
    const preparationTime = new Date(monthlyOpening.getTime() - 3 * 86_400_000);
    await fixture.pool.query(`INSERT INTO users(id,seed_id,display_name,email,created_at,is_test)
      VALUES($1,$2,'Monthly voter',$3,$4,false),($5,$6,'Monthly admin',$7,$4,false)`,
      [voterId, 'monthly-voter', `${voterId}@example.test`, new Date(now.getTime() - 4 * 86_400_000),
        adminId, 'monthly-admin', `${adminId}@example.test`]);
    await fixture.pool.query("UPDATE users SET role='admin' WHERE id=$1", [adminId]);
    for (let index = 0; index < 4; index++) {
      const id = `lifecycle-spot-${index}`;
      await fixture.pool.query(`INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,
        gps_lat,gps_lng,source_type,source_name,is_test)
        VALUES($1,$2,$3,'Lifecycle fixture','nature_outdoors','coast',$4,$5,16,120,'lgu','Fixture',false)`,
      [id, id, `Lifecycle destination ${index}`,
        ['Bolinao', 'Anda', 'Sual', 'Lingayen'][index], ['Bolinao', 'Anda', 'Sual', 'Lingayen'][index]]);
    }
    const schedule = await createMonthlySchedule({
      schedule_key: 'lifecycle-monthly', region_key: 'pangasinan', display_region: 'Pangasinan',
      timezone: 'Asia/Manila', enabled: true, effective_period: period, preparation_lead_days: 7,
      minimum_candidates: 2, target_candidates: 4, maximum_candidates: 6,
      themes: [{ name: 'Coastal discovery', categories: ['nature_outdoors'] }],
      policy_version: 'juanchoice-monthly-v1', is_test: false,
    });
    expect((await reconcileMonthlySchedulesAt(preparationTime)).prepared).toBe(1);
    const prepared = (await fixture.pool.query(`SELECT p.id AS period_id,p.campaign_id,c.status
      FROM juanchoice_schedule_periods p JOIN juanchoice_campaigns c ON c.id=p.campaign_id
      WHERE p.schedule_id=$1 AND p.period_start=$2`, [schedule.id, period])).rows[0];
    expect(prepared.status).toBe('scheduled');

    // The API always uses PostgreSQL clock_timestamp(). Only this isolated test
    // fixture moves the prepared period around the actual database clock.
    const opening = new Date(now.getTime() - 30 * 60_000);
    const closing = new Date(now.getTime() + 30 * 60_000);
    await fixture.pool.query('UPDATE juanchoice_schedule_periods SET opens_at=$2,closes_at=$3 WHERE id=$1',
      [prepared.period_id, opening, closing]);
    await fixture.pool.query('UPDATE juanchoice_campaigns SET opens_at=$2,closes_at=$3 WHERE id=$1',
      [prepared.campaign_id, opening, closing]);

    const overviewOpen = await request(app).get('/api/v1/juanchoice/overview');
    expect(overviewOpen.status).toBe(200);
    expect(overviewOpen.body.data.current.id).toBe(prepared.campaign_id);
    expect(overviewOpen.body.data.previous).toBeNull();
    expect(overviewOpen.body.data.availability.reason).toBe('WRITES_DISABLED');

    const [sameOverviewA, sameOverviewB] = await Promise.all([
      getMonthlyOverview('pangasinan', false), getMonthlyOverview('pangasinan', false),
    ]);
    expect(sameOverviewA).toBe(sameOverviewB);
    const [publicOverview, qaOverview] = await Promise.all([
      getMonthlyOverview('pangasinan', false), getMonthlyOverview('pangasinan', true),
    ]);
    expect(publicOverview).not.toBe(qaOverview);
    expect(qaOverview.current).toBeNull();

    const candidates = (await fixture.pool.query('SELECT id FROM juanchoice_candidates WHERE campaign_id=$1 ORDER BY id',
      [prepared.campaign_id])).rows;
    expect(candidates).toHaveLength(4);
    const [sameStandingsA, sameStandingsB] = await Promise.all([
      getStandings(prepared.campaign_id, false), getStandings(prepared.campaign_id, false),
    ]);
    expect(sameStandingsA).toBe(sameStandingsB);
    expect(sameStandingsA.standings.reduce((sum: number, item: { votes: number }) => sum + Number(item.votes), 0)).toBe(0);
    const token = jwt.sign({ id: voterId, role: 'user' }, env.JWT_SECRET);
    const voteUrl = `/api/v1/juanchoice/campaigns/${prepared.campaign_id}/ballot`;
    const ballotBody = { candidate_id: candidates[0].id, expected_version: 0 };
    const key = randomUUID();
    const disabledVote = await request(app).put(voteUrl).set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key).send(ballotBody);
    expect(disabledVote.status).toBe(503);
    expect(disabledVote.body.error.code).toBe('WRITES_DISABLED');
    expect((await fixture.pool.query('SELECT COUNT(*)::int AS n FROM juanchoice_ballots WHERE campaign_id=$1',
      [prepared.campaign_id])).rows[0].n).toBe(0);
    expect((await fixture.pool.query("SELECT COUNT(*)::int AS n FROM progression_events WHERE source_type='juanchoice_participation' AND source_id=$1",
      [prepared.campaign_id])).rows[0].n).toBe(0);
    (env as any).JUANCHOICE_WRITES_ENABLED = true;
    const first = await request(app).put(voteUrl).set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key).send(ballotBody);
    expect(first.status).toBe(200);
    expect(first.body.data.participation).toEqual({ civic_xp: 25, stamps: 1, token_grant_mjdq: '0' });
    expect(first.body.data.replayed).toBe(false);
    const freshStandings = await getStandings(prepared.campaign_id, false);
    expect(freshStandings).not.toBe(sameStandingsA);
    expect(freshStandings.standings.reduce((sum: number, item: { votes: number }) => sum + Number(item.votes), 0)).toBe(1);
    const replay = await request(app).put(voteUrl).set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key).send(ballotBody);
    expect(replay.status).toBe(200);
    expect(replay.body.data.replayed).toBe(true);
    const totals = (await fixture.pool.query('SELECT civic_xp,civic_stamps FROM progression_totals WHERE user_id=$1', [voterId])).rows[0];
    expect(Number(totals.civic_xp)).toBe(25);
    expect(Number(totals.civic_stamps)).toBe(1);
    expect((await fixture.pool.query('SELECT user_id FROM juanchoice_participations WHERE campaign_id=$1', [prepared.campaign_id])).rowCount).toBe(1);

    const pastClose = new Date(now.getTime() - 60_000);
    await fixture.pool.query('UPDATE juanchoice_schedule_periods SET closes_at=$2 WHERE id=$1', [prepared.period_id, pastClose]);
    await fixture.pool.query("UPDATE juanchoice_campaigns SET closes_at=$2,status='closed' WHERE id=$1", [prepared.campaign_id, pastClose]);
    const late = await request(app).put(voteUrl).set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID()).send({ candidate_id: candidates[0].id, expected_version: 1 });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('ROUND_CLOSED');
    const adminToken = jwt.sign({ id: adminId, role: 'admin' }, env.JWT_SECRET);
    const finalizeUrl = `/api/v1/juanchoice/admin/campaigns/${prepared.campaign_id}/finalize`;
    const finalized = await request(app).post(finalizeUrl).set('Authorization', `Bearer ${adminToken}`);
    expect(finalized.status).toBe(200);
    expect(finalized.body.data.valid_ballots).toBe(1);
    const again = await request(app).post(finalizeUrl).set('Authorization', `Bearer ${adminToken}`);
    expect(again.status).toBe(200);
    expect(again.body.data.co_winner_ids).toEqual(finalized.body.data.co_winner_ids);
    expect((await fixture.pool.query('SELECT campaign_id FROM juanchoice_results WHERE campaign_id=$1', [prepared.campaign_id])).rowCount).toBe(1);

    const nextPeriod = nextMonth(period);
    const nextPreparation = new Date(monthlyWindow(nextPeriod, 'Asia/Manila').opensAt.getTime() - 3 * 86_400_000);
    expect((await reconcileMonthlySchedulesAt(nextPreparation)).prepared).toBe(1);
    const overviewFinal = await request(app).get('/api/v1/juanchoice/overview');
    expect(overviewFinal.status).toBe(200);
    expect(overviewFinal.body.data.current).toBeNull();
    expect(overviewFinal.body.data.previous.campaign_id).toBe(prepared.campaign_id);
    expect(overviewFinal.body.data.previous.valid_ballots).toBe(1);
    expect(overviewFinal.body.data.next.schedule_status).toBe('scheduled');
    expect((await fixture.pool.query('SELECT civic_xp,civic_stamps FROM progression_totals WHERE user_id=$1', [voterId])).rows[0])
      .toEqual(totals);
  }, 120_000);
});
