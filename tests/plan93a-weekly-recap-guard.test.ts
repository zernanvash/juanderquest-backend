import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db } from '../src/db/index.js';
import { setFcmDryRun } from '../src/push/fcm.js';
import { weekStartDate } from '../src/social/time.js';
import { runWeeklyRecap } from '../src/social/weeklyRecapJob.js';

describe('Plan 93a: Weekly recap noise & quest-suggestion guards (real PostgreSQL)', () => {
  let testDb: TestDbInstance;

  const rankedUserId = '93a00000-0000-4000-8000-000000000001';
  const unrankedIdleId = '93a00000-0000-4000-8000-000000000002';
  const friendUserId = '93a00000-0000-4000-8000-000000000003';
  const nowMonday = new Date('2026-10-19T02:00:00Z'); // Monday 10:00 AM Manila
  const prevMondayDate = weekStartDate(new Date(nowMonday.getTime() - 7 * 24 * 60 * 60 * 1000));
  const prevWeekActivityAt = new Date('2026-10-14T06:00:00Z'); // Wednesday of previous week

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    db.usersRepo.setPool(testDb.pool);
    setFcmDryRun(true);

    for (const [id, name, handle] of [
      [rankedUserId, 'Ranked Explorer', 'ranked93a'],
      [unrankedIdleId, 'Idle Explorer', 'idle93a'],
      [friendUserId, 'Friend Explorer', 'friend93a'],
    ]) {
      await testDb.pool.query(
        `INSERT INTO users (id, seed_id, display_name, email, handle, is_public, share_activity, is_test, role)
         VALUES ($1, $1::text, $2, $3, $4, true, true, false, 'user')`,
        [id, name, `${handle}@example.test`, handle],
      );
      await testDb.pool.query(
        `INSERT INTO user_devices (id, user_id, platform, token)
         VALUES ($1, $2, 'android', $3)`,
        [`dev-${handle}`, id, `fcm_plan93a_test_token_${handle}_001`],
      );
    }

    // Seed quests: one draft, one test-only, one published live quest
    await testDb.pool.query(
      `INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, marker_code, marker_image_url, author_id, status, is_test)
       VALUES
         ('q-93a-draft', 'Explore Hwhwhwhwhwhw', 'Draft quest', 'cultural', 'Lingayen', 16.02, 120.23, 'M-93A-D', '', $1, 'draft', false),
         ('q-93a-test', 'Synthetic Test Quest', 'Test quest', 'cultural', 'Lingayen', 16.02, 120.23, 'M-93A-T', '', $1, 'published', true),
         ('q-93a-live', 'Capitol Heritage Walk', 'Published quest', 'cultural', 'Lingayen', 16.02, 120.23, 'M-93A-L', '', $1, 'published', false)`,
      [friendUserId],
    );

    // Clear any seeded social_activities so our assertions on suggestions are deterministic
    await testDb.pool.query('DELETE FROM social_activities');
    await testDb.pool.query('DELETE FROM user_notifications');

    // rankedUser follows friendUser; friendUser completed both a draft quest (twice) and a published quest (once)
    await testDb.pool.query(`INSERT INTO user_follows (follower_id, following_id) VALUES ($1, $2)`, [
      rankedUserId,
      friendUserId,
    ]);
    await testDb.pool.query(
      `INSERT INTO social_activities (id, event_key, actor_id, verb, subject_type, subject_id, subject_title, subject_href, municipality, created_at, is_test)
       VALUES
         ('act-93a-draft-1', 'ev-93a-draft-1', $1, 'quest_completed', 'quest', 'q-93a-draft', 'Explore Hwhwhwhwhwhw', '/quests/q-93a-draft', 'Lingayen', $2, false),
         ('act-93a-draft-2', 'ev-93a-draft-2', $1, 'quest_completed', 'quest', 'q-93a-draft', 'Explore Hwhwhwhwhwhw', '/quests/q-93a-draft', 'Lingayen', $2, false),
         ('act-93a-test-1',  'ev-93a-test-1',  $1, 'quest_completed', 'quest', 'q-93a-test',  'Synthetic Test Quest', '/quests/q-93a-test',  'Lingayen', $2, false),
         ('act-93a-live-1',  'ev-93a-live-1',  $1, 'quest_completed', 'quest', 'q-93a-live',  'Capitol Heritage Walk', '/quests/q-93a-live', 'Lingayen', $2, false)`,
      [friendUserId, prevWeekActivityAt],
    );

    // Only rankedUser has a weekly score; unrankedIdleId is unranked and follows nobody
    await testDb.pool.query(
      `INSERT INTO plaza_weekly_scores (week_start, user_id, score, quests, rank, prev_rank)
       VALUES ($1, $2, 300, 3, 2, 4)`,
      [prevMondayDate, rankedUserId],
    );

    await runWeeklyRecap(testDb.pool, nowMonday, true);
  }, 60000);

  afterAll(async () => {
    if (testDb) {
      await testDb.close();
    }
  });

  it('skips sending weekly_recap for an unranked user with zero friend activity', async () => {
    const res = await testDb.pool.query(
      `SELECT id FROM user_notifications WHERE user_id = $1 AND kind = 'weekly_recap'`,
      [unrankedIdleId],
    );
    expect(res.rows).toHaveLength(0);
  });

  it('sends weekly_recap to a ranked user and suggests only published non-test quests', async () => {
    const res = await testDb.pool.query(
      `SELECT title, message FROM user_notifications WHERE user_id = $1 AND kind = 'weekly_recap'`,
      [rankedUserId],
    );
    expect(res.rows).toHaveLength(1);
    const { title, message } = res.rows[0] as { title: string; message: string };
    expect(title).toBe('Your week on the Plaza');
    expect(message).toContain('You finished #2 (▲2) with 300 pts.');
    expect(message).toContain('Try Capitol Heritage Walk?');
    expect(message).not.toContain('Explore Hwhwhwhwhwhw');
    expect(message).not.toContain('Synthetic Test Quest');
  });

  it('never suggests draft/test quests in the overall fallback query when friendCount is 0', async () => {
    // Give friendUser a rank with 0 follows, and remove the live quest activity so only draft/test remain
    const soloRankedId = '93a00000-0000-4000-8000-000000000004';
    await testDb.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, handle, is_public, share_activity, is_test, role)
       VALUES ($1, $1::text, 'Solo Ranked', 'solo93a@example.test', 'solo93a', true, true, false, 'user')`,
      [soloRankedId],
    );
    await testDb.pool.query(
      `INSERT INTO user_devices (id, user_id, platform, token)
       VALUES ('dev-solo93a', $1, 'android', 'fcm_plan93a_test_token_solo93a_001')`,
      [soloRankedId],
    );
    await testDb.pool.query(
      `INSERT INTO plaza_weekly_scores (week_start, user_id, score, quests, rank, prev_rank)
       VALUES ($1, $2, 120, 1, 5, null)`,
      [prevMondayDate, soloRankedId],
    );
    await testDb.pool.query(`DELETE FROM social_activities WHERE id = 'act-93a-live-1'`);
    await testDb.pool.query('DELETE FROM plaza_job_runs');

    await runWeeklyRecap(testDb.pool, nowMonday, true);

    const res = await testDb.pool.query(
      `SELECT message FROM user_notifications WHERE user_id = $1 AND kind = 'weekly_recap'`,
      [soloRankedId],
    );
    expect(res.rows).toHaveLength(1);
    const message = (res.rows[0] as { message: string }).message;
    expect(message).not.toContain('Explore Hwhwhwhwhwhw');
    expect(message).not.toContain('Synthetic Test Quest');
  });
});
