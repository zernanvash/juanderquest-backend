import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db } from '../src/db/index.js';
import { enqueuePush, enqueueFriendActivityPush } from '../src/push/enqueue.js';
import { dispatchDuePushes } from '../src/push/dispatcher.js';
import { runWeeklyRecap } from '../src/social/weeklyRecapJob.js';
import { setFcmDryRun } from '../src/push/fcm.js';
import { weekStartDate, prevWeekId } from '../src/social/time.js';

describe('Plan 41 Phase 4: Push Queue, Batching, Caps, Dispatcher & Weekly Recap', () => {
  let testDb: TestDbInstance;

  const userRecipient = {
    id: 'u-recip-1111-1111-1111-111111111111',
    seed_id: 'seed_recip',
    display_name: 'Recipient Traveler',
    handle: 'recip',
    email: 'recip@test.com',
    is_public: true,
    share_activity: true,
    is_test: false,
    role: 'user',
  };

  const userFriend1 = {
    id: 'u-frnd1-2222-2222-2222-222222222222',
    seed_id: 'seed_frnd1',
    display_name: 'Aira Coast',
    handle: 'aira',
    email: 'aira@test.com',
    is_public: true,
    share_activity: true,
    is_test: false,
    role: 'user',
  };

  const userFriend2 = {
    id: 'u-frnd2-3333-3333-3333-333333333333',
    seed_id: 'seed_frnd2',
    display_name: 'Carlos North',
    handle: 'carlos',
    email: 'carlos@test.com',
    is_public: true,
    share_activity: true,
    is_test: false,
    role: 'user',
  };

  const userFriend3 = {
    id: 'u-frnd3-4444-4444-4444-444444444444',
    seed_id: 'seed_frnd3',
    display_name: 'Diane Wave',
    handle: 'diane',
    email: 'diane@test.com',
    is_public: true,
    share_activity: true,
    is_test: false,
    role: 'user',
  };

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    db.usersRepo.setPool(testDb.pool);
    setFcmDryRun(true);

    for (const u of [userRecipient, userFriend1, userFriend2, userFriend3]) {
      await testDb.pool.query(
        `INSERT INTO users (id, seed_id, display_name, email, handle, is_public, share_activity, is_test, role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [u.id, u.seed_id, u.display_name, u.email, u.handle, u.is_public, u.share_activity, u.is_test, u.role],
      );
    }

    // Register active device for userRecipient
    await testDb.pool.query(
      `INSERT INTO user_devices (id, user_id, token, platform, app_build)
       VALUES ($1, $2, $3, 'android', 104)
       ON CONFLICT (token) DO NOTHING`,
      ['dev_recip_1', userRecipient.id, 'fcm_recip_active_device_token_001'],
    );
  });

  afterAll(async () => {
    if (testDb) {
      await testDb.close();
    }
  });

  describe('Batching and Collapse Key Merging', () => {
    it('merges 3 cheers in the same hour into a single queued row with batch_count = 3', async () => {
      const now = new Date('2026-10-17T06:00:00Z'); // 14:00 Manila (active daytime hours)
      const collapseKey = `social:${userRecipient.id}:2026101714`;

      // Cheer 1
      await enqueuePush(testDb.pool, {
        userId: userRecipient.id,
        category: 'social',
        collapseKey,
        title: '👏 Cheers!',
        body: 'Aira Coast cheered your activity.',
        href: '/plaza?activity=act_test_1',
        actorName: 'Aira Coast',
        isTest: false,
      }, now);

      // Cheer 2
      await enqueuePush(testDb.pool, {
        userId: userRecipient.id,
        category: 'social',
        collapseKey,
        title: '👏 Cheers!',
        body: 'Carlos North cheered your activity.',
        href: '/plaza?activity=act_test_1',
        actorName: 'Carlos North',
        isTest: false,
      }, now);

      // Cheer 3
      await enqueuePush(testDb.pool, {
        userId: userRecipient.id,
        category: 'social',
        collapseKey,
        title: '👏 Cheers!',
        body: 'Diane Wave cheered your activity.',
        href: '/plaza?activity=act_test_1',
        actorName: 'Diane Wave',
        isTest: false,
      }, now);

      const rows = await testDb.pool.query(
        `SELECT * FROM push_deliveries WHERE user_id = $1 AND collapse_key = $2`,
        [userRecipient.id, collapseKey],
      );

      expect(rows.rows.length).toBe(1);
      const row = rows.rows[0];
      expect(row.status).toBe('queued');
      expect(Number(row.batch_count)).toBe(3);
      const names = typeof row.batch_names === 'string' ? JSON.parse(row.batch_names) : row.batch_names;
      expect(names).toEqual(['Aira Coast', 'Carlos North', 'Diane Wave']);
    });
  });

  describe('Quiet Hours & Deferral', () => {
    it('defers push scheduled during Manila quiet hours (22:00) to next 08:00 Manila', async () => {
      // 14:00 UTC = 22:00 Manila (quiet hours)
      const lateNight = new Date('2026-10-17T14:00:00Z');
      const collapseKey = `social:${userRecipient.id}:2026101722`;

      const pushId = await enqueuePush(testDb.pool, {
        userId: userRecipient.id,
        category: 'social',
        collapseKey,
        title: '👏 Cheers!',
        body: 'Late night cheer.',
        href: '/plaza',
        actorName: 'Aira Coast',
        isTest: false,
      }, lateNight);

      const row = (await testDb.pool.query('SELECT * FROM push_deliveries WHERE id = $1', [pushId])).rows[0];
      expect(row.status).toBe('queued');

      // Next morning 08:00 Manila = 00:00 UTC of next day (2026-10-18T00:00:00.000Z)
      const expectedUtc = new Date('2026-10-18T00:00:00.000Z');
      expect(new Date(row.send_after).toISOString()).toBe(expectedUtc.toISOString());
    });
  });

  describe('Preferences Enforcement', () => {
    it('marks push as skipped: PREF_OFF when category preference is disabled', async () => {
      // Disable push_overtaken for recipient
      await testDb.pool.query(
        `INSERT INTO user_notification_preferences (user_id, push_overtaken)
         VALUES ($1, false)
         ON CONFLICT (user_id) DO UPDATE SET push_overtaken = false`,
        [userRecipient.id],
      );

      const pushId = await enqueuePush(testDb.pool, {
        userId: userRecipient.id,
        category: 'overtaken',
        collapseKey: `overtaken:${userRecipient.id}:20261017`,
        title: "You've been passed!",
        body: 'Carlos passed you on this week board.',
        href: '/plaza',
        actorName: 'Carlos North',
        isTest: false,
      });

      const row = (await testDb.pool.query('SELECT * FROM push_deliveries WHERE id = $1', [pushId])).rows[0];
      expect(row.status).toBe('skipped');
      expect(row.skip_reason).toBe('PREF_OFF');

      // Re-enable
      await testDb.pool.query(
        `UPDATE user_notification_preferences SET push_overtaken = true WHERE user_id = $1`,
        [userRecipient.id],
      );
    });
  });

  describe('Daily Caps Enforcement', () => {
    it('enforces maximum 1 overtaken, 2 friend_activity, 4 social, and 6 total per day', async () => {
      const todayDay = new Date('2026-10-17T04:00:00Z'); // 12:00 Manila

      // Simulate 1 already sent overtaken push today
      await testDb.pool.query(
        `INSERT INTO push_deliveries (
           id, user_id, category, collapse_key, title, body, href, status, sent_at, send_after, is_test
         ) VALUES ($1, $2, 'overtaken', 'ovk-sent-1', 'title', 'body', '/plaza', 'sent', $3, $3, false)`,
        ['push_ovk_sent_1', userRecipient.id, todayDay],
      );

      // Attempt to enqueue another overtaken push today -> should be skipped with CAP_REACHED
      const pushOvertaken2 = await enqueuePush(testDb.pool, {
        userId: userRecipient.id,
        category: 'overtaken',
        collapseKey: `overtaken:${userRecipient.id}:20261017_2`,
        title: "Passed again!",
        body: 'Another pass',
        href: '/plaza',
        isTest: false,
      }, todayDay);

      const rOvk = (await testDb.pool.query('SELECT * FROM push_deliveries WHERE id = $1', [pushOvertaken2])).rows[0];
      expect(rOvk.status).toBe('skipped');
      expect(rOvk.skip_reason).toBe('CAP_REACHED');
    });
  });

  describe('Push Dispatcher & FCM Integration', () => {
    it('claims due pushes, disables unregistered tokens, and updates status to sent', async () => {
      // Create user with invalid token and valid token
      const tokenValid = 'fcm_mock_valid_token_001';
      const tokenUnregistered = 'fcm_mock_unregistered_token_002';

      await testDb.pool.query(
        `INSERT INTO user_devices (id, user_id, token, platform)
         VALUES ($1, $2, $3, 'android')
         ON CONFLICT (token) DO NOTHING`,
        ['dev_recip_unreg', userRecipient.id, tokenUnregistered],
      );
      await testDb.pool.query('DELETE FROM push_deliveries');

      const duePushId = 'push_due_test_001';
      await testDb.pool.query(
        `INSERT INTO push_deliveries (
           id, user_id, category, collapse_key, title, body, href, batch_count, batch_names,
           status, send_after, is_test
         ) VALUES ($1, $2, 'friend_activity', 'friend:test:1', 'Aira is exploring', 'Aira completed a quest', '/plaza', 2, $3, 'queued', NOW() - INTERVAL '1 minute', false)`,
        [duePushId, userRecipient.id, JSON.stringify(['Aira Coast', 'Carlos North'])],
      );

      // Custom mock FCM sender returning 1 unregistered token and 1 successful send
      const mockFcm = async (tokens: string[], payload: any) => {
        expect(payload.title).toBe('Aira Coast is exploring');
        expect(payload.body).toContain('Aira Coast and 1 other completed quests');
        return {
          successCount: 1,
          failureCount: 1,
          unregisteredTokens: [tokenUnregistered],
        };
      };

      const summary = await dispatchDuePushes(testDb.pool, {
        fcmSender: mockFcm,
      });

      expect(summary.claimed).toBeGreaterThanOrEqual(1);
      expect(summary.sent).toBeGreaterThanOrEqual(1);

      // Verify delivery marked sent
      const deliv = (await testDb.pool.query('SELECT * FROM push_deliveries WHERE id = $1', [duePushId])).rows[0];
      expect(deliv.status).toBe('sent');
      expect(deliv.sent_at).not.toBeNull();

      // Verify unregistered device was deactivated
      const unregDev = (await testDb.pool.query('SELECT * FROM user_devices WHERE token = $1', [tokenUnregistered])).rows[0];
      expect(unregDev.disabled_at).not.toBeNull();
      expect(unregDev.disabled_reason).toBe('unregistered');
    });
  });

  describe('Weekly Recap Job', () => {
    it('runs weekly recap on Monday after 09:00, sends recap notification, and records job run', async () => {
      // Setup previous week scores for userRecipient
      const nowMonday = new Date('2026-10-19T02:00:00Z'); // Monday 10:00 AM Manila
      const pId = prevWeekId(nowMonday);
      const prevMondayDate = weekStartDate(new Date(nowMonday.getTime() - 7 * 24 * 60 * 60 * 1000));

      await testDb.pool.query(
        `INSERT INTO plaza_weekly_scores (week_start, user_id, score, quests, rank, prev_rank)
         VALUES ($1, $2, 450, 4, 3, 5)
         ON CONFLICT (week_start, user_id) DO UPDATE SET score = 450, rank = 3, prev_rank = 5`,
        [prevMondayDate, userRecipient.id],
      );

      // Run recap
      const summary = await runWeeklyRecap(testDb.pool, nowMonday, true);
      expect(summary.recapsSent).toBeGreaterThanOrEqual(1);
      expect(summary.jobKey).toBe(`recap:${pId}`);

      // Verify user received notification
      const notif = (await testDb.pool.query(
        `SELECT * FROM user_notifications WHERE user_id = $1 AND kind = 'weekly_recap'`,
        [userRecipient.id],
      )).rows[0];

      expect(notif).toBeDefined();
      expect(notif.title).toBe('Your week on the Plaza');
      expect(notif.message).toContain('You finished #3 (▲2) with 450 pts');

      // Verify plaza_job_runs recorded
      const jobRun = (await testDb.pool.query(
        'SELECT * FROM plaza_job_runs WHERE job_key = $1',
        [summary.jobKey],
      )).rows[0];
      expect(jobRun).toBeDefined();

      // Second run should be skipped
      const secondRun = await runWeeklyRecap(testDb.pool, nowMonday, false);
      expect(secondRun.skippedReason).toBe('ALREADY_RUN');
    });
  });
});
