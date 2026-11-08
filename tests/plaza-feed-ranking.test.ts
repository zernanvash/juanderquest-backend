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

  const tokenViewer = jwt.sign(
    { id: userViewer.id, seed_id: userViewer.seed_id, role: 'user' },
    env.JWT_SECRET,
  );
  const tokenNoHome = jwt.sign(
    { id: userNoHome.id, seed_id: userNoHome.seed_id, role: 'user' },
    env.JWT_SECRET,
  );

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    db.usersRepo.setPool(testDb.pool);

    for (const u of [userViewer, userFriend, userSpammer, userTownie, userNoHome]) {
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

    const res = await request(app)
      .get('/api/v1/plaza/feed?scope=mixed')
      .set('Authorization', `Bearer ${tokenViewer}`);

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

    const res = await request(app)
      .get('/api/v1/plaza/feed?scope=mixed')
      .set('Authorization', `Bearer ${tokenViewer}`);

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
    expect(viewerTownRes.body.data.items.map((i: any) => i.subject.title)).toEqual([
      'Dagupan Town Quest',
    ]);
    expect(viewerTownRes.body.data.items[0].reason_label).toBe('In Dagupan City');

    // When userNoHome sets home town to Bolinao via setHomeTown, scope=town immediately returns Bolinao activity
    await setHomeTown(userNoHome.id, 'Bolinao');
    const afterSetRes = await request(app)
      .get('/api/v1/plaza/feed?scope=town')
      .set('Authorization', `Bearer ${tokenNoHome}`);
    expect(afterSetRes.status).toBe(200);
    expect(afterSetRes.body.data.items.map((i: any) => i.subject.title)).toEqual([
      'Bolinao Town Quest',
    ]);

    // Reset userNoHome back to NULL
    await setHomeTown(userNoHome.id, null);
  });
});
