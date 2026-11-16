import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { env } from '../src/config/env.js';
import { parseRecapPeriod } from '../src/social/recap.js';

describe('parseRecapPeriod', () => {
  const now = new Date('2026-11-16T04:00:00Z');
  it('defaults to the current Manila season', () => {
    const p = parseRecapPeriod(undefined, now)!;
    expect(p.id).toBe('season:2026-S4');
    expect(p.start.toISOString()).toBe('2026-09-30T16:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-12-31T16:00:00.000Z');
  });
  it('accepts a year and rejects bad or future periods', () => {
    expect(parseRecapPeriod('year:2026', now)?.label).toBe('2026');
    expect(parseRecapPeriod('year:2027', now)).toBeNull();
    expect(parseRecapPeriod('season:2026-S5', now)).toBeNull();
    expect(parseRecapPeriod('month:2026-11', now)).toBeNull();
  });
});

const realPgDescribe = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPgDescribe('GET /me/recap (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const sfx = randomUUID().slice(0, 8);
  const me = `rc-me-${sfx}`;
  const token = jwt.sign({ id: me, seed_id: me, role: 'user', typ: 'session' }, env.JWT_SECRET);
  const season = parseRecapPeriod(undefined)!;
  const inSeason = new Date(Math.max(season.start.getTime() + 3600_000, Date.now() - 3600_000)).toISOString();
  const lastYear = new Date(season.start.getTime() - 400 * 86400_000).toISOString();

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    const q = (sql: string, p: unknown[] = []) => fixture.pool.query(sql, p);
    await q(
      `INSERT INTO users (id, seed_id, display_name, email, role, handle, is_public, is_test)
       VALUES ($1::text, $1::text, 'Recap Scout', $1::text || '@example.com', 'user', $2, true, false)`,
      [me, me.replace(/-/g, '_')],
    );
    const quests: Array<[number, string, string, string]> = [
      [1, 'Dagupan City', 'cultural', inSeason],
      [2, 'Bolinao', 'cultural', inSeason],
      [3, 'Alaminos City', 'eco', inSeason],
      [4, 'Lingayen', 'eco', lastYear],
    ];
    for (const [i, town, category, at] of quests) {
      const qid = `q-rc-${sfx}-${i}`;
      await q(
        `INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url, is_test)
         VALUES ($1, $2, 'Test.', $3, $4, 16.1, 120.3, 100, 50, $5, 'https://img.test/x', false)`,
        [qid, `Quest ${i}`, category, town, `code-rc-${sfx}-${i}`],
      );
      await q(
        `INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status, is_test, created_at)
         VALUES ($1, $2, $3, $4, $5, 16.1, 120.3, 5, 'approved', false, $6)`,
        [`sub-rc-${sfx}-${i}`, `idem-rc-${sfx}-${i}`, me, qid, `code-rc-${sfx}-${i}`, at],
      );
    }
    for (const [id, town] of [
      [`spot-rc-${sfx}-a`, 'Dagupan City'],
      [`spot-rc-${sfx}-b`, 'San Fabian'],
      [`spot-rc-${sfx}-c`, 'San Fabian'],
    ]) {
      await q(
        `INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,price_level,source_type,source_name,trust_level,status,created_by,is_test,created_at)
         VALUES ($1::text,$1::text,'Recap Spot','Test.','nature_outdoors','beach',$2,'',16.06,120.33,1,'community','test','community','published',$3,FALSE,$4)`,
        [id, town, id.endsWith('-a') ? me : null, inSeason],
      );
    }
    await q(
      `INSERT INTO stamp_ledger (user_id, delta, source, source_key, manila_date, week_id, created_at)
       VALUES ($1, 3, 'daily_claim', $2, current_date, '2026-W46', $3), ($1, -2, 'spend', $4, current_date, '2026-W46', $3)`,
      [me, `k1-${sfx}`, inSeason, `k2-${sfx}`],
    );
    await q(`INSERT INTO user_streaks (user_id, current_streak, best_streak) VALUES ($1, 2, 6)`, [me]);
  });

  afterAll(async () => {
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  });

  it('summarises the current season for its owner only', async () => {
    expect((await request(app).get('/api/v1/me/recap')).status).toBe(401);
    const res = await request(app).get('/api/v1/me/recap').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    const d = res.body.data;
    expect(d.period.id).toBe(season.id);
    expect(d.quests_completed).toBe(3);
    expect(d.towns).toEqual(expect.arrayContaining(['Dagupan City', 'Bolinao', 'Alaminos City']));
    expect(d.towns).not.toContain('Lingayen');
    expect(d.top_category).toBe('cultural');
    expect(d.persona).toBe('Heritage Hunter');
    expect(d.spots_posted).toBe(1);
    expect(d.stamps_earned).toBe(3);
    expect(d.best_streak).toBe(6);
    expect(d.where_next).not.toBeNull();
    expect(d.towns).not.toContain(d.where_next);
    // Towns only: no coordinates or timestamps in the payload.
    expect(JSON.stringify(d)).not.toMatch(/gps|lat|lng|T\d{2}:\d{2}/);
  });

  it('rejects an invalid period', async () => {
    const res = await request(app).get('/api/v1/me/recap?period=year:2999').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});
