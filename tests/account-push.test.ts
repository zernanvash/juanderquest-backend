import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db } from '../src/db/index.js';
import { enqueuePush } from '../src/push/enqueue.js';
import { insertFundingNotification } from '../src/funding/notifications.js';
import { setFcmDryRun } from '../src/push/fcm.js';

/**
 * Push for the in-app notification inbox (quest rewards, funding, sponsorships):
 * the `account` category is always on, exempt from social caps, and only
 * queued when the inbox row is actually created.
 */
describe('Account push notifications', () => {
  let testDb: TestDbInstance;
  const user = { id: 'u-acct-0000-0000-0000-000000000001', seed: 'seed_acct1' };
  const noon = new Date('2026-10-21T04:00:00Z'); // 12:00 Manila

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    db.usersRepo.setPool(testDb.pool);
    setFcmDryRun(true);
    await testDb.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, handle, is_public, share_activity, is_test, role)
       VALUES ($1, $2, 'Account Tester', 'acct@test.com', 'accttester', true, true, false, 'user')
       ON CONFLICT (id) DO NOTHING`,
      [user.id, user.seed],
    );
  });

  afterAll(async () => {
    await testDb?.close?.();
  });

  beforeEach(async () => {
    await testDb.pool.query('DELETE FROM push_deliveries WHERE user_id = $1', [user.id]);
    await testDb.pool.query('DELETE FROM user_notifications WHERE user_id = $1', [user.id]);
    await testDb.pool.query('DELETE FROM user_notification_preferences WHERE user_id = $1', [user.id]);
  });

  it('a funding/reward notification queues exactly one account push, once per event', async () => {
    const input = {
      userId: user.id,
      isTest: false,
      eventKey: 'quest-reward:q1:attempt-1',
      kind: 'quest_reward' as const,
      title: 'Quest reward received',
      message: 'You earned 50 mJDQ for Hundred Islands Eco Trek.',
      href: '/quests/q1',
    };
    await insertFundingNotification(testDb.pool as any, input);
    await insertFundingNotification(testDb.pool as any, input); // duplicate event

    const inbox = await testDb.pool.query('SELECT id FROM user_notifications WHERE user_id = $1', [user.id]);
    const pushes = await testDb.pool.query(
      'SELECT category, status, title, href, notification_id FROM push_deliveries WHERE user_id = $1',
      [user.id],
    );
    expect(inbox.rows).toHaveLength(1);
    expect(pushes.rows).toHaveLength(1);
    expect(pushes.rows[0]).toMatchObject({
      category: 'account',
      status: 'queued',
      title: 'Quest reward received',
      href: '/quests/q1',
      notification_id: inbox.rows[0].id,
    });
  });

  it('is not blocked by social preferences or the daily social cap', async () => {
    await testDb.pool.query(
      `INSERT INTO user_notification_preferences (user_id, push_overtaken, push_friend_activity, push_social, push_weekly_recap, quiet_hours)
       VALUES ($1, false, false, false, false, false)`,
      [user.id],
    );
    // Six social pushes already sent today = the shared daily cap.
    for (let i = 0; i < 6; i++) {
      await testDb.pool.query(
        `INSERT INTO push_deliveries (id, user_id, category, collapse_key, title, body, href, status, sent_at)
         VALUES ($1, $2, 'social', $3, 't', 'b', '/plaza', 'sent', $4)`,
        [`push_sent_${i}`, user.id, `c${i}`, noon],
      );
    }
    await enqueuePush(testDb.pool as any, {
      userId: user.id, category: 'account', collapseKey: 'account:sponsorship:1',
      title: 'Sponsorship approved', body: 'A merchant funded your quest.', href: '/quests/q1', isTest: false,
    }, noon);
    await enqueuePush(testDb.pool as any, {
      userId: user.id, category: 'social', collapseKey: 'social:x',
      title: 'Cheer', body: 'Someone cheered', href: '/plaza', isTest: false,
    }, noon);

    const rows = await testDb.pool.query(
      `SELECT category, status, skip_reason FROM push_deliveries
        WHERE user_id = $1 AND status <> 'sent' ORDER BY category`,
      [user.id],
    );
    expect(rows.rows).toEqual([
      { category: 'account', status: 'queued', skip_reason: null },
      { category: 'social', status: 'skipped', skip_reason: 'PREF_OFF' },
    ]);
  });

  it('still waits for 08:00 during quiet hours', async () => {
    const lateNight = new Date('2026-10-21T15:30:00Z'); // 23:30 Manila
    await enqueuePush(testDb.pool as any, {
      userId: user.id, category: 'account', collapseKey: 'account:late',
      title: 'Funding goal reached', body: 'Your quest is fully funded.', href: '/quests/q1', isTest: false,
    }, lateNight);
    const row = await testDb.pool.query(
      `SELECT send_after FROM push_deliveries WHERE user_id = $1 AND collapse_key = 'account:late'`,
      [user.id],
    );
    expect(new Date(row.rows[0].send_after).toISOString()).toBe('2026-10-22T00:00:00.000Z'); // 08:00 Manila
  });

  it('an unknown category is never sent', async () => {
    await enqueuePush(testDb.pool as any, {
      userId: user.id, category: 'mystery' as any, collapseKey: 'm',
      title: 't', body: 'b', href: '/', isTest: false,
    }, noon);
    const row = await testDb.pool.query(
      `SELECT status, skip_reason FROM push_deliveries WHERE user_id = $1 AND collapse_key = 'm'`,
      [user.id],
    );
    expect(row.rows[0]).toEqual({ status: 'skipped', skip_reason: 'PREF_OFF' });
  });
});
