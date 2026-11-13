import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { env } from '../src/config/env.js';
import { spotStore } from '../src/spots/store.js';
import { resetRateLimits } from '../src/middleware/rateLimit.js';
import { getBoard } from '../src/services/arGames.js';

// Plan 77: an AR task can be a mini-game. Start a session inside the area,
// finish it (the server checks the result is possible), then the evidence
// needs that passed session. Scores feed per-place and weekly boards.
const realPgDescribe = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPgDescribe('AR mini-game tasks (Plan 77, real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const suffix = randomUUID().slice(0, 8);
  const authorId = `arg-author-${suffix}`;
  const travelerId = `arg-traveler-${suffix}`;
  const rivalId = `arg-rival-${suffix}`;
  const spotId = `spot-arg-${suffix}`;
  const LAT = 16.3068;
  const LNG = 119.7824;
  // Inside the 80 m area but about 45 m from the centre: game players stand
  // at their own line, not at the hidden relic spot.
  const atLine = { captured_lat: LAT + 0.0004, captured_lng: LNG, captured_accuracy: 5 };
  const token = (id: string) => jwt.sign({ id, seed_id: id, role: 'user', typ: 'session' }, env.JWT_SECRET);

  async function createQuest(game: string) {
    const res = await request(app)
      .post(`/api/v1/spots/${spotId}/quests`)
      .set('Authorization', `Bearer ${token(authorId)}`)
      .send({
        title: `Laro ${game} ${randomUUID().slice(0, 4)}`,
        description: 'Win the game at the plaza to finish the task.',
        category: 'cultural',
        radius_meters: 120,
        reward_points: 75,
        step_order_mode: 'sequential',
        status: 'published',
        tasks: [
          {
            title: 'Play at the plaza',
            description: 'Win the game here.',
            required: true,
            checkpoint_type: 'ar',
            verification: { type: 'ar', fence: { lat: LAT, lng: LNG, radius_meters: 80 }, game },
          },
        ],
      });
    expect({ status: res.status, error: res.body.error }).toEqual({ status: 201, error: undefined });
    return res.body.data.id as string;
  }

  const as = (questId: string, path: string, userId = travelerId) =>
    request(app)
      .post(`/api/v1/quests/${questId}${path}`)
      .set('Authorization', `Bearer ${token(userId)}`);
  const finish = (sessionId: string, body: object, userId = travelerId) =>
    request(app)
      .post(`/api/v1/ar-games/sessions/${sessionId}/finish`)
      .set('Authorization', `Bearer ${token(userId)}`)
      .send(body);
  /** Pretend the session started `seconds` ago (the server clock decides plausibility). */
  const startedAgo = (sessionId: string, seconds: number) =>
    fixture.pool.query(`UPDATE ar_game_sessions SET started_at = now() - ($2 || ' seconds')::interval WHERE id = $1`, [
      sessionId,
      seconds,
    ]);

  // Production runs with quest funding off (quests publish at once); tests default it on.
  const fundingWasEnabled = env.QUEST_FUNDING_ENABLED;

  beforeAll(async () => {
    (env as { QUEST_FUNDING_ENABLED: boolean }).QUEST_FUNDING_ENABLED = false;
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    resetRateLimits();
    const now = new Date().toISOString();
    for (const id of [authorId, travelerId, rivalId]) {
      await fixture.pool.query(
        `INSERT INTO users (id, seed_id, display_name, email, role, demo_points, is_test, is_public, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'user', 0, false, true, $5, $5) ON CONFLICT (id) DO NOTHING`,
        [id, id, `Player ${id.slice(4, 10)}`, `${id}@example.com`, now],
      );
      if (!db.users.find((x) => x.id === id))
        db.users.push({
          id,
          seed_id: id,
          display_name: id,
          email: `${id}@example.com`,
          role: 'user',
          demo_points: 0,
          is_test: false,
          created_at: now,
          updated_at: now,
        } as any);
    }
    await fixture.pool.query(
      `INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,price_level,source_type,source_name,trust_level,status,created_by,is_test)
       VALUES ($1,$2,'Bolinao Plaza','Test destination.','nature_outdoors','beach','Bolinao','',$3,$4,1,'community','test','community','published',$5,FALSE)`,
      [spotId, spotId, LAT, LNG, authorId],
    );
    spotStore.spots.push({
      id: spotId,
      slug: spotId,
      name: 'Bolinao Plaza',
      municipality: 'Bolinao',
      description: 'Test destination.',
      category: 'nature',
      gps_lat: LAT,
      gps_lng: LNG,
      image_url: '',
      quest_id: null,
      created_by: authorId,
      is_test: false,
      created_at: now,
      updated_at: now,
    } as any);
  }, 90000);

  afterAll(async () => {
    (env as { QUEST_FUNDING_ENABLED: boolean }).QUEST_FUNDING_ENABLED = fundingWasEnabled;
    spotStore.spots = spotStore.spots.filter((s) => s.id !== spotId);
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  }, 90000);

  it('a game task needs a passed session; then the evidence is accepted away from the relic spot', async () => {
    const questId = await createQuest('pana');
    expect((await as(questId, '/attempts')).status).toBe(201);

    // Outside the area: no game.
    const far = await as(questId, '/steps/1/ar-game').send({
      captured_lat: LAT + 0.01,
      captured_lng: LNG,
      captured_accuracy: 5,
    });
    expect(far.body.error?.code).toBe('GPS_RADIUS_EXCEEDED');

    // An old app (no session, no fallback) is told to update; this comes before the relic check.
    const ch1 = await as(questId, '/steps/1/ar-challenge').send(atLine);
    const old = await as(questId, '/steps/1/evidence').send({
      challenge_token: ch1.body.data.challenge_token,
      relic_mode: 'hidden_spot',
      ...atLine,
    });
    expect(old.body.error?.code).toBe('GAME_NOT_PASSED');
    expect(old.body.error?.message).toMatch(/Update the app/);

    // A result faster than the game allows is rejected and cannot be used.
    const s1 = await as(questId, '/steps/1/ar-game').send(atLine);
    expect(s1.status).toBe(201);
    expect(s1.body.data.game).toBe('pana');
    expect(Number.isInteger(s1.body.data.seed)).toBe(true);
    const tooFast = await finish(s1.body.data.session_id, { score: 60, passed: true, stats: {} });
    expect(tooFast.body.error?.code).toBe('SCORE_REJECTED');
    const ch2 = await as(questId, '/steps/1/ar-challenge').send(atLine);
    const rejectedUse = await as(questId, '/steps/1/evidence').send({
      challenge_token: ch2.body.data.challenge_token,
      ar_game_session_id: s1.body.data.session_id,
      ...atLine,
    });
    expect(rejectedUse.body.error?.code).toBe('GAME_NOT_PASSED');

    // A lost game (score under 28) finishes but does not pass.
    const s2 = await as(questId, '/steps/1/ar-game').send(atLine);
    await startedAgo(s2.body.data.session_id, 30);
    const lost = await finish(s2.body.data.session_id, { score: 22, passed: false, stats: { arrows: 6 } });
    expect(lost.status).toBe(200);
    expect(lost.body.data.passed).toBe(false);
    // `passed` must agree with the score.
    const s3 = await as(questId, '/steps/1/ar-game').send(atLine);
    await startedAgo(s3.body.data.session_id, 30);
    expect((await finish(s3.body.data.session_id, { score: 22, passed: true, stats: {} })).body.error?.code).toBe(
      'SCORE_REJECTED',
    );

    // A win: the evidence is accepted at the player's line (no relic_mode), and records the game.
    const s4 = await as(questId, '/steps/1/ar-game').send(atLine);
    await startedAgo(s4.body.data.session_id, 40);
    const won = await finish(s4.body.data.session_id, { score: 64, passed: true, stats: { arrows: 6 } });
    expect({ status: won.status, error: won.body.error }).toEqual({ status: 200, error: undefined });
    expect(won.body.data.best).toBe(64);
    expect(won.body.data.rank_place).toBe(1);
    expect(won.body.data.rank_week).toBe(1);
    // Finishing twice is refused.
    expect((await finish(s4.body.data.session_id, { score: 64, passed: true, stats: {} })).status).toBe(409);
    const ch3 = await as(questId, '/steps/1/ar-challenge').send(atLine);
    const ok = await as(questId, '/steps/1/evidence').send({
      challenge_token: ch3.body.data.challenge_token,
      ar_game_session_id: s4.body.data.session_id,
      ...atLine,
    });
    expect({ status: ok.status, error: ok.body.error }).toEqual({ status: 200, error: undefined });
    expect(ok.body.data.step.status).toBe('verified');
    const { rows } = await fixture.pool.query(
      `SELECT e.evidence_payload FROM quest_step_evidence e JOIN quest_attempts a ON a.id = e.attempt_id
        WHERE a.quest_id = $1 AND a.user_id = $2 AND e.step_order = 1`,
      [questId, travelerId],
    );
    expect(rows[0].evidence_payload.ar_game).toMatchObject({
      session_id: s4.body.data.session_id,
      game: 'pana',
      score: 64,
    });

    // Boards: per place (all-time) and Pangasinan this week; one row per player (their best).
    const rival = await as(questId, '/attempts', rivalId);
    expect(rival.status).toBe(201);
    const r1 = await as(questId, '/steps/1/ar-game', rivalId).send(atLine);
    await startedAgo(r1.body.data.session_id, 40);
    expect(
      (await finish(r1.body.data.session_id, { score: 90, passed: true, stats: {} }, rivalId)).body.data.rank_place,
    ).toBe(1);
    const keyRes = await fixture.pool.query('SELECT DISTINCT task_key FROM ar_game_sessions WHERE quest_id = $1', [
      questId,
    ]);
    // The app finds this board from the quest page's step key: they must match.
    const pub = await request(app)
      .get(`/api/v1/quests/${questId}`)
      .set('Authorization', `Bearer ${token(travelerId)}`);
    expect(keyRes.rows).toHaveLength(1);
    expect(pub.body.data.steps[0].key).toBe(keyRes.rows[0].task_key);
    const board = await request(app)
      .get('/api/v1/ar-games/leaderboard')
      .query({ quest_id: questId, task_key: keyRes.rows[0].task_key })
      .set('Authorization', `Bearer ${token(travelerId)}`);
    expect(board.status).toBe(200);
    expect(board.body.data.entries.map((e: any) => [e.rank, e.score])).toEqual([
      [1, 90],
      [2, 64],
    ]);
    expect(board.body.data.me).toMatchObject({ rank: 2, score: 64, is_self: true });
    const week = await request(app).get('/api/v1/ar-games/leaderboard').query({ game: 'pana', scope: 'week' });
    expect(week.body.data.entries.map((e: any) => e.score)).toEqual([90, 64]);
  });

  it('the no-ARCore fallback still lets the player collect the relic', async () => {
    const questId = await createQuest('sipa');
    expect((await as(questId, '/attempts')).status).toBe(201);
    const ch = await as(questId, '/steps/1/ar-challenge').send(atLine);
    const relic = ch.body.data.relic;
    const atRelic = { captured_lat: relic.lat, captured_lng: relic.lng, captured_accuracy: 5 };
    const res = await as(questId, '/steps/1/evidence').send({
      challenge_token: ch.body.data.challenge_token,
      relic_mode: 'hidden_spot',
      fallback: 'no_arcore',
      ...atRelic,
    });
    expect({ status: res.status, error: res.body.error }).toEqual({ status: 200, error: undefined });
  });

  it('Palayok ranks the fastest break first, and last week does not count this week', async () => {
    const questId = await createQuest('pabitin_palayok');
    expect((await as(questId, '/attempts')).status).toBe(201);
    const s = await as(questId, '/steps/1/ar-game').send(atLine);
    await startedAgo(s.body.data.session_id, 20);
    // The time to break cannot be longer than the session itself.
    expect((await finish(s.body.data.session_id, { score: 25000, passed: true, stats: {} })).body.error?.code).toBe(
      'SCORE_REJECTED',
    );
    const s2 = await as(questId, '/steps/1/ar-game').send(atLine);
    await startedAgo(s2.body.data.session_id, 20);
    expect((await finish(s2.body.data.session_id, { score: 9000, passed: true, stats: {} })).status).toBe(200);
    expect((await as(questId, '/attempts', rivalId)).status).toBe(201);
    const r = await as(questId, '/steps/1/ar-game', rivalId).send(atLine);
    await startedAgo(r.body.data.session_id, 20);
    expect((await finish(r.body.data.session_id, { score: 4200, passed: true, stats: {} }, rivalId)).status).toBe(200);

    const week = await getBoard({ kind: 'week', game: 'pabitin_palayok' }, null);
    expect(week.lower_is_better).toBe(true);
    expect(week.entries.map((e) => e.score)).toEqual([4200, 9000]);
    // Moved to last Manila week, the rival's break no longer counts this week.
    await fixture.pool.query(`UPDATE ar_game_sessions SET finished_at = now() - interval '8 days' WHERE id = $1`, [
      r.body.data.session_id,
    ]);
    expect((await getBoard({ kind: 'week', game: 'pabitin_palayok' }, null)).entries.map((e) => e.score)).toEqual([
      9000,
    ]);
  });

  it('starts at most 30 games an hour per player', async () => {
    resetRateLimits();
    const questId = await createQuest('shooting_hoop');
    expect((await as(questId, '/attempts', rivalId)).status).toBe(201);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await as(questId, '/steps/1/ar-game', rivalId).send(atLine)).status;
    expect(last).toBe(429);
  });

  it('a task without a game is not a game task', async () => {
    const questId = await createQuest('collect');
    expect((await as(questId, '/attempts')).status).toBe(201);
    expect((await as(questId, '/steps/1/ar-game').send(atLine)).body.error?.code).toBe('NOT_A_GAME_TASK');
  });
});
