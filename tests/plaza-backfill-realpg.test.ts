import { randomUUID } from 'node:crypto';
import { createTestDb } from '../src/db/testHarness.js';
import { backfillPlazaActivities } from '../scripts/backfill-plaza-activities.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
realPg('Plaza historical backfill (disposable real PostgreSQL only)', () => {
  it('is chronological, private/scope-safe, notification-free and idempotent', async () => {
    const db = await createTestDb();
    const client = await db.pool.connect();
    try {
      const suffix = randomUUID();
      const real = `backfill-real-${suffix}`;
      const privateUser = `backfill-private-${suffix}`;
      const testUser = `backfill-test-${suffix}`;
      for (const [id, isTest, share] of [[real, false, true], [privateUser, false, false], [testUser, true, true]] as const) {
        await client.query(`INSERT INTO users (id, seed_id, display_name, email, is_test, is_public, share_activity)
          VALUES ($1,$2,$3,$4,$5,TRUE,$6)`, [id, randomUUID(), id, `${id}@example.test`, isTest, share]);
      }
      const realQuest = `backfill-q-${suffix}`;
      const secondQuest = `backfill-q2-${suffix}`;
      const testQuest = `backfill-tq-${suffix}`;
      for (const [id, isTest] of [[realQuest, false], [secondQuest, false], [testQuest, true]] as const) {
        await client.query(`INSERT INTO quests
          (id,title,description,category,location_name,gps_lat,gps_lng,marker_code,marker_image_url,is_test)
          VALUES ($1,'Historical Quest','Test quest','eco','Dagupan',16.0,120.0,$2,'/marker.png',$3)`, [id, randomUUID(), isTest]);
      }
      const oldTime = '2026-01-02T03:04:05.000Z';
      const laterTime = '2026-01-03T03:04:05.000Z';
      for (const [userId, questId, isTest] of [[real, realQuest, false], [privateUser, realQuest, false], [testUser, testQuest, true]] as const) {
        const id = randomUUID();
        await client.query(`INSERT INTO submissions
          (id,idempotency_key,user_id,quest_id,scanned_marker_code,captured_lat,captured_lng,captured_accuracy,status,reviewed_at,is_test)
          VALUES ($1,$2,$3,$4,$5,16.0,120.0,5,'approved',$6,$7)`, [id, id, userId, questId, randomUUID(), oldTime, isTest]);
      }
      await client.query(`INSERT INTO quest_attempts (id, quest_id, user_id, status, completed_at)
        VALUES ($1,$2,$3,'completed',$4)`, [randomUUID(), secondQuest, real, laterTime]);
      const spotId = `backfill-spot-${suffix}`;
      await client.query(`INSERT INTO spots
        (id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,
         source_type,source_name,status,created_by,created_at)
        VALUES ($1,$2,'Community Beach','Historical post','nature','beach','Dagupan','Test address',
                16.0,120.0,'community','Community','published',$3,$4)`,
        [spotId, spotId, real, oldTime]);
      const badgeId = `backfill-badge-${suffix}`;
      const trailBadgeId = `backfill-trail-badge-${suffix}`;
      for (const id of [badgeId, trailBadgeId]) {
        await client.query(`INSERT INTO achievement_definitions
          (id,track,title,description,badge_icon) VALUES ($1,'explorer','Historical Badge','Fixture','🏅')`, [id]);
      }
      const collectionId = `backfill-collection-${suffix}`;
      await client.query(`INSERT INTO curated_collections (id,title,description,category,badge_id)
        VALUES ($1,'Heritage Trail','Fixture','heritage',$2)`, [collectionId, trailBadgeId]);
      for (const [achievementId, at] of [[badgeId, oldTime], [trailBadgeId, laterTime]]) {
        await client.query(`INSERT INTO achievement_awards (id,user_id,achievement_id,awarded_at)
          VALUES ($1,$2,$3,$4)`, [randomUUID(), real, achievementId, at]);
      }
      await client.query(`INSERT INTO progression_totals (user_id,explorer_xp) VALUES ($1,100)
        ON CONFLICT (user_id) DO UPDATE SET explorer_xp = 100`, [real]);
      await client.query(`INSERT INTO progression_events
        (id,user_id,track,delta,source_type,source_id,rule_version,earned_at)
        VALUES ($1,$2,'explorer',100,'backfill_fixture',$3,'v1',$4)`, [randomUUID(), real, spotId, laterTime]);
      const before = await client.query(`SELECT
        (SELECT count(*)::int FROM user_notifications) AS notifications,
        (SELECT count(*)::int FROM push_deliveries) AS pushes`);
      const dry = await backfillPlazaActivities(client);
      expect(dry.quest_completed.inserted).toBe(3);
      expect(dry.town_completed.inserted).toBe(1);
      expect(dry.spot_posted.inserted).toBe(1);
      expect(dry.level_up.inserted).toBe(1);
      expect(dry.badge_earned.inserted).toBe(1);
      expect(dry.trail_completed.inserted).toBe(1);
      expect((await client.query('SELECT count(*)::int AS n FROM social_activities')).rows[0].n).toBe(0);
      const first = await backfillPlazaActivities(client, true);
      expect(first.quest_completed.inserted).toBe(3);
      await client.query(`UPDATE social_activities SET hidden_at = NOW(), hidden_reason = 'owner'
        WHERE event_key = $1`, [`quest_completed:${real}:${realQuest}`]);
      const second = await backfillPlazaActivities(client, true);
      expect(second.quest_completed.inserted).toBe(0);
      expect(second.town_completed.inserted).toBe(0);
      expect((await client.query('SELECT hidden_at FROM social_activities WHERE event_key = $1',
        [`quest_completed:${real}:${realQuest}`])).rows[0].hidden_at).not.toBeNull();
      const { rows } = await client.query(`SELECT event_key, actor_id, is_test, created_at FROM social_activities
        WHERE event_key LIKE 'quest_completed:backfill-%' ORDER BY actor_id`);
      expect(rows).toHaveLength(3);
      expect(rows.find(row => row.event_key === `quest_completed:${real}:${realQuest}`)?.created_at.toISOString()).toBe(oldTime);
      expect(rows.find(row => row.event_key === `quest_completed:${real}:${secondQuest}`)?.created_at.toISOString()).toBe(laterTime);
      expect((await client.query('SELECT created_at FROM social_activities WHERE event_key = $1',
        [`town_completed:${real}:dagupan`])).rows[0].created_at.toISOString()).toBe(laterTime);
      expect((await client.query('SELECT created_at FROM social_activities WHERE event_key = $1',
        [`spot_posted:${spotId}`])).rows[0].created_at.toISOString()).toBe(oldTime);
      expect(rows.some(row => row.actor_id === privateUser)).toBe(false);
      expect(rows.find(row => row.actor_id === real)?.is_test).toBe(false);
      expect(rows.find(row => row.actor_id === testUser)?.is_test).toBe(true);
      const after = await client.query(`SELECT
        (SELECT count(*)::int FROM user_notifications) AS notifications,
        (SELECT count(*)::int FROM push_deliveries) AS pushes`);
      expect(after.rows[0]).toEqual(before.rows[0]);
    } finally {
      client.release();
      await db.close();
    }
  }, 120_000);
});
