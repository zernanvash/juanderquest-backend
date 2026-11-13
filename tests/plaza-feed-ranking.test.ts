import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { recordActivity } from '../src/social/activity.js';
import { clearPlazaFeedCache } from '../src/social/feed.js';
import { setHomeTown } from '../src/social/homeTown.js';
import { weekStartDate } from '../src/social/time.js';

describe('Plan 80: PlazaRanker v2 Feed Ranking, Home Town Scope & Author Diversity', () => {
  let testDb: TestDbInstance;

  const userViewer = {
    id: 'u8011111-1111-4111-8111-111111111111',
    seed_id: 'seed_plaza_viewer',
    display_name: 'Viewer Explorer',
    handle: 'viewer_exp',
    email: 'viewer@plaza.test',
    home_municipality: 'Dagupan City' as string | null,
    is_public: true,
    share_activity: true,
    is_test: false,
    role: 'user',
  };

  const userFriend = {
    id: 'u8022222-2222-4222-8222-222222222222',
    seed_id: 'seed_plaza_friend',
    display_name: 'Friend Scout',
    handle: 'friend_scout',
    email: 'friend@plaza.test',
    home_municipality: 'Bolinao',
    is_public: true,
    share_activity: true,
    is_test: false,
    role: 'user',
  };

  const userSpammer = {
    id: 'u8033333-3333-4333-8333-333333333333',
    seed_id: 'seed_plaza_spammer',
    display_name: 'Burst Poster',
    handle: 'burst_poster',
    email: 'burst@plaza.test',
    home_municipality: 'Alaminos City',
    is_public: true,
    share_activity: true,
    is_test: false,
    role: 'user',
  };

  const userTownie = {
    id: 'u8044444-4444-4444-8444-444444444444',
    seed_id: 'seed_plaza_townie',
    display_name: 'Dagupan Neighbor',
    handle: 'dagupan_neighbor',
    email: 'neighbor@plaza.test',
    home_municipality: 'Dagupan City',
    is_public: true,
    share_activity: true,
    is_test: false,
    role: 'user',
  };

  const userNoHome = {
    id: 'u8055555-5555-4555-8555-555555555555',
    seed_id: 'seed_plaza_nohome',
    display_name: 'Visiting Traveler',
    handle: 'visiting_traveler',
    email: 'visiting@plaza.test',
    home_municipality: null,
    is_public: true,
    share_activity: true,
    is_test: false,
    role: 'user',
  };

  const userRival6 = {
    id: 'u8066666-6666-4666-8666-666666666666',
    seed_id: 'seed_plaza_rival6',
    display_name: 'Rival Six',
    handle: 'rival_six',
    email: 'rival6@plaza.test',
    home_municipality: 'Alaminos City',
    is_public: true,
    share_activity: true,
    is_test: false,
    role: 'user',
  };

  const userActor10 = {
    id: 'u8077777-7777-4777-8777-777777777777',
    seed_id: 'seed_plaza_actor10',
    display_name: 'Actor Ten',
    handle: 'actor_ten',
    email: 'actor10@plaza.test',
    home_municipality: 'Alaminos City',
    is_public: true,
    share_activity: true,
    is_test: false,
    role: 'user',
  };

  const tokenViewer = jwt.sign(
    { id: userViewer.id, seed_id: userViewer.seed_id, role: 'user', typ: 'session' },
    env.JWT_SECRET,
  );
  const tokenNoHome = jwt.sign(
    { id: userNoHome.id, seed_id: userNoHome.seed_id, role: 'user', typ: 'session' },
    env.JWT_SECRET,
  );

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    db.usersRepo.setPool(testDb.pool);

    for (const u of [userViewer, userFriend, userSpammer, userTownie, userNoHome, userRival6, userActor10]) {
      await testDb.pool.query(
        `INSERT INTO users (id, seed_id, display_name, email, handle, is_public, share_activity, is_test, role, home_municipality)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET home_municipality = EXCLUDED.home_municipality`,
        [
          u.id,
          u.seed_id,
          u.display_name,
          u.email,
          u.handle,
          u.is_public,
          u.share_activity,
          u.is_test,
          u.role,
          u.home_municipality,
        ],
      );
    }

    // Viewer follows Friend (mutual follow)
    await testDb.pool.query(
      `INSERT INTO user_follows (follower_id, following_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING`,
      [userViewer.id, userFriend.id],
    );

    // Seed quest in Dagupan City & Bolinao so Viewer and NoHome have approved submissions
    await testDb.pool.query(
      `INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url, is_test)
       VALUES ('q-dagupan-80', 'Dagupan River Quest', 'Test quest', 'cultural', 'Dagupan City', 16.04, 120.33, 200, 50, 'code-dag-80', 'https://img.test/dag', false),
              ('q-bolinao-80', 'Bolinao Reef Quest', 'Test quest', 'eco', 'Bolinao', 16.32, 119.78, 200, 50, 'code-bol-80', 'https://img.test/bol', false)
       ON CONFLICT (id) DO NOTHING`,
    );

    // Viewer has 1 approved submission in Dagupan City; NoHome has 2 approved submissions in Bolinao (played in Bolinao, but home_municipality is NULL)
    await testDb.pool.query(
      `INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status, is_test)
       VALUES ('sub-viewer-80', 'idem-viewer-80', $1, 'q-dagupan-80', 'code-dag-80', 16.04, 120.33, 5, 'approved', false),
              ('sub-nohome-80a', 'idem-nohome-80a', $2, 'q-bolinao-80', 'code-bol-80', 16.32, 119.78, 5, 'approved', false),
              ('sub-nohome-80b', 'idem-nohome-80b', $2, 'q-dagupan-80', 'code-dag-80', 16.04, 120.33, 5, 'approved', false)
       ON CONFLICT (id) DO NOTHING`,
      [userViewer.id, userNoHome.id],
    );
  }, 90000);

  afterAll(async () => {
    setPool(null);
    db.usersRepo.setPool(null);
    if (testDb) await testDb.close();
  }, 90000);

  beforeEach(async () => {
    clearPlazaFeedCache();
    await testDb.pool.query('DELETE FROM social_activities');
    await testDb.pool.query('DELETE FROM plaza_weekly_scores');
  });

  it('1. Plaza Mixed Feed Bug Fix: user with approved submission in Dagupan still sees municipality=null milestones and other towns in scope=mixed', async () => {
    // Townie earns a badge (municipality: null)
    await recordActivity(testDb.pool, {
      eventKey: 'p80:badge:1',
      actorId: userTownie.id,
      verb: 'badge_earned',
      subjectType: 'badge',
      subjectId: 'badge_heritage',
      subjectTitle: 'Heritage Keeper',
      subjectHref: '/badges',
      municipality: null,
      payload: {},
      isTest: false,
    });

    // Spammer completes a trail in Alaminos City (different town from Viewer's Dagupan City)
    await recordActivity(testDb.pool, {
      eventKey: 'p80:trail:alaminos',
      actorId: userSpammer.id,
      verb: 'trail_completed',
      subjectType: 'trail',
      subjectId: 'trail_alaminos',
      subjectTitle: 'Hundred Islands Trail',
      subjectHref: '/trail',
      municipality: 'Alaminos City',
      payload: { stops: 4 },
      isTest: false,
    });

    const res = await request(app).get('/api/v1/plaza/feed?scope=mixed').set('Authorization', `Bearer ${tokenViewer}`);

    expect(res.status).toBe(200);
    const titles = res.body.data.items.map((i: any) => i.subject.title);
    expect(titles).toContain('Heritage Keeper');
    expect(titles).toContain('Hundred Islands Trail');
  });

  it('2. Plaza Author Diversity Gate: when 1 user posts 5 activities and 2 other users post 1 each, top cards interleave distinct actors', async () => {
    // Spammer posts 5 activities in quick succession
    for (let i = 1; i <= 5; i++) {
      await recordActivity(testDb.pool, {
        eventKey: `p80:spam:${i}`,
        actorId: userSpammer.id,
        verb: 'quest_completed',
        subjectType: 'quest',
        subjectId: `q-spam-${i}`,
        subjectTitle: `Spam Quest ${i}`,
        subjectHref: `/quests/q-spam-${i}`,
        municipality: 'Alaminos City',
        payload: { points: 50 },
        isTest: false,
      });
    }

    // Friend and Townie post 1 activity each
    await recordActivity(testDb.pool, {
      eventKey: 'p80:friend:1',
      actorId: userFriend.id,
      verb: 'spot_posted',
      subjectType: 'spot',
      subjectId: 'spot-patar',
      subjectTitle: 'Patar White Beach',
      subjectHref: '/spots/patar-white-beach',
      municipality: 'Bolinao',
      payload: {},
      isTest: false,
    });

    await recordActivity(testDb.pool, {
      eventKey: 'p80:townie:1',
      actorId: userTownie.id,
      verb: 'town_completed',
      subjectType: 'town',
      subjectId: 'dagupan',
      subjectTitle: 'Dagupan City',
      subjectHref: '/map',
      municipality: 'Dagupan City',
      payload: { quests: 3 },
      isTest: false,
    });

    const res = await request(app).get('/api/v1/plaza/feed?scope=mixed').set('Authorization', `Bearer ${tokenViewer}`);

    expect(res.status).toBe(200);
    const items = res.body.data.items;
    expect(items.length).toBe(7);

    // Top 3 cards must have no two consecutive posts from the same actor
    expect(items[0].actor.user_id).not.toBe(items[1].actor.user_id);
    expect(items[1].actor.user_id).not.toBe(items[2].actor.user_id);

    // Mutual friend's spot_posted and same-town neighbor's town_completed rank at the top
    const top3Actors = items.slice(0, 3).map((i: any) => i.actor.user_id);
    expect(top3Actors).toContain(userFriend.id);
    expect(top3Actors).toContain(userTownie.id);
  });

  it('3. Plaza scope=town uses users.home_municipality ONLY (never inferred from where someone played)', async () => {
    // Activity in Dagupan City
    await recordActivity(testDb.pool, {
      eventKey: 'p80:town:dagupan',
      actorId: userTownie.id,
      verb: 'quest_completed',
      subjectType: 'quest',
      subjectId: 'q-dag-1',
      subjectTitle: 'Dagupan Town Quest',
      subjectHref: '/quests/q-dag-1',
      municipality: 'Dagupan City',
      payload: { points: 50 },
      isTest: false,
    });

    // Activity in Bolinao
    await recordActivity(testDb.pool, {
      eventKey: 'p80:town:bolinao',
      actorId: userFriend.id,
      verb: 'quest_completed',
      subjectType: 'quest',
      subjectId: 'q-bol-1',
      subjectTitle: 'Bolinao Town Quest',
      subjectHref: '/quests/q-bol-1',
      municipality: 'Bolinao',
      payload: { points: 50 },
      isTest: false,
    });

    // userNoHome played in Bolinao & Dagupan, but has home_municipality = NULL -> must get empty items + reason: NO_HOME_TOWN
    const noHomeRes = await request(app)
      .get('/api/v1/plaza/feed?scope=town')
      .set('Authorization', `Bearer ${tokenNoHome}`);
    expect(noHomeRes.status).toBe(200);
    expect(noHomeRes.body.data.items).toEqual([]);
    expect(noHomeRes.body.data.reason).toBe('NO_HOME_TOWN');

    // userViewer has home_municipality = 'Dagupan City' -> sees only Dagupan City activities
    const viewerTownRes = await request(app)
      .get('/api/v1/plaza/feed?scope=town')
      .set('Authorization', `Bearer ${tokenViewer}`);
    expect(viewerTownRes.status).toBe(200);
    expect(viewerTownRes.body.data.items.map((i: any) => i.subject.title)).toEqual(['Dagupan Town Quest']);
    expect(viewerTownRes.body.data.items[0].reason_label).toBe('In Dagupan City');

    // When userNoHome sets home town to Bolinao via setHomeTown, scope=town immediately returns Bolinao activity
    await setHomeTown(userNoHome.id, 'Bolinao');
    const afterSetRes = await request(app)
      .get('/api/v1/plaza/feed?scope=town')
      .set('Authorization', `Bearer ${tokenNoHome}`);
    expect(afterSetRes.status).toBe(200);
    expect(afterSetRes.body.data.items.map((i: any) => i.subject.title)).toEqual(['Bolinao Town Quest']);

    // Reset userNoHome back to NULL
    await setHomeTown(userNoHome.id, null);
  });

  it('4. Plaza Rivals: viewer ranked #5, actor ranked #6 gets reason rival and reason_label Rival · #6 This Week, actor ranked #10 does not', async () => {
    const wStart = weekStartDate(new Date());

    await testDb.pool.query(
      `INSERT INTO plaza_weekly_scores (week_start, user_id, rank, score, is_test)
       VALUES ($1, $2, 5, 500, false),
              ($1, $3, 6, 450, false),
              ($1, $4, 10, 200, false)`,
      [wStart, userViewer.id, userRival6.id, userActor10.id],
    );

    // Record activity for Rival 6 and Actor 10
    await recordActivity(testDb.pool, {
      eventKey: 'p80:rival:6',
      actorId: userRival6.id,
      verb: 'quest_completed',
      subjectType: 'quest',
      subjectId: 'q-rival-6',
      subjectTitle: 'Rival 6 Quest',
      subjectHref: '/quests/q-rival-6',
      municipality: 'Alaminos City',
      payload: { points: 50 },
      isTest: false,
    });

    await recordActivity(testDb.pool, {
      eventKey: 'p80:actor:10',
      actorId: userActor10.id,
      verb: 'quest_completed',
      subjectType: 'quest',
      subjectId: 'q-actor-10',
      subjectTitle: 'Actor 10 Quest',
      subjectHref: '/quests/q-actor-10',
      municipality: 'Alaminos City',
      payload: { points: 50 },
      isTest: false,
    });

    const res = await request(app).get('/api/v1/plaza/feed?scope=mixed').set('Authorization', `Bearer ${tokenViewer}`);

    expect(res.status).toBe(200);
    const items = res.body.data.items;

    const itemRival6 = items.find((i: any) => i.actor.user_id === userRival6.id);
    expect(itemRival6).toBeDefined();
    expect(itemRival6.reason).toBe('rival');
    expect(itemRival6.reason_label).toBe('Rival · #6 This Week');

    const itemActor10 = items.find((i: any) => i.actor.user_id === userActor10.id);
    expect(itemActor10).toBeDefined();
    expect(itemActor10.reason).not.toBe('rival');
    expect(itemActor10.reason_label).not.toContain('Rival');
  });

  it('5. Plaza Mixed Feed Paging: 170 activities paging with next_cursor returns all 170, no duplicates', async () => {
    // Clear feed cache & activities
    clearPlazaFeedCache();
    await testDb.pool.query('DELETE FROM social_activities');

    // Insert 170 activities with ordered timestamps
    const baseTimeMs = Date.now() - 3600 * 1000;
    const values: any[] = [];
    const placeholders: string[] = [];
    for (let i = 0; i < 170; i++) {
      const idx = String(i).padStart(3, '0');
      const actId = `act-p80-170-${idx}`;
      const eventKey = `p80:act170:${idx}`;
      const dt = new Date(baseTimeMs + i * 1000).toISOString();
      const p = placeholders.length * 5;
      placeholders.push(`($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5})`);
      values.push(actId, eventKey, userTownie.id, `Title ${idx}`, dt);
    }

    await testDb.pool.query(
      `INSERT INTO social_activities (id, event_key, actor_id, verb, subject_type, subject_id, subject_title, subject_href, municipality, is_test, created_at)
       SELECT v.id, v.event_key, v.actor_id, 'quest_completed', 'quest', 'q-dag-1', v.title, '/quests/q-dag-1', 'Dagupan City', false, v.created_at::timestamptz
       FROM (VALUES ${placeholders.join(', ')}) AS v(id, event_key, actor_id, title, created_at)`,
      values,
    );

    let nextCursor: string | null = null;
    const collectedIds: string[] = [];
    let pageCount = 0;

    do {
      const query = nextCursor
        ? `?scope=mixed&limit=50&cursor=${encodeURIComponent(nextCursor)}`
        : '?scope=mixed&limit=50';
      const res = await request(app).get(`/api/v1/plaza/feed${query}`).set('Authorization', `Bearer ${tokenViewer}`);

      expect(res.status).toBe(200);
      const items = res.body.data.items;
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        collectedIds.push(item.id);
      }
      nextCursor = res.body.data.next_cursor;
      pageCount++;
      if (pageCount > 10) break;
    } while (nextCursor);

    expect(collectedIds.length).toBe(170);
    expect(new Set(collectedIds).size).toBe(170);
  }, 30000);

  it('6. Plaza Post Merit & 72h Exhaustion Duration: cheered stranger post gains Popular reach, then exhausts after 72 hours', async () => {
    clearPlazaFeedCache();
    await testDb.pool.query('DELETE FROM social_activities');

    const nowMs = Date.now();
    const recentCreatedAt = new Date(nowMs - 2 * 3_600_000).toISOString(); // 2h ago (in peak 24h window)
    const oldExhaustedAt = new Date(nowMs - 80 * 3_600_000).toISOString(); // 80h ago (> 72h exhaustion cutoff)

    await testDb.pool.query(
      `INSERT INTO social_activities (id, event_key, actor_id, verb, subject_type, subject_id, subject_title, subject_href, municipality, cheer_count, comment_count, is_test, created_at)
       VALUES
         ('act-merit-fresh', 'p80:merit:fresh', $1, 'quest_completed', 'quest', 'q-merit-1', 'Fresh Popular Quest', '/quests/q-merit-1', 'Bolinao', 4, 1, false, $2),
         ('act-normal-fresh', 'p80:merit:normal', $3, 'quest_completed', 'quest', 'q-merit-2', 'Normal Uncheered Quest', '/quests/q-merit-2', 'Bolinao', 0, 0, false, $2),
         ('act-merit-exhausted', 'p80:merit:exhausted', $1, 'quest_completed', 'quest', 'q-merit-3', 'Old Viral Quest', '/quests/q-merit-3', 'Bolinao', 12, 3, false, $4)`,
      [userActor10.id, recentCreatedAt, userSpammer.id, oldExhaustedAt],
    );

    const res = await request(app).get('/api/v1/plaza/feed?scope=mixed').set('Authorization', `Bearer ${tokenViewer}`);

    expect(res.status).toBe(200);
    const items = res.body.data.items;

    const freshPopular = items.find((i: any) => i.id === 'act-merit-fresh');
    const _freshNormal = items.find((i: any) => i.id === 'act-normal-fresh');
    const oldExhausted = items.find((i: any) => i.id === 'act-merit-exhausted');

    expect(freshPopular).toBeDefined();
    expect(freshPopular.reason).toBe('popular');
    expect(freshPopular.reason_label).toBe('Popular · 4 cheers');

    // Popular post outranks same-age uncheered post
    const idxPopular = items.findIndex((i: any) => i.id === 'act-merit-fresh');
    const idxNormal = items.findIndex((i: any) => i.id === 'act-normal-fresh');
    const idxExhausted = items.findIndex((i: any) => i.id === 'act-merit-exhausted');
    expect(idxPopular).toBeLessThan(idxNormal);

    // Exhausted viral post (>72h) loses 'popular' reason and ranks below fresh posts
    expect(oldExhausted).toBeDefined();
    expect(oldExhausted.reason).not.toBe('popular');
    expect(idxExhausted).toBeGreaterThan(idxNormal);
  });
});
