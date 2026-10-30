import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db } from '../src/db/index.js';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  computeWeeklyScores,
  computeHomeTowns,
  rankRows,
  getBoard,
  getTownBoard,
} from '../src/social/standings.js';
import { runStandingsTick } from '../src/social/standingsJob.js';
import {
  weekStartUtc,
  nextWeekStartUtc,
  weekStartDate,
  weekId,
} from '../src/social/time.js';

describe('Plan 41 Phase 2: Standings, Towns & Weekly Job', () => {
  let testDb: TestDbInstance;

  const userAlpha = {
    id: 'u1111111-1111-1111-1111-111111111111',
    seed_id: 'seed_alpha',
    display_name: 'Alpha Explorer',
    handle: 'alpha',
    email: 'alpha@traveler.test',
    is_public: true,
    share_activity: true,
    is_test: false,
    role: 'user',
  };

  const userBeta = {
    id: 'u2222222-2222-2222-2222-222222222222',
    seed_id: 'seed_beta',
    display_name: 'Beta Wanderer',
    handle: 'beta',
    email: 'beta@traveler.test',
    is_public: true,
    share_activity: true,
    is_test: false,
    role: 'user',
  };

  const userGamma = {
    id: 'u3333333-3333-3333-3333-333333333333',
    seed_id: 'seed_gamma',
    display_name: 'Gamma Scout',
    handle: 'gamma',
    email: 'gamma@traveler.test',
    is_public: true,
    share_activity: true,
    is_test: false,
    role: 'user',
  };

  const userPrivate = {
    id: 'u4444444-4444-4444-4444-444444444444',
    seed_id: 'seed_private',
    display_name: 'Private Ghost',
    handle: 'ghost',
    email: 'ghost@traveler.test',
    is_public: false,
    share_activity: true,
    is_test: false,
    role: 'user',
  };

  const userAdmin = {
    id: 'u9999999-9999-9999-9999-999999999999',
    seed_id: 'seed_admin',
    display_name: 'Super Admin',
    handle: 'admin',
    email: 'admin@traveler.test',
    is_public: true,
    share_activity: true,
    is_test: false,
    role: 'admin',
  };

  const tokenAlpha = jwt.sign(
    { id: userAlpha.id, seed_id: userAlpha.seed_id, role: 'user' },
    env.JWT_SECRET,
  );

  const tokenBeta = jwt.sign(
    { id: userBeta.id, seed_id: userBeta.seed_id, role: 'user' },
    env.JWT_SECRET,
  );

  const fixedNow = new Date('2026-10-14T10:00:00.000Z'); // Wednesday Manila
  const ws = weekStartUtc(fixedNow);
  const we = nextWeekStartUtc(fixedNow);

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    db.usersRepo.setPool(testDb.pool);

    // Insert users
    for (const u of [userAlpha, userBeta, userGamma, userPrivate, userAdmin]) {
      await testDb.pool.query(
        `INSERT INTO users (id, seed_id, display_name, email, handle, is_public, share_activity, is_test, role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [u.id, u.seed_id, u.display_name, u.email, u.handle, u.is_public, u.share_activity, u.is_test, u.role],
      );
    }

    // Alpha follows Beta, Beta follows Alpha
    await testDb.pool.query(
      `INSERT INTO user_follows (follower_id, following_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING`,
      [userAlpha.id, userBeta.id],
    );

    // Seed quests & spots for home town computation
    // Quest 1 in Alaminos City
    await testDb.pool.query(
      `INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url, is_test)
       VALUES ($1, $2, 'Test description 1', 'cultural', $3, 16.15, 119.98, 200, 50, 'code-alaminos-1', 'https://img.test/1', false)
       ON CONFLICT (id) DO NOTHING`,
      ['q-alaminos-1', 'Alaminos Island Quest 1', 'Alaminos City'],
    );
    // Quest 2 in Alaminos City
    await testDb.pool.query(
      `INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url, is_test)
       VALUES ($1, $2, 'Test description 2', 'cultural', $3, 16.16, 119.99, 200, 50, 'code-alaminos-2', 'https://img.test/2', false)
       ON CONFLICT (id) DO NOTHING`,
      ['q-alaminos-2', 'Alaminos Island Quest 2', 'Alaminos City'],
    );
    // Quest 3 in Bolinao
    await testDb.pool.query(
      `INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url, is_test)
       VALUES ($1, $2, 'Test description 3', 'eco', $3, 16.38, 119.89, 200, 50, 'code-bolinao-1', 'https://img.test/3', false)
       ON CONFLICT (id) DO NOTHING`,
      ['q-bolinao-1', 'Bolinao Lighthouse Quest', 'Bolinao'],
    );

    // Alpha completed 2 in Alaminos (q-alaminos-1, q-alaminos-2) and 1 in Bolinao (q-bolinao-1) -> Home town Alaminos City
    await testDb.pool.query(
      `INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status, is_test)
       VALUES ('sub-a1', 'idem-a1', $1, 'q-alaminos-1', 'code-alaminos-1', 16.15, 119.98, 5, 'approved', false),
              ('sub-a2', 'idem-a2', $1, 'q-alaminos-2', 'code-alaminos-2', 16.16, 119.99, 5, 'approved', false),
              ('sub-a3', 'idem-a3', $1, 'q-bolinao-1', 'code-bolinao-1', 16.38, 119.89, 5, 'approved', false)`,
      [userAlpha.id],
    );

    // Beta completed 1 in Bolinao -> Home town Bolinao
    await testDb.pool.query(
      `INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status, is_test)
       VALUES ('sub-b1', 'idem-b1', $1, 'q-bolinao-1', 'code-bolinao-1', 16.38, 119.89, 5, 'approved', false)`,
      [userBeta.id],
    );

    // Gamma completed 1 in Alaminos -> Home town Alaminos City
    await testDb.pool.query(
      `INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status, is_test)
       VALUES ('sub-g1', 'idem-g1', $1, 'q-alaminos-1', 'code-alaminos-1', 16.15, 119.98, 5, 'approved', false)`,
      [userGamma.id],
    );
  });

  afterAll(async () => {
    await testDb.close();
    setPool(null);
    db.usersRepo.setPool(null);
  });

  describe('1. computeHomeTowns', () => {
    it('accurately resolves each explorer’s home town with ties resolved alphabetically', async () => {
      const towns = await computeHomeTowns(testDb.pool, false);
      expect(towns.get(userAlpha.id)).toBe('Alaminos City');
      expect(towns.get(userBeta.id)).toBe('Bolinao');
      expect(towns.get(userGamma.id)).toBe('Alaminos City');
    });
  });

  describe('2. computeWeeklyScores & governance_ledger credits', () => {
    beforeAll(async () => {
      // Clear ledger for test
      await testDb.pool.query('DELETE FROM governance_ledger');

      const withinWeek = new Date('2026-10-14T08:00:00.000Z');
      const outsideWeek = new Date('2026-10-01T08:00:00.000Z');

      // Alpha: two quest rewards plus a 200-point trail reward. Trail points
      // contribute to the score, but a trail is not counted as a quest.
      await testDb.pool.query(
        `INSERT INTO governance_ledger (id, transaction_group_id, type, account, amount_mjdq, reference_type, reference_id, actor_id, created_at)
         VALUES ('led-a1', 'txg-1', 'quest_reward_credit', $1, 1000000, 'submission', 'sub-a1', $1, $2),
                ('led-a2', 'txg-2', 'quest_reward_paid', $1, 500000, 'quest_funding_hold', 'hold-a2', $1, $2),
                ('led-a3', 'txg-8', 'trail_reward_credit', $1, 200000, 'trail', 'trail-standings-a', $1, $2)`,
        [userAlpha.id, withinWeek],
      );

      // Beta: 80 JDQ (800,000 mJDQ) = 80 score, 1 quest
      await testDb.pool.query(
        `INSERT INTO governance_ledger (id, transaction_group_id, type, account, amount_mjdq, reference_type, reference_id, actor_id, created_at)
         VALUES ('led-b1', 'txg-3', 'quest_reward_credit', $1, 800000, 'submission', 'sub-b1', $1, $2)`,
        [userBeta.id, withinWeek],
      );

      // Gamma: 50 JDQ (500,000 mJDQ) = 50 score, 1 quest
      await testDb.pool.query(
        `INSERT INTO governance_ledger (id, transaction_group_id, type, account, amount_mjdq, reference_type, reference_id, actor_id, created_at)
         VALUES ('led-g1', 'txg-4', 'quest_reward_credit', $1, 500000, 'submission', 'sub-g1', $1, $2)`,
        [userGamma.id, withinWeek],
      );

      // Admin user has credit: must be strictly excluded from competition
      await testDb.pool.query(
        `INSERT INTO governance_ledger (id, transaction_group_id, type, account, amount_mjdq, reference_type, reference_id, actor_id, created_at)
         VALUES ('led-adm', 'txg-5', 'quest_reward_credit', $1, 9990000, 'submission', 'sub-adm', $1, $2)`,
        [userAdmin.id, withinWeek],
      );

      // Alpha older credit outside current week: must be excluded from this week's score
      await testDb.pool.query(
        `INSERT INTO governance_ledger (id, transaction_group_id, type, account, amount_mjdq, reference_type, reference_id, actor_id, created_at)
         VALUES ('led-old', 'txg-6', 'quest_reward_credit', $1, 3000000, 'submission', 'sub-old', $1, $2)`,
        [userAlpha.id, outsideWeek],
      );
    });

    it('sums quest and trail reward credits but counts only quests in the quest tiebreaker', async () => {
      const scores = await computeWeeklyScores(testDb.pool, ws, we, false);

      const alphaScore = scores.find((s) => s.user_id === userAlpha.id);
      expect(alphaScore).toBeDefined();
      expect(alphaScore?.score).toBe(1700);
      expect(alphaScore?.quests).toBe(2);

      const betaScore = scores.find((s) => s.user_id === userBeta.id);
      expect(betaScore?.score).toBe(800);
      expect(betaScore?.quests).toBe(1);

      const gammaScore = scores.find((s) => s.user_id === userGamma.id);
      expect(gammaScore?.score).toBe(500);
      expect(gammaScore?.quests).toBe(1);

      // Admin excluded
      expect(scores.some((s) => s.user_id === userAdmin.id)).toBe(false);
    });
  });

  describe('3. rankRows competition ranking', () => {
    it('applies competition ranking (1, 2, 2, 4) with ties sharing rank', () => {
      const rows = [
        { user_id: 'u1', score: 200, quests: 3, created_at: '2026-01-01' },
        { user_id: 'u2', score: 100, quests: 2, created_at: '2026-01-02' },
        { user_id: 'u3', score: 100, quests: 2, created_at: '2026-01-03' },
        { user_id: 'u4', score: 50, quests: 1, created_at: '2026-01-04' },
      ];

      const ranked = rankRows(rows);
      expect(ranked[0].rank).toBe(1);
      expect(ranked[0].user_id).toBe('u1');

      expect(ranked[1].rank).toBe(2);
      expect(ranked[2].rank).toBe(2);

      // 4th person gets rank 4 (not 3)
      expect(ranked[3].rank).toBe(4);
      expect(ranked[3].user_id).toBe('u4');
    });
  });

  describe('4. runStandingsTick, overtakes, and weekly finalization', () => {
    it('first tick: populates weekly scores, assigns ranks, and announces top-10', async () => {
      const tick1 = await runStandingsTick(testDb.pool, fixedNow);
      expect(tick1.scoresUpdated).toBeGreaterThanOrEqual(3);
      expect(tick1.overtakesNotified).toBe(0); // first run -> no overtakes
      expect(tick1.top10Announced).toBeGreaterThanOrEqual(3);

      const { rows } = await testDb.pool.query(
        'SELECT user_id, rank, score, home_town, top10_announced FROM plaza_weekly_scores WHERE week_start = $1 ORDER BY rank ASC',
        [weekStartDate(fixedNow)],
      );

      expect(rows[0].user_id).toBe(userAlpha.id);
      expect(rows[0].rank).toBe(1);
      expect(rows[0].score).toBe(1700);
      expect(rows[0].home_town).toBe('Alaminos City');

      expect(rows[1].user_id).toBe(userBeta.id);
      expect(rows[1].rank).toBe(2);
      expect(rows[1].score).toBe(800);

      expect(rows[2].user_id).toBe(userGamma.id);
      expect(rows[2].rank).toBe(3);
      expect(rows[2].score).toBe(500);
    });

    it('second tick: detects overtakes when user Beta passes user Alpha and notifies Alpha', async () => {
      const withinWeek = new Date('2026-10-14T12:00:00.000Z');

      // Credit Beta with additional 200 JDQ (2,000,000 mJDQ) -> total 280 > Alpha (150)
      await testDb.pool.query(
        `INSERT INTO governance_ledger (id, transaction_group_id, type, account, amount_mjdq, reference_type, reference_id, actor_id, created_at)
         VALUES ('led-b2', 'txg-7', 'quest_reward_credit', $1, 2000000, 'submission', 'sub-b2', $1, $2)`,
        [userBeta.id, withinWeek],
      );

      const tick2 = await runStandingsTick(testDb.pool, fixedNow);
      expect(tick2.overtakesNotified).toBeGreaterThanOrEqual(1);

      // Verify Beta is now rank 1 and Alpha is rank 2
      const { rows } = await testDb.pool.query(
        'SELECT user_id, rank, prev_rank FROM plaza_weekly_scores WHERE week_start = $1 ORDER BY rank ASC',
        [weekStartDate(fixedNow)],
      );

      expect(rows[0].user_id).toBe(userBeta.id);
      expect(rows[0].rank).toBe(1);
      expect(rows[0].prev_rank).toBe(2);

      expect(rows[1].user_id).toBe(userAlpha.id);
      expect(rows[1].rank).toBe(2);
      expect(rows[1].prev_rank).toBe(1);

      // Check overtaken notification sent to Alpha
      const notifRes = await testDb.pool.query(
        "SELECT * FROM user_notifications WHERE user_id = $1 AND kind = 'overtaken'",
        [userAlpha.id],
      );
      expect(notifRes.rows.length).toBe(1);
      expect(notifRes.rows[0].title).toBe("You've been passed!");
      expect(notifRes.rows[0].message).toContain('Beta Wanderer');
      expect(notifRes.rows[0].message).toContain('#1 → #2');
    });

    it('weekly finalization: unlocks weekly_champion and weekly_podium at the end of the week', async () => {
      // Advance to next Monday 00:06 Manila (>= ws + 5min)
      const nextWeekTime = new Date(we.getTime() + 6 * 60 * 1000);

      const finalizeTick = await runStandingsTick(testDb.pool, nextWeekTime);
      expect(finalizeTick.weeklyFinalized).toBe(true);

      // Check achievement award for Beta (rank 1) -> weekly_champion
      const champAward = await testDb.pool.query(
        "SELECT * FROM achievement_awards WHERE user_id = $1 AND achievement_id = 'weekly_champion'",
        [userBeta.id],
      );
      expect(champAward.rows.length).toBe(1);
      expect(champAward.rows[0].season).toBe(weekId(fixedNow));

      // Check achievement award for Alpha (rank 2) -> weekly_podium
      const podiumAward = await testDb.pool.query(
        "SELECT * FROM achievement_awards WHERE user_id = $1 AND achievement_id = 'weekly_podium'",
        [userAlpha.id],
      );
      expect(podiumAward.rows.length).toBe(1);

      // Check plaza_job_runs entry
      const jobRun = await testDb.pool.query(
        'SELECT * FROM plaza_job_runs WHERE job_key = $1',
        [`finalize:${weekId(fixedNow)}`],
      );
      expect(jobRun.rows.length).toBe(1);
    });
  });

  describe('5. HTTP Endpoints', () => {
    // The handlers derive the current week from new Date(); pin only Date to the
    // seeded week so the suite does not start failing once that week has passed.
    beforeAll(() => {
      jest.useFakeTimers({
        now: fixedNow,
        doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
          'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
      });
    });
    afterAll(() => {
      jest.useRealTimers();
    });

    it('GET /api/v1/plaza/standings?board=everyone returns podium, entries, me, and rivals', async () => {
      const res = await request(app)
        .get('/api/v1/plaza/standings?board=everyone&period=weekly')
        .set('Authorization', `Bearer ${tokenBeta}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = res.body.data;
      expect(data.board).toBe('everyone');
      expect(data.period).toBe('weekly');
      expect(data.week.id).toBeTruthy();
      expect(data.podium.length).toBeGreaterThanOrEqual(1);

      // Beta is #1
      expect(data.me.rank).toBe(1);
      expect(data.me.score).toBeGreaterThan(0);
      expect(data.me.gap_to_next).toBeNull(); // Rank 1 has no gap_to_next
    });

    it('GET /api/v1/plaza/standings?board=following re-ranks subset for authenticated viewer', async () => {
      const res = await request(app)
        .get('/api/v1/plaza/standings?board=following&period=weekly')
        .set('Authorization', `Bearer ${tokenAlpha}`);

      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.board).toBe('following');

      // Alpha follows Beta: subset contains Beta (#1) and Alpha (#2)
      const userIds = data.podium.map((p: any) => p.user_id);
      expect(userIds).toContain(userBeta.id);
      expect(userIds).toContain(userAlpha.id);
      expect(userIds).not.toContain(userGamma.id);
    });

    it('GET /api/v1/plaza/standings?board=town returns rankings for viewer home town', async () => {
      const res = await request(app)
        .get('/api/v1/plaza/standings?board=town&period=weekly')
        .set('Authorization', `Bearer ${tokenAlpha}`);

      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.board).toBe('town');
      expect(data.town.name).toBe('Alaminos City');

      // Alaminos City members: Alpha and Gamma (Beta is in Bolinao)
      const userIds = data.podium.map((p: any) => p.user_id);
      expect(userIds).toContain(userAlpha.id);
      expect(userIds).not.toContain(userBeta.id);
    });

    it('GET /api/v1/plaza/towns returns town scores and top public explorer', async () => {
      const res = await request(app)
        .get('/api/v1/plaza/towns?period=weekly')
        .set('Authorization', `Bearer ${tokenAlpha}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = res.body.data;
      expect(data.towns.length).toBeGreaterThanOrEqual(2);

      const alaminos = data.towns.find((t: any) => t.town === 'Alaminos City');
      expect(alaminos).toBeDefined();
      expect(alaminos.is_my_town).toBe(true); // Alpha's town
      expect(alaminos.score_sum).toBeGreaterThan(0);
      expect(alaminos.top_explorer.display_name).toBe('Alpha Explorer');

      const bolinao = data.towns.find((t: any) => t.town === 'Bolinao');
      expect(bolinao).toBeDefined();
      expect(bolinao.is_my_town).toBe(false);
      expect(bolinao.top_explorer.display_name).toBe('Beta Wanderer');
    });
  });
});
