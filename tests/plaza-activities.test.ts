import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db } from '../src/db/index.js';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { recordActivity } from '../src/social/activity.js';
import { getFeed, getActivityById } from '../src/social/feed.js';

describe('Plan 41 Phase 1: Activities, Feed & Producers', () => {
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
  };

  const userNoShare = {
    id: 'u5555555-5555-5555-5555-555555555555',
    seed_id: 'seed_noshare',
    display_name: 'Silent Nomad',
    handle: 'silent',
    email: 'silent@traveler.test',
    is_public: true,
    share_activity: false,
    is_test: false,
  };

  const userTest = {
    id: 'u6666666-6666-6666-6666-666666666666',
    seed_id: 'seed_test',
    display_name: 'QA Sim Explorer',
    handle: 'qasim',
    email: 'qa@sim.test',
    role: 'qa',
    is_public: true,
    share_activity: true,
    is_test: true,
  };

  const tokenAlpha = jwt.sign(
    { id: userAlpha.id, seed_id: userAlpha.seed_id, role: 'user' },
    env.JWT_SECRET,
  );

  const tokenQA = jwt.sign(
    { id: userTest.id, seed_id: userTest.seed_id, role: 'qa' },
    env.JWT_SECRET,
  );

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    db.usersRepo.setPool(testDb.pool);

    // Insert users
    for (const u of [userAlpha, userBeta, userGamma, userPrivate, userNoShare, userTest]) {
      await testDb.pool.query(
        `INSERT INTO users (id, seed_id, display_name, email, handle, is_public, share_activity, is_test, role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [u.id, u.seed_id, u.display_name, u.email, u.handle, u.is_public, u.share_activity, u.is_test, (u as any).role || 'user'],
      );
    }

    // Alpha follows Beta
    await testDb.pool.query(
      `INSERT INTO user_follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userAlpha.id, userBeta.id],
    );
  });

  afterAll(async () => {
    await testDb.close();
    setPool(null);
    db.usersRepo.setPool(null);
  });

  describe('Activity validation & producer idempotency', () => {
    it('validates subjectHref (rejects protocol, //, or non-slash start)', async () => {
      await expect(
        recordActivity(testDb.pool, {
          eventKey: 'val-test-1',
          actorId: userAlpha.id,
          verb: 'quest_completed',
          subjectType: 'quest',
          subjectId: 'q-1',
          subjectTitle: 'Test Quest',
          subjectHref: '//double-slash',
          isTest: false,
        }),
      ).rejects.toThrow('INVALID_SUBJECT_HREF');

      await expect(
        recordActivity(testDb.pool, {
          eventKey: 'val-test-2',
          actorId: userAlpha.id,
          verb: 'quest_completed',
          subjectType: 'quest',
          subjectId: 'q-1',
          subjectTitle: 'Test Quest',
          subjectHref: 'https://example.com/quest',
          isTest: false,
        }),
      ).rejects.toThrow('INVALID_SUBJECT_HREF');
    });

    it('trims subjectTitle to 200 characters cleanly', async () => {
      const longTitle = 'A'.repeat(250);
      const id = await recordActivity(testDb.pool, {
        eventKey: 'val-test-trim',
        actorId: userAlpha.id,
        verb: 'quest_completed',
        subjectType: 'quest',
        subjectId: 'q-long',
        subjectTitle: longTitle,
        subjectHref: '/quests/long',
        isTest: false,
      });
      expect(id).toBeDefined();

      const { rows } = await testDb.pool.query('SELECT subject_title FROM social_activities WHERE id = $1', [id]);
      expect(rows[0].subject_title.length).toBe(200);
    });

    it('asserts idempotency for every producer verb (called twice -> 1 row)', async () => {
      const producers = [
        { verb: 'quest_completed', key: 'quest_completed:u1:q1', type: 'quest', id: 'q1', title: 'Hundred Islands', href: '/quests/q1', payload: { points: 50 } },
        { verb: 'town_completed', key: 'town_completed:u1:alaminos', type: 'town', id: 'alaminos', title: 'Alaminos City', href: '/map?area=alaminos', payload: { quests: 3 } },
        { verb: 'badge_earned', key: 'badge_earned:award-1', type: 'badge', id: 'first_quest', title: 'First Quest', href: '/profile?badge=first_quest', payload: { icon: '🏅' } },
        { verb: 'trail_completed', key: 'trail_completed:u1:trail-1', type: 'trail', id: 'trail-1', title: 'Coastal Trail', href: '/trail?collection=trail-1', payload: { stops: 4 } },
        { verb: 'level_up', key: 'level_up:u1:5', type: 'level', id: 'explorer-5', title: 'Level 5 · Pathfinder', href: '/profile', payload: { level: 5, title: 'Pathfinder' } },
        { verb: 'streak_milestone', key: 'streak_milestone:u1:4', type: 'streak', id: 'juanchoice-4', title: '4-Round Streak', href: '/choice', payload: { rounds: 4 } },
        { verb: 'rank_top10', key: 'rank_top10:2026-W42:u1', type: 'rank', id: '2026-W42', title: 'Top 10', href: '/plaza?period=weekly', payload: { rank: 7, week: '2026-W42' } },
        { verb: 'weekly_champion', key: 'weekly_champion:2026-W42:u1', type: 'rank', id: '2026-W42', title: 'Weekly Champion', href: '/plaza?period=weekly', payload: { place: 1, week: '2026-W42' } },
        { verb: 'spot_posted', key: 'spot_posted:spot-1', type: 'spot', id: 'spot-1', title: 'Lucap Wharf', href: '/spots/lucap-wharf', payload: {} },
        { verb: 'first_photo', key: 'first_photo:spot-1', type: 'spot', id: 'spot-1', title: 'Lucap Wharf', href: '/spots/lucap-wharf', payload: {} },
        { verb: 'juanchoice_voted', key: 'juanchoice_voted:camp-1:u1', type: 'campaign', id: 'camp-1', title: 'Best Bangus 2026', href: '/choice', payload: {} },
        { verb: 'quiz_aced', key: 'quiz_aced:quiz-1:u1', type: 'quiz', id: 'quiz-1', title: 'Pangasinan Salt History', href: '/quizzes/quiz-1', payload: { score: 5, max: 5 } },
      ];

      for (const p of producers) {
        // First execution -> inserts and returns id
        const id1 = await recordActivity(testDb.pool, {
          eventKey: p.key,
          actorId: userAlpha.id,
          verb: p.verb as any,
          subjectType: p.type,
          subjectId: p.id,
          subjectTitle: p.title,
          subjectHref: p.href,
          payload: p.payload,
          isTest: false,
        });
        expect(id1).toBeTruthy();

        // Second execution (replay) -> returns null (DO NOTHING)
        const id2 = await recordActivity(testDb.pool, {
          eventKey: p.key,
          actorId: userAlpha.id,
          verb: p.verb as any,
          subjectType: p.type,
          subjectId: p.id,
          subjectTitle: p.title,
          subjectHref: p.href,
          payload: p.payload,
          isTest: false,
        });
        expect(id2).toBeNull();

        // Database row count for this eventKey must be exactly 1
        const check = await testDb.pool.query(
          'SELECT COUNT(*)::int as count FROM social_activities WHERE event_key = $1',
          [p.key],
        );
        expect(check.rows[0].count).toBe(1);
      }
    });
  });

  describe('Feed visibility & privacy rules', () => {
    beforeAll(async () => {
      // Clear activities for deterministic feed assertions
      await testDb.pool.query('DELETE FROM social_activities');

      // Activity 1: Alpha's own activity (Alaminos City)
      await recordActivity(testDb.pool, {
        eventKey: 'feed:alpha:1',
        actorId: userAlpha.id,
        verb: 'quest_completed',
        subjectType: 'quest',
        subjectId: 'q-a1',
        subjectTitle: 'Alpha Cave Quest',
        subjectHref: '/quests/q-a1',
        municipality: 'Alaminos City',
        payload: { points: 50 },
        isTest: false,
      });

      // Activity 2: Beta's activity (followed by Alpha, Bolinao)
      await recordActivity(testDb.pool, {
        eventKey: 'feed:beta:1',
        actorId: userBeta.id,
        verb: 'trail_completed',
        subjectType: 'trail',
        subjectId: 't-b1',
        subjectTitle: 'Bolinao Coast Trail',
        subjectHref: '/trail?collection=t-b1',
        municipality: 'Bolinao',
        payload: { stops: 5 },
        isTest: false,
      });

      // Activity 3: Gamma's activity (public stranger, Lingayen)
      await recordActivity(testDb.pool, {
        eventKey: 'feed:gamma:1',
        actorId: userGamma.id,
        verb: 'spot_posted',
        subjectType: 'spot',
        subjectId: 's-g1',
        subjectTitle: 'Capitol Beach View',
        subjectHref: '/spots/capitol-beach',
        municipality: 'Lingayen',
        payload: {},
        isTest: false,
      });

      // Activity 4: Private user's activity
      await recordActivity(testDb.pool, {
        eventKey: 'feed:private:1',
        actorId: userPrivate.id,
        verb: 'quest_completed',
        subjectType: 'quest',
        subjectId: 'q-priv',
        subjectTitle: 'Private Exploration',
        subjectHref: '/quests/q-priv',
        municipality: 'Dagupan City',
        payload: { points: 50 },
        isTest: false,
      });

      // Activity 5: User with share_activity = false
      await recordActivity(testDb.pool, {
        eventKey: 'feed:noshare:1',
        actorId: userNoShare.id,
        verb: 'quest_completed',
        subjectType: 'quest',
        subjectId: 'q-noshare',
        subjectTitle: 'Silent Exploration',
        subjectHref: '/quests/q-noshare',
        municipality: 'Dagupan City',
        payload: { points: 50 },
        isTest: false,
      });

      // Activity 6: QA test user's activity
      await recordActivity(testDb.pool, {
        eventKey: 'feed:test:1',
        actorId: userTest.id,
        verb: 'quest_completed',
        subjectType: 'quest',
        subjectId: 'q-test',
        subjectTitle: 'QA Simulated Quest',
        subjectHref: '/quests/q-test',
        municipality: 'Alaminos City',
        payload: { points: 50 },
        isTest: true,
      });
    });

    it('following feed: returns only followed users and self', async () => {
      const res = await request(app)
        .get('/api/v1/plaza/feed?scope=following')
        .set('Authorization', `Bearer ${tokenAlpha}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const items = res.body.data.items;

      const actorIds = items.map((i: any) => i.actor.user_id);
      expect(actorIds).toContain(userAlpha.id);
      expect(actorIds).toContain(userBeta.id);
      expect(actorIds).not.toContain(userGamma.id);
      expect(actorIds).not.toContain(userPrivate.id);
      expect(actorIds).not.toContain(userNoShare.id);

      const alphaItem = items.find((i: any) => i.actor.user_id === userAlpha.id);
      expect(alphaItem.reason).toBe('you');
      expect(alphaItem.can_hide).toBe(true);

      const betaItem = items.find((i: any) => i.actor.user_id === userBeta.id);
      expect(betaItem.reason).toBe('following');
      expect(betaItem.actor.is_following).toBe(true);
      expect(betaItem.can_hide).toBe(false);
    });

    it('mixed feed: anonymous visitor receives all public activity with scope forced to mixed', async () => {
      const res = await request(app)
        .get('/api/v1/plaza/feed');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const items = res.body.data.items;

      const actorIds = items.map((i: any) => i.actor.user_id);
      expect(actorIds).toContain(userAlpha.id);
      expect(actorIds).toContain(userBeta.id);
      expect(actorIds).toContain(userGamma.id);
      // Private and no-share must never be in feed
      expect(actorIds).not.toContain(userPrivate.id);
      expect(actorIds).not.toContain(userNoShare.id);
      // is_test = false by default
      expect(actorIds).not.toContain(userTest.id);
    });

    it('privacy: private profiles and share_activity=false are strictly excluded', async () => {
      const res = await request(app)
        .get('/api/v1/plaza/feed?scope=mixed');

      expect(res.status).toBe(200);
      const titles = res.body.data.items.map((i: any) => i.subject.title);
      expect(titles).not.toContain('Private Exploration');
      expect(titles).not.toContain('Silent Exploration');
    });

    it('is_test isolation: test activities only return when authorized', async () => {
      // Normal call
      const normalRes = await request(app)
        .get('/api/v1/plaza/feed');
      expect(normalRes.body.data.items.some((i: any) => i.subject.title === 'QA Simulated Quest')).toBe(false);

      // With QA header and QA authenticated token
      const qaRes = await request(app)
        .get('/api/v1/plaza/feed')
        .set('Authorization', `Bearer ${tokenQA}`)
        .set('x-include-test', 'true');
      expect(qaRes.status).toBe(200);
      expect(qaRes.header['x-robots-tag']).toBe('noindex, nofollow');
      expect(qaRes.body.data.items.some((i: any) => i.subject.title === 'QA Simulated Quest')).toBe(true);
    });

    it('keyset cursor pagination: pages without duplicates or gaps', async () => {
      const page1Res = await request(app)
        .get('/api/v1/plaza/feed?limit=2');

      expect(page1Res.status).toBe(200);
      expect(page1Res.body.data.items.length).toBe(2);
      expect(page1Res.body.data.next_cursor).toBeTruthy();

      const nextCursor = page1Res.body.data.next_cursor;
      const page2Res = await request(app)
        .get(`/api/v1/plaza/feed?limit=2&cursor=${encodeURIComponent(nextCursor)}`);

      expect(page2Res.status).toBe(200);
      const page1Ids = page1Res.body.data.items.map((i: any) => i.id);
      const page2Ids = page2Res.body.data.items.map((i: any) => i.id);

      // No intersection between page 1 and page 2
      for (const id of page2Ids) {
        expect(page1Ids).not.toContain(id);
      }
    });

    it('malformed cursor returns 400 INVALID_CURSOR', async () => {
      const res = await request(app)
        .get('/api/v1/plaza/feed?cursor=not-a-valid-cursor');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_CURSOR');
    });

    it('GET /plaza/activities/:id deep link target returns valid ActivityItem or 404', async () => {
      const listRes = await request(app).get('/api/v1/plaza/feed?limit=1');
      const item = listRes.body.data.items[0];

      const detailRes = await request(app)
        .get(`/api/v1/plaza/activities/${item.id}`);

      expect(detailRes.status).toBe(200);
      expect(detailRes.body.success).toBe(true);
      expect(detailRes.body.data.id).toBe(item.id);
      expect(detailRes.body.data.verb).toBe(item.verb);
      expect(detailRes.body.data.subject.title).toBe(item.subject.title);

      const notFoundRes = await request(app)
        .get('/api/v1/plaza/activities/act_nonexistent_id');
      expect(notFoundRes.status).toBe(404);
      expect(notFoundRes.body.error.code).toBe('PLAZA_NOT_FOUND');
    });
  });
});
