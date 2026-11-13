import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { env } from '../src/config/env.js';

// Owner 2026-11-08: "add bio, 3 badges equipped" + home town, Pasaporte,
// explorer stats, latest journey and a favourite spot (migration 082).
const realPgDescribe = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPgDescribe('profile showcase (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const sfx = randomUUID().slice(0, 8);
  const me = `sc-me-${sfx}`;
  const quiet = `sc-quiet-${sfx}`;
  const hidden = `sc-hidden-${sfx}`;
  const token = (id: string) => jwt.sign({ id, seed_id: id, role: 'user', typ: 'session' }, env.JWT_SECRET);
  const spotId = `spot-sc-${sfx}`;

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    const q = (sql: string, p: unknown[]) => fixture.pool.query(sql, p);
    for (const [id, pub, share] of [
      [me, true, true],
      [quiet, true, false],
      [hidden, false, true],
    ] as const) {
      await q(
        `INSERT INTO users (id, seed_id, display_name, email, role, handle, is_public, share_activity, bio, home_municipality, is_test)
         VALUES ($1, $2, $3, $4, 'user', $5, $6, $7, $8, $9, false)`,
        [
          id,
          id,
          `Scout ${id}`,
          `${id}@example.com`,
          id.replace(/-/g, '_'),
          pub,
          share,
          'Bangus lover from the coast.',
          'Dagupan City',
        ],
      );
    }
    await q(
      `INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,price_level,source_type,source_name,trust_level,status,created_by,is_test)
       VALUES ($1,$2,'Tondaligan Beach','Test.','nature_outdoors','beach','Dagupan City','',16.06,120.33,1,'community','test','community','published',$3,FALSE)`,
      [spotId, spotId, me],
    );
    for (const [i, town] of [
      [1, 'Dagupan City'],
      [2, 'Bolinao'],
      [3, 'Alaminos City'],
      [4, 'Manila'],
    ] as const) {
      const qid = `q-sc-${sfx}-${i}`;
      await q(
        `INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url, is_test)
         VALUES ($1, $2, 'Test.', 'cultural', $3, 16.1, 120.3, 100, 50, $4, 'https://img.test/x', false)`,
        [qid, `Quest ${i}`, town, `code-sc-${sfx}-${i}`],
      );
      await q(
        `INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status, is_test, created_at)
         VALUES ($1, $2, $3, $4, $5, 16.1, 120.3, 5, 'approved', false, now() - ($6 || ' hours')::interval)`,
        [`sub-sc-${sfx}-${i}`, `idem-sc-${sfx}-${i}`, me, qid, `code-sc-${sfx}-${i}`, String(i)],
      );
      await q(
        `INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status, is_test)
         VALUES ($1, $2, $3, $4, $5, 16.1, 120.3, 5, 'approved', false)`,
        [`sub-scq-${sfx}-${i}`, `idem-scq-${sfx}-${i}`, quiet, qid, `code-sc-${sfx}-${i}`],
      );
    }
    for (const badge of ['first_footstep', 'pangasinan_pioneer']) {
      await q(`INSERT INTO achievement_awards (id, user_id, achievement_id) VALUES ($1, $2, $3)`, [
        randomUUID(),
        me,
        badge,
      ]);
    }
    await q(
      `INSERT INTO achievement_awards (id, user_id, achievement_id, revoked_at) VALUES ($1, $2, 'heritage_seeker', now())`,
      [randomUUID(), me],
    );
    await q(
      `INSERT INTO plaza_weekly_scores (week_start, user_id, score, quests, rank, is_test) VALUES (date '2026-11-02', $1, 100, 2, 4, false)`,
      [me],
    );
  }, 90000);

  afterAll(async () => {
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  }, 90000);

  const auth = (id = me) => ({ Authorization: `Bearer ${token(id)}` });

  it('shows bio, home town, Pasaporte, stats and the latest 3 quests', async () => {
    const res = await request(app).get('/api/v1/me/showcase').set(auth());
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.bio).toBe('Bangus lover from the coast.');
    expect(d.home_municipality).toBe('Dagupan City');
    // Manila is not a Pangasinan town, so it is not stamped.
    expect(d.pasaporte).toEqual({ visited: ['Alaminos City', 'Bolinao', 'Dagupan City'], total: 48 });
    expect(d.stats).toEqual({
      quests_completed: 4,
      spots_posted: 1,
      trails_completed: 0,
      best_weekly_rank: 4,
      badges_earned: 2,
    });
    expect(d.latest_journey.map((j: any) => j.title)).toEqual(['Quest 1', 'Quest 2', 'Quest 3']);
  });

  it('equips up to 3 earned badges, in order; revoked or unearned ones are refused', async () => {
    const ok = await request(app)
      .put('/api/v1/me/featured-badges')
      .set(auth())
      .send({ badge_ids: ['pangasinan_pioneer', 'first_footstep'] });
    expect(ok.status).toBe(200);
    const revoked = await request(app)
      .put('/api/v1/me/featured-badges')
      .set(auth())
      .send({ badge_ids: ['heritage_seeker'] });
    expect(revoked.body.error?.code).toBe('BADGE_NOT_EARNED');
    const tooMany = await request(app)
      .put('/api/v1/me/featured-badges')
      .set(auth())
      .send({ badge_ids: ['a', 'b', 'c', 'd'] });
    expect(tooMany.status).toBe(400);
    const show = await request(app).get(`/api/v1/users/${me.replace(/-/g, '_')}/showcase`);
    expect(show.body.data.featured_badges.map((b: any) => b.id)).toEqual(['pangasinan_pioneer', 'first_footstep']);
    expect(show.body.data.featured_badges[0].title).toBe('Pangasinan Pioneer');
  });

  it('sets and clears a favourite spot (published spots only)', async () => {
    expect(
      (await request(app).put('/api/v1/me/favorite-spot').set(auth()).send({ spot_id: 'nope' })).body.error?.code,
    ).toBe('SPOT_NOT_FOUND');
    expect((await request(app).put('/api/v1/me/favorite-spot').set(auth()).send({ spot_id: spotId })).status).toBe(200);
    expect((await request(app).get('/api/v1/me/showcase').set(auth())).body.data.favorite_spot).toMatchObject({
      id: spotId,
      name: 'Tondaligan Beach',
    });
    expect((await request(app).put('/api/v1/me/favorite-spot').set(auth()).send({ spot_id: null })).status).toBe(200);
    expect((await request(app).get('/api/v1/me/showcase').set(auth())).body.data.favorite_spot).toBeNull();
  });

  it('respects privacy: no journey when activity is not shared, nothing for private profiles', async () => {
    const quietRes = await request(app).get(`/api/v1/users/${quiet.replace(/-/g, '_')}/showcase`);
    expect(quietRes.status).toBe(200);
    expect(quietRes.body.data.latest_journey).toEqual([]);
    expect(quietRes.body.data.stats.quests_completed).toBe(4);
    const own = await request(app)
      .get(`/api/v1/users/${quiet.replace(/-/g, '_')}/showcase`)
      .set(auth(quiet));
    expect(own.body.data.latest_journey).toHaveLength(3);
    expect((await request(app).get(`/api/v1/users/${hidden.replace(/-/g, '_')}/showcase`)).status).toBe(404);
    expect((await request(app).put('/api/v1/me/featured-badges').send({ badge_ids: [] })).status).toBe(401);
  });
});
