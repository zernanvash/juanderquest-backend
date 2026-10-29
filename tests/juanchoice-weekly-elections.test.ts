import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db as domainDb } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { createMonthlySchedule, reconcileMonthlySchedulesAt } from '../src/juanchoice/monthly-service.js';
import { castBallot, finalizeCampaign, getStandings } from '../src/juanchoice/service.js';
import { recordPromotionAssessment } from '../src/juanchoice/promotion-safety.js';
import { buildManifesto, getActiveJuanChoicePerks, invalidateActiveJuanChoicePerks, markMystery, publicManifesto,
  unlockedPerkCount } from '../src/juanchoice/perks.js';
import { isoWeekKey, localWeek, nextWeek, roundTier, weeklyRoundNumber, weeklyWindow } from '../src/juanchoice/weekly-policy.js';

const realIt = process.env.JDQ_REAL_PG_URL ? it : it.skip;
const DAY = 86_400_000;

describe('Plan 65 weekly policy and perks (pure)', () => {
  it('uses Monday-to-Monday Manila weeks with ISO week keys', () => {
    // 2026-10-28 is a Wednesday; its Manila week starts Monday 2026-10-26 00:00 PHT (Sunday 16:00 UTC).
    expect(localWeek(new Date('2026-10-28T03:00:00Z'), 'Asia/Manila')).toBe('2026-10-26');
    // Sunday 23:30 PHT still belongs to the same week; Monday 00:30 PHT starts the next.
    expect(localWeek(new Date('2026-11-01T15:30:00Z'), 'Asia/Manila')).toBe('2026-10-26');
    expect(localWeek(new Date('2026-11-01T16:30:00Z'), 'Asia/Manila')).toBe('2026-11-02');
    const window = weeklyWindow('2026-10-26', 'Asia/Manila');
    expect(window.opensAt.toISOString()).toBe('2026-10-25T16:00:00.000Z');
    expect(window.closesAt.toISOString()).toBe('2026-11-01T16:00:00.000Z');
    expect(nextWeek('2026-10-26')).toBe('2026-11-02');
    expect(isoWeekKey('2026-10-26')).toBe('2026-W44');
    expect(isoWeekKey('2026-12-28')).toBe('2026-W53');
    expect(() => weeklyWindow('2026-10-27', 'Asia/Manila')).toThrow('INVALID_WEEKLY_PERIOD');
    expect(weeklyRoundNumber('2026-11-16', '2026-10-26')).toBe(4);
  });

  it('marks every 4th round and festival weeks as special festival rounds', () => {
    expect(roundTier({ roundNumber: 3, intervalWeeks: 4, period: '2026-11-09', festivals: [] }).tier).toBe('standard');
    expect(roundTier({ roundNumber: 4, intervalWeeks: 4, period: '2026-11-16', festivals: [] })).toMatchObject({ tier: 'special_festival', festivalName: null });
    expect(roundTier({ roundNumber: 1, intervalWeeks: 4, period: '2026-10-26',
      festivals: [{ name: 'Test Festival', starts_on: '2026-10-31', ends_on: '2026-11-03', boost_multiplier: 2 }] }))
      .toMatchObject({ tier: 'special_festival', festivalName: 'Test Festival', multiplier: 2 });
  });

  it('grows manifesto slots 2 -> 4, stays deterministic and masks the mystery perk', () => {
    expect([0, 1, 2, 3, 9].map(unlockedPerkCount)).toEqual([2, 3, 4, 4, 4]);
    const input = { seed: 's', spotId: 'spot-a', spotName: 'Patar', municipality: 'Bolinao', category: 'nature_outdoors', count: 3, festival: false };
    const perks = buildManifesto(input);
    expect(perks).toHaveLength(3);
    expect(perks.filter(perk => perk.is_anchor)).toHaveLength(1);
    expect(new Set(perks.map(perk => perk.key)).size).toBe(3);
    expect(buildManifesto(input)).toEqual(perks);
    const festival = buildManifesto({ ...input, festival: true });
    expect(festival.find(perk => perk.key === perks[1].key)!.value).toBeGreaterThan(perks[1].value);
    const masked = publicManifesto(markMystery(perks));
    expect(masked.filter(perk => perk.is_mystery)).toHaveLength(1);
    expect(JSON.stringify(masked.find(perk => perk.is_mystery))).not.toContain(perks[1].key);
  });
});

describe('Plan 65 weekly elections on isolated real PostgreSQL', () => {
  let fixture: TestDbInstance;
  const original = {
    JUANCHOICE_ENABLED: env.JUANCHOICE_ENABLED, JUANCHOICE_SCHEDULER_ENABLED: env.JUANCHOICE_SCHEDULER_ENABLED,
    JUANCHOICE_WRITES_ENABLED: env.JUANCHOICE_WRITES_ENABLED, JUANCHOICE_BATCH_WRITES_ENABLED: env.JUANCHOICE_BATCH_WRITES_ENABLED,
    JUANCHOICE_BOOSTS_ENABLED: env.JUANCHOICE_BOOSTS_ENABLED, PROGRESSION_ENABLED: env.PROGRESSION_ENABLED,
  };
  const rich = `wk-rich-${randomUUID()}`;
  const second = `wk-second-${randomUUID()}`;
  const poor = `wk-poor-${randomUUID()}`;
  const admin = `wk-admin-${randomUUID()}`;
  const tokenFor = (id: string, role = 'user') => jwt.sign({ id, seed_id: id, role }, env.JWT_SECRET, { expiresIn: '1h' });
  const points = async (id: string) => Number((await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1', [id])).rows[0].demo_points);
  const civicXp = async (id: string) => Number((await fixture.pool.query('SELECT civic_xp FROM progression_totals WHERE user_id=$1', [id])).rows[0]?.civic_xp ?? 0);
  let scheduleId = '';
  let campaignId = '';
  let candidates: Array<{ id: string; spot_id: string }> = [];

  beforeAll(async () => {
    if (!process.env.JDQ_REAL_PG_URL) return;
    fixture = await createTestDb();
    setPool(fixture.pool);
    domainDb.usersRepo.setPool(fixture.pool);
    Object.assign(env, { JUANCHOICE_ENABLED: true, JUANCHOICE_SCHEDULER_ENABLED: true, JUANCHOICE_WRITES_ENABLED: true,
      JUANCHOICE_BATCH_WRITES_ENABLED: false, JUANCHOICE_BOOSTS_ENABLED: true, PROGRESSION_ENABLED: true });
    const old = new Date(Date.now() - 10 * DAY);
    await fixture.pool.query(`INSERT INTO users(id,seed_id,display_name,email,role,demo_points,created_at,is_test) VALUES
      ($1::text,$1::text,'Rich voter',$1::text||'@example.test','user',1000,$5,false),
      ($2::text,$2::text,'Second voter',$2::text||'@example.test','user',1000,$5,false),
      ($3::text,$3::text,'Poor voter',$3::text||'@example.test','user',10,$5,false),
      ($4::text,$4::text,'Admin',$4::text||'@example.test','admin',0,$5,false)`, [rich, second, poor, admin, old]);
    const towns = ['Bolinao', 'Anda', 'Sual', 'Lingayen', 'Dagupan City', 'Alaminos City', 'Bani'];
    for (let i = 0; i < towns.length; i++) {
      await fixture.pool.query(`INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,
        source_type,source_name,status,is_test) VALUES($1::text,$1::text,$2::text,'Weekly fixture','nature_outdoors','coast',$3::text,$3::text,16,120,'lgu','Fixture','published',false)`,
        [`wk-spot-${i}`, `Weekly destination ${i}`, towns[i]]);
    }
  }, 120_000);

  afterAll(async () => {
    if (!fixture) return;
    setPool(null);
    domainDb.usersRepo.setPool(null);
    Object.assign(env, original);
    invalidateActiveJuanChoicePerks();
    await fixture.close();
  });

  realIt('prepares the current week late (no empty booth) and next week, with manifestos and one mystery perk', async () => {
    const now = new Date();
    const monday = localWeek(now, 'Asia/Manila');
    const schedule = await createMonthlySchedule({ schedule_key: 'pangasinan-weekly-test', region_key: 'pangasinan', display_region: 'Pangasinan',
      timezone: 'Asia/Manila', enabled: true, effective_period: monday, preparation_lead_days: 7, minimum_candidates: 2,
      target_candidates: 4, maximum_candidates: 6, themes: [{ name: 'Weekly coast', categories: ['nature_outdoors'] }],
      policy_version: 'juanchoice-weekly-v1', is_test: false, cadence: 'weekly' });
    scheduleId = schedule.id;
    // Wednesday noon of this week, whatever today is: the current week is still open.
    const midWeek = new Date(weeklyWindow(monday, 'Asia/Manila').opensAt.getTime() + 2.5 * DAY);
    const outcome = await reconcileMonthlySchedulesAt(midWeek);
    expect(outcome.prepared).toBe(2);
    const rows = (await fixture.pool.query(`SELECT c.id,c.slug,c.round_tier,c.blind_tally_hours,c.policy_version,p.period_start
      FROM juanchoice_schedule_periods p JOIN juanchoice_campaigns c ON c.id=p.campaign_id WHERE p.schedule_id=$1 ORDER BY p.period_start`,
      [scheduleId])).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].slug).toContain(isoWeekKey(monday));
    expect(rows[0]).toMatchObject({ blind_tally_hours: 24, policy_version: 'juanchoice-weekly-v1' });
    campaignId = rows[0].id;
    candidates = (await fixture.pool.query(`SELECT id,spot_id,manifesto_perks,unlocked_perk_count FROM juanchoice_candidates
      WHERE campaign_id=$1 ORDER BY id`, [campaignId])).rows;
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    for (const c of candidates as any[]) {
      expect(c.unlocked_perk_count).toBe(2);
      expect(c.manifesto_perks).toHaveLength(2);
    }
    const mysteries = (candidates as any[]).flatMap(c => c.manifesto_perks).filter((perk: any) => perk.is_mystery);
    expect(mysteries).toHaveLength(1);
    // Rerun is idempotent.
    expect((await reconcileMonthlySchedulesAt(midWeek)).prepared).toBe(0);
    // The public standings hide the mystery perk.
    await openNow(campaignId, 3 * DAY);
    const standings = await request(app).get(`/api/v1/juanchoice/campaigns/${campaignId}/standings`);
    expect(standings.status).toBe(200);
    expect(JSON.stringify(standings.body)).toContain('??? Mystery perk');
    expect(JSON.stringify(standings.body)).not.toContain(mysteries[0].key);
  }, 60_000);

  async function openNow(id: string, closesInMs: number) {
    const now = Date.now();
    await fixture.pool.query('UPDATE juanchoice_campaigns SET opens_at=$2,closes_at=$3 WHERE id=$1',
      [id, new Date(now - 60 * 60_000), new Date(now + closesInMs)]);
  }

  realIt('free vote, quadratic boosts in points, no downgrade, free switch keeps weight, short balance fails closed', async () => {
    const [a, b] = candidates;
    const vote = (user: string, body: object) => request(app).put(`/api/v1/juanchoice/campaigns/${campaignId}/ballot`)
      .set('Authorization', `Bearer ${tokenFor(user)}`).set('Idempotency-Key', randomUUID()).send(body);
    const free = await vote(rich, { candidate_id: a.id, expected_version: 0 });
    expect(free.status).toBe(200);
    expect(free.body.data.ballot).toMatchObject({ vote_weight: 1, version: 1 });
    expect(await points(rich)).toBe(1000);
    expect(await civicXp(rich)).toBe(25);

    const toThree = await vote(rich, { candidate_id: a.id, expected_version: 1, target_weight: 3 });
    expect(toThree.status).toBe(200);
    expect(toThree.body.data.boost).toMatchObject({ points_spent: 100, civic_xp: 20 });
    expect(await points(rich)).toBe(900);
    const toFive = await vote(rich, { candidate_id: a.id, expected_version: 2, target_weight: 5 });
    expect(toFive.body.data.boost).toMatchObject({ points_spent: 525, civic_xp: 20, total_points_spent: 625 });
    expect(await points(rich)).toBe(375);
    expect(await civicXp(rich)).toBe(65);

    const down = await vote(rich, { candidate_id: a.id, expected_version: 3, target_weight: 2 });
    expect(down.status).toBe(422);
    expect(down.body.error.code).toBe('INVALID_BOOST_DOWNGRADE');

    const sw = await vote(rich, { candidate_id: b.id, expected_version: 3 });
    expect(sw.status).toBe(200);
    expect(sw.body.data.ballot).toMatchObject({ candidate_id: b.id, vote_weight: 5 });
    expect(await points(rich)).toBe(375);
    const back = await vote(rich, { candidate_id: a.id, expected_version: 4 });
    expect(back.body.data.ballot.vote_weight).toBe(5);

    const me = await request(app).get(`/api/v1/juanchoice/campaigns/${campaignId}/me`).set('Authorization', `Bearer ${tokenFor(rich)}`);
    expect(me.body.data.boost).toMatchObject({ available: true, current_weight: 5, next_weight: null });

    await vote(poor, { candidate_id: b.id, expected_version: 0 });
    const short = await vote(poor, { candidate_id: b.id, expected_version: 1, target_weight: 2 });
    expect(short.status).toBe(409);
    expect(short.body.error.code).toBe('INSUFFICIENT_POINTS');
    expect(await points(poor)).toBe(10);
    const ballot = (await fixture.pool.query('SELECT vote_weight,boost_spent_points FROM juanchoice_ballots WHERE campaign_id=$1 AND user_id=$2',
      [campaignId, poor])).rows[0];
    expect(ballot).toMatchObject({ vote_weight: 1, boost_spent_points: 0 });
    const ledger = (await fixture.pool.query(`SELECT COUNT(*)::int AS rows, SUM(amount_mjdq)::bigint AS net FROM governance_ledger
      WHERE type='juanchoice_boost_debit' AND reference_id=$1`, [campaignId])).rows[0];
    expect(Number(ledger.rows)).toBe(4);
    expect(BigInt(ledger.net)).toBe(0n);
  }, 60_000);

  realIt('concurrent boosts by one voter charge exactly once', async () => {
    const [, b] = candidates;
    await castBallot({ campaignId, userId: second, candidateId: b.id, expectedVersion: 0, idempotencyKey: randomUUID() });
    const attempts = await Promise.allSettled([1, 2].map(() => castBallot({ campaignId, userId: second, candidateId: b.id,
      expectedVersion: 1, idempotencyKey: randomUUID(), targetWeight: 2 })));
    expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((attempts.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('VERSION_CONFLICT');
    expect(await points(second)).toBe(975);
  }, 60_000);

  realIt('weighted live tally, then a hidden tally in the final 24 hours', async () => {
    const live = await getStandings(campaignId);
    const top = live.standings[0] as any;
    expect(top.votes).toBe(5);
    expect(top.voter_count).toBe(1);
    await openNow(campaignId, 2 * 60 * 60_000);
    const hidden = await request(app).get(`/api/v1/juanchoice/campaigns/${campaignId}/standings`);
    expect(hidden.body.data.campaign.tally_hidden).toBe(true);
    expect(hidden.body.data.standings.every((row: any) => row.votes === null && row.voter_count === null)).toBe(true);
    const ids = hidden.body.data.standings.map((row: any) => row.candidate_id);
    expect(ids).toEqual([...ids].sort());
  }, 60_000);

  realIt('finalizes the Champion and Minister, reveals perks, activates them, and an admin restriction suspends them', async () => {
    const closed = new Date(Date.now() - 60_000);
    await fixture.pool.query('UPDATE juanchoice_campaigns SET opens_at=$2,closes_at=$3 WHERE id=$1',
      [campaignId, new Date(closed.getTime() - 7 * DAY), closed]);
    const result = await finalizeCampaign(campaignId);
    const [a, b] = candidates;
    expect(result.co_winner_ids).toEqual([a.id]);
    expect(result.minister_candidate_id).toBe(b.id);
    expect(Number(result.total_weighted_votes)).toBe(5 + 2 + 1);
    expect(Number(result.total_boost_points)).toBe(625 + 25);
    expect(JSON.stringify(result.standings)).not.toContain('"revealed":false');
    const active = result.active_perks as any[];
    expect(active.filter(perk => perk.role === 'champion').length).toBeGreaterThanOrEqual(2);
    expect(active.filter(perk => perk.role === 'minister').length).toBeLessThanOrEqual(1);
    invalidateActiveJuanChoicePerks();
    expect((await getActiveJuanChoicePerks(fixture.pool)).length).toBe(active.length);
    const api = await request(app).get('/api/v1/juanchoice/perks/active');
    expect(api.body.data.perks.length).toBe(active.length);

    const state = (await fixture.pool.query('SELECT spot_id,consecutive_losses,last_won_at,last_minister_at FROM juanchoice_spot_election_state')).rows;
    const byId = new Map(state.map(row => [row.spot_id, row]));
    expect(byId.get(a.spot_id)).toMatchObject({ consecutive_losses: 0 });
    expect(byId.get(a.spot_id).last_won_at).not.toBeNull();
    expect(byId.get(b.spot_id).last_minister_at).not.toBeNull();
    for (const c of candidates.slice(2)) expect(byId.get(c.spot_id).consecutive_losses).toBe(1);

    await recordPromotionAssessment({ campaignId, candidateId: a.id, adminId: admin, decision: 'restricted',
      reason: 'Flooding reported by the municipal office.', validUntil: new Date(Date.now() + 7 * DAY).toISOString(), expectedRevision: 0 });
    invalidateActiveJuanChoicePerks();
    const after = await getActiveJuanChoicePerks(fixture.pool);
    expect(after.some(perk => perk.candidate_id === a.id)).toBe(false);
  }, 60_000);

  realIt('cooldowns hold out the Champion and Minister; losers return with an extra perk slot; festival weeks are special', async () => {
    const monday = localWeek(new Date(), 'Asia/Manila');
    const later = nextWeek(nextWeek(monday));
    await fixture.pool.query(`INSERT INTO juanchoice_festivals(id,name,starts_on,ends_on,boost_multiplier,is_test)
      VALUES($1,'Test Coast Festival',$2,$2,2,false)`, [randomUUID(), nextWeek(later)]);
    const outcome = await reconcileMonthlySchedulesAt(new Date(weeklyWindow(later, 'Asia/Manila').opensAt.getTime() + DAY));
    expect(outcome.prepared).toBeGreaterThanOrEqual(1);
    const round = (await fixture.pool.query(`SELECT c.id FROM juanchoice_schedule_periods p JOIN juanchoice_campaigns c ON c.id=p.campaign_id
      WHERE p.schedule_id=$1 AND p.period_start=$2`, [scheduleId, later])).rows[0];
    const roster = (await fixture.pool.query('SELECT spot_id,unlocked_perk_count,prior_loss_streak FROM juanchoice_candidates WHERE campaign_id=$1',
      [round.id])).rows;
    const [a, b] = candidates;
    expect(roster.some(row => row.spot_id === a.spot_id)).toBe(false);
    expect(roster.some(row => row.spot_id === b.spot_id)).toBe(false);
    const loser = roster.find(row => candidates.slice(2).some(c => c.spot_id === row.spot_id));
    if (loser) expect(loser).toMatchObject({ unlocked_perk_count: 3, prior_loss_streak: 1 });
    const festivalRound = (await fixture.pool.query(`SELECT c.round_tier,c.festival_name FROM juanchoice_schedule_periods p
      JOIN juanchoice_campaigns c ON c.id=p.campaign_id WHERE p.schedule_id=$1 AND p.period_start=$2`, [scheduleId, nextWeek(later)])).rows[0];
    expect(festivalRound).toMatchObject({ round_tier: 'special_festival', festival_name: 'Test Coast Festival' });
  }, 60_000);
});
