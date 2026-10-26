import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { cheer } from '../src/social/interactions.js';
import {
  StampsError,
  claimDaily,
  getDailyState,
  getQuestionOfTheDay,
  answerQuestionOfTheDay,
  getStampHistory,
  recordMissionEvent,
  spendStamps,
  stampAdminStats,
} from '../src/stamps/service.js';
import {
  handlePlazaCheer,
  handleQuestStepVerified,
  handleSpotInteraction,
} from '../src/stamps/hooks.js';
import { hasPerk } from '../src/perks/index.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
jest.setTimeout(180_000);

const at = (date: string, time = '12:00:00') => new Date(`${date}T${time}+08:00`);
const id = (label: string) => `${label}-${randomUUID()}`;

realPg('Plan 61 Phase 1 — passport stamps (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  let spotId: string;
  let quizId: string;
  let questionId: string;
  let correctOptionId: string;

  const createUser = async (label: string, options: { verifiedEmail?: boolean } = {}) => {
    const userId = id(label);
    await fixture.pool.query(
      `INSERT INTO users(id, seed_id, display_name, email, role, demo_points, is_test)
       VALUES($1, $2, $3, $4, 'user', 0, FALSE)`,
      [userId, `seed-${randomUUID().slice(0, 8)}`, label, `${userId}@example.test`],
    );
    if (options.verifiedEmail !== undefined) {
      await fixture.pool.query(
        `INSERT INTO account_emails(id, user_id, email, normalized_email, is_verified, is_primary)
         VALUES($1, $2, $3, $3, $4, TRUE)`,
        [id('email'), userId, `${userId}@example.test`, options.verifiedEmail],
      );
    }
    return userId;
  };

  const assignMission = async (userId: string, date: string, kind: string) => {
    const mission = await fixture.pool.query('SELECT id FROM daily_missions WHERE kind = $1', [kind]);
    const missionId = mission.rows[0].id;
    await fixture.pool.query(
      `INSERT INTO user_daily_missions(user_id, manila_date, mission_id, progress, target)
       VALUES($1, $2, $3, 0, 1) ON CONFLICT (user_id, manila_date, mission_id) DO NOTHING`,
      [userId, date, missionId],
    );
    return missionId;
  };

  const balanceOf = async (userId: string) => {
    const result = await fixture.pool.query('SELECT balance FROM stamp_balances WHERE user_id = $1', [userId]);
    return Number(result.rows[0]?.balance ?? 0);
  };

  const shieldsOf = async (userId: string) => {
    const result = await fixture.pool.query('SELECT shields_held FROM user_streaks WHERE user_id = $1', [userId]);
    return Number(result.rows[0]?.shields_held ?? 0);
  };

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    spotId = id('spot');
    await fixture.pool.query(
      `INSERT INTO spots(id, slug, name, description, category, subcategory, municipality, address,
         gps_lat, gps_lng, status, is_test, source_type, source_name, created_by)
       VALUES($1, $1::text, 'Stamps Test Destination', 'A destination used by stamp tests.', 'nature_outdoors',
         'beach', 'Bolinao', 'Patar, Bolinao', 16.3, 119.79, 'published', FALSE, 'community', 'Tests', NULL)`,
      [spotId],
    );
    quizId = id('quiz');
    questionId = id('question');
    correctOptionId = id('option-correct');
    await fixture.pool.query(
      `INSERT INTO cultural_quizzes(id, destination_id, reward_scope_id, status, current_version, is_test)
       VALUES($1, $2, $3, 'published', 1, FALSE)`,
      [quizId, spotId, randomUUID()],
    );
    const versionId = id('version');
    await fixture.pool.query(
      `INSERT INTO cultural_quiz_versions(id, quiz_id, version, title, description, language,
         radius_meters, xp_reward, time_limit_minutes, cooldown_hours, published_at)
       VALUES($1, $2, 1, 'Stamps Question Bank', 'Questions used by the QotD test.', 'en', 200, 25, 30, 24, NOW())`,
      [versionId, quizId],
    );
    await fixture.pool.query(
      `INSERT INTO cultural_quiz_questions(id, version_id, ordinal, question_text, explanation, source_url)
       VALUES($1, $2, 1, 'Which province is famous for Hundred Islands?', 'Pangasinan.', 'https://example.test')`,
      [questionId, versionId],
    );
    const options = [
      { optionId: correctOptionId, ordinal: 1, text: 'Pangasinan', correct: true },
      { optionId: id('option'), ordinal: 2, text: 'Cebu', correct: false },
      { optionId: id('option'), ordinal: 3, text: 'Davao', correct: false },
      { optionId: id('option'), ordinal: 4, text: 'Batanes', correct: false },
    ];
    for (const option of options) {
      await fixture.pool.query(
        `INSERT INTO cultural_quiz_options(id, question_id, ordinal, option_text, is_correct)
         VALUES($1, $2, $3, $4, $5)`,
        [option.optionId, questionId, option.ordinal, option.text, option.correct],
      );
    }
  });

  afterAll(async () => {
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  });

  it('keeps Manila midnight 23:59:59 and 00:00:00 on different calendar days', async () => {
    const userId = await createUser('boundary');
    const beforeMidnight = await claimDaily(fixture.pool, userId, { now: new Date('2026-10-26T15:59:59Z') });
    const afterMidnight = await claimDaily(fixture.pool, userId, { now: new Date('2026-10-26T16:00:00Z') });

    expect(beforeMidnight.date).toBe('2026-10-26');
    expect(beforeMidnight.next_reset_at).toBe('2026-10-26T16:00:00.000Z');
    expect(beforeMidnight.claim.cycle_day).toBe(1);
    expect(beforeMidnight.claim.awarded).toBe(5);
    expect(afterMidnight.date).toBe('2026-10-27');
    expect(afterMidnight.claim.cycle_day).toBe(2);
    expect(afterMidnight.claim.awarded).toBe(5);
    expect(afterMidnight.balance).toBe(10);

    const claims = await fixture.pool.query(
      'SELECT manila_date::text AS day FROM daily_claims WHERE user_id = $1 ORDER BY manila_date',
      [userId],
    );
    expect(claims.rows.map((row) => row.day)).toEqual(['2026-10-26', '2026-10-27']);
  });

  it('is idempotent for double claims, two tabs and replayed idempotency keys', async () => {
    const userId = await createUser('double');
    const now = at('2026-11-02');
    const first = await claimDaily(fixture.pool, userId, { now, idempotencyKey: 'tab-one-key' });
    const second = await claimDaily(fixture.pool, userId, { now, idempotencyKey: 'tab-one-key' });
    const third = await claimDaily(fixture.pool, userId, { now, idempotencyKey: 'tab-two-key' });

    expect(first.replayed).toBe(false);
    expect(first.claim.awarded).toBe(5);
    expect(second.replayed).toBe(true);
    expect(third.replayed).toBe(true);
    expect(second.balance).toBe(5);
    const claims = await fixture.pool.query('SELECT COUNT(*)::int AS count FROM daily_claims WHERE user_id = $1', [userId]);
    const ledger = await fixture.pool.query(
      `SELECT COUNT(*)::int AS count FROM stamp_ledger WHERE user_id = $1 AND source = 'daily_claim'`,
      [userId],
    );
    expect(claims.rows[0].count).toBe(1);
    expect(ledger.rows[0].count).toBe(1);
  });

  it('pauses the 7-day calendar on a gap instead of resetting it', async () => {
    const userId = await createUser('gap');
    await claimDaily(fixture.pool, userId, { now: at('2026-11-03') });
    const afterGap = await claimDaily(fixture.pool, userId, { now: at('2026-11-05') });

    expect(afterGap.claim.cycle_day).toBe(2);
    expect(afterGap.claim.nominal_stamps).toBe(5);
    expect(afterGap.claim.claimed_days).toBe(2);
    expect(afterGap.claim.calendar[0].claimed).toBe(true);
    expect(afterGap.claim.calendar[1].claimed).toBe(true);
    expect(afterGap.claim.calendar[2].claimed).toBe(false);
    expect(afterGap.claim.calendar[6].stamps).toBe(25);
  });

  it('consumes a shield on a missed day and never grants missed stamps', async () => {
    const userId = await createUser('shield');
    const dayOne = await claimDaily(fixture.pool, userId, { now: at('2026-11-10') });
    expect(dayOne.streak.shields_held).toBe(1);
    const dayThree = await claimDaily(fixture.pool, userId, { now: at('2026-11-12') });

    expect(dayThree.streak.shields_held).toBe(0);
    expect(dayThree.streak.current).toBe(2);
    expect(dayThree.balance).toBe(10);
    const missed = await fixture.pool.query(
      `SELECT COUNT(*)::int AS count FROM daily_claims WHERE user_id = $1 AND manila_date = '2026-11-11'`,
      [userId],
    );
    const missedLedger = await fixture.pool.query(
      `SELECT COUNT(*)::int AS count FROM stamp_ledger WHERE user_id = $1 AND manila_date = '2026-11-11'`,
      [userId],
    );
    const consumes = await fixture.pool.query(
      `SELECT COUNT(*)::int AS count FROM streak_shield_events WHERE user_id = $1 AND kind = 'consume'`,
      [userId],
    );
    expect(missed.rows[0].count).toBe(0);
    expect(missedLedger.rows[0].count).toBe(0);
    expect(consumes.rows[0].count).toBe(1);
  });

  it('progresses each mission source exactly once and awards its stamps once', async () => {
    const kinds = ['qotd', 'cheer_post', 'read_story', 'check_in', 'quest_step'];
    for (const [index, kind] of kinds.entries()) {
      const userId = await createUser(`mission-${kind}`);
      const date = `2026-11-${String(23 + index).padStart(2, '0')}`;
      const missionId = await assignMission(userId, date, kind);
      const first = await recordMissionEvent(fixture.pool, userId, kind, { now: at(date), sourceKey: `source:${kind}` });
      const second = await recordMissionEvent(fixture.pool, userId, kind, { now: at(date), sourceKey: `source:${kind}` });

      expect(first.completed).toBe(true);
      expect(second.completed).toBe(false);
      const mission = await fixture.pool.query(
        `SELECT progress, target, completed_at FROM user_daily_missions
          WHERE user_id = $1 AND manila_date = $2 AND mission_id = $3`,
        [userId, date, missionId],
      );
      expect(mission.rows[0].progress).toBe(1);
      expect(mission.rows[0].target).toBe(1);
      expect(mission.rows[0].completed_at).not.toBeNull();
      const ledger = await fixture.pool.query(
        `SELECT delta FROM stamp_ledger WHERE user_id = $1 AND source = 'mission'`,
        [userId],
      );
      expect(ledger.rows).toHaveLength(1);
      expect(Number(ledger.rows[0].delta)).toBe(kind === 'check_in' || kind === 'quest_step' ? 10 : 5);
    }
  });

  it('awards the weekly chest once when five missions are completed in a Manila week', async () => {
    const userId = await createUser('chest');
    const monday = '2026-11-16';
    const tuesday = '2026-11-17';
    const mondayKinds = ['qotd', 'cheer_post', 'read_story'];
    const tuesdayKinds = ['check_in', 'quest_step'];
    for (const kind of mondayKinds) await assignMission(userId, monday, kind);
    for (const kind of tuesdayKinds) await assignMission(userId, tuesday, kind);

    let result: Awaited<ReturnType<typeof recordMissionEvent>> | null = null;
    for (const kind of mondayKinds) {
      result = await recordMissionEvent(fixture.pool, userId, kind, { now: at(monday), sourceKey: `chest:${kind}` });
    }
    expect(result?.chest_awarded).toBe(0);
    let chestAward = 0;
    for (const kind of tuesdayKinds) {
      const next = await recordMissionEvent(fixture.pool, userId, kind, { now: at(tuesday), sourceKey: `chest:${kind}` });
      chestAward += next.chest_awarded ?? 0;
    }
    expect(chestAward).toBe(30);
    const chest = await fixture.pool.query(
      `SELECT COUNT(*)::int AS count FROM stamp_ledger WHERE user_id = $1 AND source = 'weekly_chest'`,
      [userId],
    );
    expect(chest.rows[0].count).toBe(1);
    const extra = await recordMissionEvent(fixture.pool, userId, 'qotd', { now: at(tuesday), sourceKey: 'again' });
    expect(extra.chest_awarded ?? 0).toBe(0);
    const stillOne = await fixture.pool.query(
      `SELECT COUNT(*)::int AS count FROM stamp_ledger WHERE user_id = $1 AND source = 'weekly_chest'`,
      [userId],
    );
    expect(stillOne.rows[0].count).toBe(1);
  });

  it('enforces the weekly cap across concurrent awards', async () => {
    const userId = await createUser('cap');
    const now = at('2026-12-14');
    await getDailyState(fixture.pool, userId, { now });
    const assigned = await fixture.pool.query(
      `SELECT dm.kind FROM user_daily_missions udm JOIN daily_missions dm ON dm.id = udm.mission_id
        WHERE udm.user_id = $1 AND udm.manila_date = '2026-12-14'`,
      [userId],
    );
    await fixture.pool.query(
      `UPDATE system_settings_document SET values = values || '{"stamps_weekly_cap": 10}'::jsonb WHERE id = 1`,
    );
    try {
      await Promise.all(assigned.rows.map((row, index) =>
        recordMissionEvent(fixture.pool, userId, row.kind, { now, sourceKey: `cap:${index}` })));
      const earned = await fixture.pool.query(
        `SELECT COALESCE(SUM(delta), 0)::int AS total FROM stamp_ledger
          WHERE user_id = $1 AND week_id = '2026-W51' AND delta > 0`,
        [userId],
      );
      const capped = await fixture.pool.query(
        `SELECT COUNT(*)::int AS count FROM stamp_ledger
          WHERE user_id = $1 AND week_id = '2026-W51' AND reason LIKE '%weekly_cap%'`,
        [userId],
      );
      expect(Number(earned.rows[0].total)).toBe(10);
      expect(Number(capped.rows[0].count)).toBeGreaterThanOrEqual(1);
      expect(await balanceOf(userId)).toBe(10);
    } finally {
      await fixture.pool.query(
        `UPDATE system_settings_document SET values = values - 'stamps_weekly_cap' WHERE id = 1`,
      );
    }
  });

  it('applies one cap to a daily claim and a mission award together', async () => {
    const userId = await createUser('cap-sources');
    const now = at('2026-12-21');
    const date = '2026-12-21';
    await assignMission(userId, date, 'check_in');
    await fixture.pool.query(
      `UPDATE system_settings_document SET values = values || '{"stamps_weekly_cap": 10}'::jsonb WHERE id = 1`,
    );
    try {
      const claim = await claimDaily(fixture.pool, userId, { now });
      const mission = await recordMissionEvent(fixture.pool, userId, 'check_in', { now, sourceKey: 'cap-sources' });
      expect(claim.claim.awarded).toBe(5);
      expect(mission.awarded).toBe(5);
      expect(mission.capped).toBe(true);
      const earned = await fixture.pool.query(
        'SELECT COALESCE(SUM(delta), 0)::int AS total FROM stamp_ledger WHERE user_id = $1 AND delta > 0',
        [userId],
      );
      const capped = await fixture.pool.query(
        `SELECT COUNT(*)::int AS count FROM stamp_ledger WHERE user_id = $1 AND reason LIKE '%weekly_cap%'`,
        [userId],
      );
      expect(Number(earned.rows[0].total)).toBe(10);
      expect(Number(capped.rows[0].count)).toBe(1);
      expect(await balanceOf(userId)).toBe(10);
    } finally {
      await fixture.pool.query(
        `UPDATE system_settings_document SET values = values - 'stamps_weekly_cap' WHERE id = 1`,
      );
    }
  });

  it('never lets concurrent spends drive the balance negative', async () => {
    const userId = await createUser('spend');
    await fixture.pool.query('INSERT INTO stamp_balances(user_id, balance) VALUES($1, 150)', [userId]);
    const results = await Promise.allSettled([
      spendStamps(fixture.pool, userId, 'streak_shield', 'spend-key-one'),
      spendStamps(fixture.pool, userId, 'streak_shield', 'spend-key-two'),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as StampsError).code).toBe('INSUFFICIENT_STAMPS');
    expect(await balanceOf(userId)).toBe(50);
    expect(await shieldsOf(userId)).toBe(1);
    const negative = await fixture.pool.query('SELECT COUNT(*)::int AS count FROM stamp_balances WHERE balance < 0');
    expect(negative.rows[0].count).toBe(0);
  });

  it('caps held shields and replays a spend idempotency key without double charging', async () => {
    const userId = await createUser('shields');
    await fixture.pool.query('INSERT INTO stamp_balances(user_id, balance) VALUES($1, 1000)', [userId]);
    await spendStamps(fixture.pool, userId, 'streak_shield', 'shield-key-one');
    const replay = await spendStamps(fixture.pool, userId, 'streak_shield', 'shield-key-one');
    expect(replay.replayed).toBe(true);
    expect(await balanceOf(userId)).toBe(900);
    await spendStamps(fixture.pool, userId, 'streak_shield', 'shield-key-two');
    await expect(spendStamps(fixture.pool, userId, 'streak_shield', 'shield-key-three'))
      .rejects.toMatchObject({ code: 'MAX_SHIELDS' });
    expect(await balanceOf(userId)).toBe(800);
    expect(await shieldsOf(userId)).toBe(2);
  });

  it('does not award stamps or mission progress for cheering your own Plaza post', async () => {
    const owner = await createUser('cheer-owner');
    const friend = await createUser('cheer-friend');
    const now = at('2026-11-30');
    const date = '2026-11-30';
    await assignMission(owner, date, 'cheer_post');
    await assignMission(friend, date, 'cheer_post');
    const activityId = id('activity');
    await fixture.pool.query(
      `INSERT INTO social_activities(id, event_key, actor_id, verb, subject_type, subject_id, subject_title, subject_href, is_test)
       VALUES($1, $2, $3, 'spot_posted', 'spot', $4, 'My own post', '/plaza', FALSE)`,
      [activityId, id('event'), owner, spotId],
    );

    const self = await handlePlazaCheer(fixture.pool, { viewerId: owner, activityOwnerId: owner, activityId, now });
    expect(self).toMatchObject({ completed: false, reason: 'self_content' });
    const ownMission = await fixture.pool.query(
      `SELECT udm.completed_at FROM user_daily_missions udm JOIN daily_missions dm ON dm.id = udm.mission_id
        WHERE udm.user_id = $1 AND udm.manila_date = $2 AND dm.kind = 'cheer_post'`,
      [owner, date],
    );
    expect(ownMission.rows[0].completed_at).toBeNull();
    expect(await fixture.pool.query(
      `SELECT COUNT(*)::int AS count FROM stamp_ledger WHERE user_id = $1 AND source = 'mission'`, [owner],
    )).toMatchObject({ rows: [{ count: 0 }] });

    // The real Plaza producer must enforce the same rule, not only the hook.
    const producer = await cheer(fixture.pool, owner, activityId, false);
    expect(producer.cheered).toBe(true);
    const afterProducer = await fixture.pool.query(
      `SELECT udm.completed_at FROM user_daily_missions udm JOIN daily_missions dm ON dm.id = udm.mission_id
        WHERE udm.user_id = $1 AND udm.manila_date = $2 AND dm.kind = 'cheer_post'`,
      [owner, date],
    );
    expect(afterProducer.rows[0].completed_at).toBeNull();
    expect(await balanceOf(owner)).toBe(0);

    const other = await handlePlazaCheer(fixture.pool, { viewerId: friend, activityOwnerId: owner, activityId, now });
    expect(other).toMatchObject({ completed: true });
    expect(await balanceOf(friend)).toBe(5);
  });

  it('does not award stamps or mission progress for playing a quest you authored', async () => {
    const author = await createUser('quest-author');
    const player = await createUser('quest-player');
    const date = '2026-12-01';
    const now = at(date);
    const questId = id('quest');
    await fixture.pool.query(
      `INSERT INTO quests(id, title, description, category, location_name, gps_lat, gps_lng, marker_code,
         marker_image_url, author_id, is_test)
       VALUES($1, 'Own quest', 'A quest authored by the player.', 'eco', 'Patar', 16.3, 119.79, $2, '', $3, FALSE)`,
      [questId, id('marker'), author],
    );
    await assignMission(author, date, 'quest_step');
    await assignMission(player, date, 'quest_step');

    const self = await handleQuestStepVerified(fixture.pool, {
      userId: author, questId, evidenceId: id('evidence'), now,
    });
    expect(self).toMatchObject({ completed: false, reason: 'self_content' });
    expect(await balanceOf(author)).toBe(0);

    const valid = await handleQuestStepVerified(fixture.pool, {
      userId: player, questId, evidenceId: id('evidence'), now,
    });
    expect(valid).toMatchObject({ completed: true });
    expect(await balanceOf(player)).toBe(10);
  });

  it('does not award stamps or mission progress for reading or checking in at a destination you created', async () => {
    const creator = await createUser('spot-creator');
    const visitor = await createUser('spot-visitor');
    const date = '2026-12-02';
    const now = at(date);
    const ownSpotId = id('own-spot');
    await fixture.pool.query(
      `INSERT INTO spots(id, slug, name, description, category, subcategory, municipality, address,
         gps_lat, gps_lng, status, is_test, source_type, source_name, created_by)
       VALUES($1, $1::text, 'Creator destination', 'Created by the traveler under test.', 'nature_outdoors',
         'beach', 'Bolinao', 'Patar, Bolinao', 16.31, 119.8, 'published', FALSE, 'community', 'Tests', $2)`,
      [ownSpotId, creator],
    );
    await assignMission(creator, date, 'check_in');
    await assignMission(creator, date, 'read_story');
    await assignMission(visitor, date, 'check_in');
    await assignMission(visitor, date, 'read_story');

    const ownVisit = await handleSpotInteraction(fixture.pool, { userId: creator, spotId: ownSpotId, type: 'visit', now });
    const ownRead = await handleSpotInteraction(fixture.pool, { userId: creator, spotId: ownSpotId, type: 'view', now });
    expect(ownVisit).toMatchObject({ completed: false, reason: 'self_content' });
    expect(ownRead).toMatchObject({ completed: false, reason: 'self_content' });
    expect(await balanceOf(creator)).toBe(0);

    const visit = await handleSpotInteraction(fixture.pool, { userId: visitor, spotId: ownSpotId, type: 'visit', now });
    const read = await handleSpotInteraction(fixture.pool, { userId: visitor, spotId: ownSpotId, type: 'view', now });
    expect(visit).toMatchObject({ completed: true });
    expect(read).toMatchObject({ completed: true });
    expect(await balanceOf(visitor)).toBe(15);
  });

  it('grades QotD server-side, allows one answer per day and never leaks correctness before answering', async () => {
    const userId = await createUser('qotd');
    const other = await createUser('qotd-other');
    const now = at('2026-12-07');
    const before = await getQuestionOfTheDay(fixture.pool, userId, { now });
    expect(before.question?.options).toHaveLength(4);
    // The QotD must come from the curated pool, never from rewarded quiz content.
    expect(before.question!.id).not.toBe(questionId);
    const poolQuestion = await fixture.pool.query('SELECT 1 FROM qotd_questions WHERE id = $1', [before.question!.id]);
    expect(poolQuestion.rowCount).toBe(1);
    for (const option of before.question!.options) {
      expect(option).not.toHaveProperty('is_correct');
      expect(option).not.toHaveProperty('correct');
    }
    expect(before.question).not.toHaveProperty('explanation');
    expect(before.answered).toBe(false);
    expect(before.answer).toBeNull();

    const correct = await fixture.pool.query(
      `SELECT o.id, q.explanation FROM qotd_options o
         JOIN qotd_questions q ON q.id = o.question_id
        WHERE o.question_id = $1 AND o.is_correct = TRUE`,
      [before.question!.id],
    );
    const correctPoolOptionId = correct.rows[0].id;
    const answer = await answerQuestionOfTheDay(fixture.pool, userId, correctPoolOptionId, { now });
    expect(answer.correct).toBe(true);
    expect(answer.correct_option_id).toBe(correctPoolOptionId);
    expect(answer.explanation).toBe(correct.rows[0].explanation);
    const revealed = await fixture.pool.query('SELECT 1 FROM qotd_options WHERE id = $1 AND question_id = $2', [answer.correct_option_id, before.question!.id]);
    expect(revealed.rowCount).toBe(1);
    await expect(answerQuestionOfTheDay(fixture.pool, userId, correctPoolOptionId, { now }))
      .rejects.toMatchObject({ code: 'ALREADY_ANSWERED' });
    const answered = await getQuestionOfTheDay(fixture.pool, userId, { now });
    expect(answered.answered).toBe(true);
    expect(answered.answer?.correct).toBe(true);
    const rows = await fixture.pool.query('SELECT COUNT(*)::int AS count FROM qotd_answers WHERE user_id = $1', [userId]);
    expect(rows.rows[0].count).toBe(1);

    const wrongOption = await fixture.pool.query(
      'SELECT id FROM qotd_options WHERE question_id = $1 AND is_correct = FALSE ORDER BY ordinal LIMIT 1',
      [before.question!.id],
    );
    const otherAnswer = await answerQuestionOfTheDay(fixture.pool, other, wrongOption.rows[0].id, { now });
    expect(otherAnswer.correct).toBe(false);
  });

  it('never writes stamps to governance_ledger or points_accounts', async () => {
    const userId = await createUser('isolation');
    const governanceBefore = await fixture.pool.query('SELECT COUNT(*)::int AS count FROM governance_ledger');
    const accountsBefore = await fixture.pool.query('SELECT COUNT(*)::int AS count FROM points_accounts');
    await claimDaily(fixture.pool, userId, { now: at('2026-12-08') });
    await assignMission(userId, '2026-12-08', 'qotd');
    await recordMissionEvent(fixture.pool, userId, 'qotd', { now: at('2026-12-08'), sourceKey: 'isolation' });
    const governance = await fixture.pool.query('SELECT COUNT(*)::int AS count FROM governance_ledger WHERE actor_id = $1', [userId]);
    const governanceAfter = await fixture.pool.query('SELECT COUNT(*)::int AS count FROM governance_ledger');
    const accountsAfter = await fixture.pool.query('SELECT COUNT(*)::int AS count FROM points_accounts');
    expect(governance.rows[0].count).toBe(0);
    expect(governanceAfter.rows[0].count).toBe(governanceBefore.rows[0].count);
    expect(accountsAfter.rows[0].count).toBe(accountsBefore.rows[0].count);
  });

  it('drops JuanChoice vote stamps entirely', async () => {
    const missions = await fixture.pool.query(`SELECT COUNT(*)::int AS count FROM daily_missions WHERE kind LIKE '%juanchoice%'`);
    expect(missions.rows[0].count).toBe(0);
    const userId = await createUser('vote');
    const result = await recordMissionEvent(fixture.pool, userId, 'juanchoice_vote', {
      now: at('2026-12-09'), sourceKey: 'vote',
    });
    expect(result.completed).toBe(false);
    expect(await balanceOf(userId)).toBe(0);
  });

  it('keeps hasPerk false for every traveler in Phase 1', async () => {
    expect(await hasPerk('any-user', 'vip_weekly_shield')).toBe(false);
    expect(await hasPerk('any-user', 'vip_shop_discount')).toBe(false);
    expect(await hasPerk('any-user', 'some_future_key')).toBe(false);
  });

  it('blocks unverified email accounts from claiming and from the monthly shield', async () => {
    const userId = await createUser('unverified', { verifiedEmail: false });
    await expect(claimDaily(fixture.pool, userId, { now: at('2026-12-10') }))
      .rejects.toMatchObject({ code: 'ACCOUNT_NOT_VERIFIED' });
    const daily = await getDailyState(fixture.pool, userId, { now: at('2026-12-10') });
    expect(daily.streak.shields_held).toBe(0);
    const events = await fixture.pool.query(
      'SELECT COUNT(*)::int AS count FROM streak_shield_events WHERE user_id = $1',
      [userId],
    );
    expect(events.rows[0].count).toBe(0);
  });

  it('serves platform-admin mission, reward table, QotD schedule and stats endpoints', async () => {
    const adminId = await createUser('stamp-admin');
    await fixture.pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [adminId]);
    const token = jwt.sign({ id: adminId, seed_id: adminId, role: 'admin' }, env.JWT_SECRET);
    const auth = { Authorization: `Bearer ${token}` };

    const mission = await request(app).post('/api/v1/admin/stamps/missions').set(auth).send({
      id: 'mission-admin-test', kind: 'admin_test_mission', title: 'Admin test mission', stamps: 7, on_site: false,
    });
    expect(mission.status).toBe(201);
    expect(mission.body.data).toMatchObject({ id: 'mission-admin-test', kind: 'admin_test_mission', active: true });
    const list = await request(app).get('/api/v1/admin/stamps/missions').set(auth);
    expect(list.body.data.some((item: { id: string }) => item.id === 'mission-admin-test')).toBe(true);
    const patched = await request(app).patch('/api/v1/admin/stamps/missions/mission-admin-test').set(auth).send({ active: false });
    expect(patched.status).toBe(200);

    const settings = await request(app).get('/api/v1/admin/settings').set(auth);
    expect(settings.status).toBe(200);
    expect(settings.body.data.values.stamps_weekly_cap).toBe(250);
    const update = await request(app).put('/api/v1/admin/settings').set(auth).send({
      expected_revision: settings.body.data.revision,
      changes: { stamps_weekly_cap: 240 },
      reason: 'stamps test',
    });
    expect(update.status).toBe(200);
    expect(update.body.data.values.stamps_weekly_cap).toBe(240);
    const restore = await request(app).put('/api/v1/admin/settings').set(auth).send({
      expected_revision: update.body.data.revision,
      changes: { stamps_weekly_cap: 250 },
      reason: 'stamps test restore',
    });
    expect(restore.status).toBe(200);

    const createdQotd = await request(app).post('/api/v1/admin/stamps/qotd/questions').set(auth).send({
      question_text: 'Which Pangasinan festival celebrates the bangus harvest?',
      explanation: 'The Dagupan Bangus Festival celebrates the city’s milkfish industry.',
      options: [
        { option_text: 'Bangus Festival', is_correct: true },
        { option_text: 'Panagbenga Festival', is_correct: false },
        { option_text: 'Pahiyas Festival', is_correct: false },
        { option_text: 'Sinulog Festival', is_correct: false },
      ],
    });
    expect(createdQotd.status).toBe(201);
    expect(createdQotd.body.data.options).toHaveLength(4);
    expect(createdQotd.body.data.options.filter((option: { is_correct: boolean }) => option.is_correct)).toHaveLength(1);
    const createdId = createdQotd.body.data.id;
    const poolList = await request(app).get('/api/v1/admin/stamps/qotd/questions').set(auth);
    expect(poolList.status).toBe(200);
    expect(poolList.body.data.some((item: { id: string }) => item.id === createdId)).toBe(true);
    const deactivate = await request(app).patch(`/api/v1/admin/stamps/qotd/questions/${createdId}`)
      .set(auth).send({ active: false });
    expect(deactivate.status).toBe(200);
    expect(deactivate.body.data.active).toBe(false);

    const future = '2026-12-22';
    const schedule = await request(app).put('/api/v1/admin/stamps/qotd').set(auth).send({
      manila_date: future, question_id: 'qotd-seed-capital',
    });
    expect(schedule.status).toBe(200);
    const scheduled = await getQuestionOfTheDay(fixture.pool, null, { now: at(future) });
    expect(scheduled.question?.id).toBe('qotd-seed-capital');

    const stats = await request(app).get('/api/v1/admin/stamps/stats').set(auth);
    expect(stats.status).toBe(200);
    expect(stats.body.data).toEqual(expect.objectContaining({
      claims_today: expect.any(Number),
      missions_completed_today: expect.any(Number),
      weekly_cap_hits: expect.any(Number),
      travelers_today: expect.any(Number),
    }));

    await fixture.pool.query("DELETE FROM daily_missions WHERE id = 'mission-admin-test'");
    await fixture.pool.query("DELETE FROM qotd_questions WHERE id = $1", [createdId]);
    await fixture.pool.query("DELETE FROM question_of_the_day WHERE manila_date = '2026-12-22'");
  });

  it('keeps test-account stamps out of admin stats', async () => {
    const now = at('2026-12-23');
    const date = '2026-12-23';
    const testUser = await createUser('test-stamps');
    await fixture.pool.query('UPDATE users SET is_test = TRUE WHERE id = $1', [testUser]);
    const before = await stampAdminStats(fixture.pool, { now });
    const claim = await claimDaily(fixture.pool, testUser, { now });
    expect(claim.claim.awarded).toBe(5);
    await assignMission(testUser, date, 'qotd');
    const mission = await recordMissionEvent(fixture.pool, testUser, 'qotd', { now, sourceKey: 'test-account' });
    expect(mission.awarded).toBe(5);
    const ledger = await fixture.pool.query('SELECT is_test FROM stamp_ledger WHERE user_id = $1', [testUser]);
    expect(ledger.rows.length).toBeGreaterThanOrEqual(2);
    expect(ledger.rows.every((row: { is_test: boolean }) => row.is_test === true)).toBe(true);
    const after = await stampAdminStats(fixture.pool, { now });
    expect(after.claims_today).toBe(before.claims_today);
    expect(after.missions_completed_today).toBe(before.missions_completed_today);
    expect(after.travelers_today).toBe(before.travelers_today);
    expect(after.weekly_cap_hits).toBe(before.weekly_cap_hits);
    expect(after.outstanding_balance).toBe(before.outstanding_balance);
  });

  it('serves the HTTP contract for daily, history, spend and QotD routes', async () => {
    const userId = await createUser('http');
    const token = jwt.sign({ id: userId, seed_id: userId, role: 'user' }, env.JWT_SECRET);
    const auth = { Authorization: `Bearer ${token}` };

    const claim = await request(app).post('/api/v1/me/daily/claim')
      .set(auth).set('Idempotency-Key', 'http-claim-key').send({});
    expect(claim.status).toBe(200);
    expect(claim.body.data.claim.awarded).toBe(5);
    const replay = await request(app).post('/api/v1/me/daily/claim')
      .set(auth).set('Idempotency-Key', 'http-claim-key').send({});
    expect(replay.status).toBe(200);
    expect(replay.body.data.replayed).toBe(true);

    const daily = await request(app).get('/api/v1/me/daily').set(auth);
    expect(daily.status).toBe(200);
    expect(daily.body.data.missions).toHaveLength(3);
    expect(daily.body.data.claim.claimed_today).toBe(true);

    const history = await request(app).get('/api/v1/me/stamps?limit=5').set(auth);
    expect(history.status).toBe(200);
    expect(history.body.data.items.length).toBeGreaterThanOrEqual(1);

    const qotd = await request(app).get('/api/v1/qotd').set(auth);
    expect(qotd.status).toBe(200);
    expect(qotd.body.data.question.options).toHaveLength(4);
    expect(JSON.stringify(qotd.body.data.question)).not.toContain('is_correct');
    const correct = await fixture.pool.query(
      'SELECT id FROM qotd_options WHERE question_id = $1 AND is_correct = TRUE',
      [qotd.body.data.question.id],
    );
    const answered = await request(app).post('/api/v1/qotd/answer')
      .set(auth).send({ option_id: correct.rows[0].id });
    expect(answered.status).toBe(201);
    expect(answered.body.data.correct).toBe(true);

    await fixture.pool.query('UPDATE stamp_balances SET balance = 200 WHERE user_id = $1', [userId]);
    const spend = await request(app).post('/api/v1/me/stamps/spend')
      .set(auth).set('Idempotency-Key', 'http-spend-key').send({ item: 'streak_shield' });
    expect(spend.status).toBe(201);
    expect(spend.body.data.balance).toBe(100);
    expect(spend.body.data.shields_held).toBeGreaterThanOrEqual(1);
  });
});
