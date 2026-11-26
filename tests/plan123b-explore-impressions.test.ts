import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { signSessionToken } from '../src/auth/tokens.js';
import { createTestDb } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { loadUserFatigueDays, pruneOldFeedImpressions, recordSpotFeedImpressions } from '../src/spots/impressions.js';
import { manilaDayKey, rankExploreSpotsPage } from '../src/spots/recommender.js';
import { SpotStore, spotStore, type Spot } from '../src/spots/store.js';

function makeSpot(idx: number, overrides: Partial<Spot> = {}): Spot {
  const nowIso = new Date(Date.now() - 40 * 86_400_000).toISOString();
  return {
    id: `spot-imp-${idx}`,
    slug: `spot-imp-${String(idx).padStart(3, '0')}`,
    name: `Impression Spot ${idx}`,
    description: 'A scenic Pangasinan destination with clean facilities, local stalls, and clear visitor trails.',
    category: 'nature_outdoors',
    subcategory: 'beach',
    tags: ['scenic'],
    municipality: ['Bolinao', 'Alaminos', 'Lingayen', 'Dagupan City'][idx % 4],
    address: `Address ${idx}`,
    gps_lat: 16.0 + idx * 0.01,
    gps_lng: 120.0 + idx * 0.01,
    price_level: 1,
    hours: { daily: '08:00-17:00' },
    amenities: ['parking'],
    image_url: 'https://example.com/photo.jpg',
    source_type: 'editorial',
    source_name: 'JuanDerQuest',
    trust_level: 'editorial',
    status: 'published',
    created_by: `author-${idx}`,
    created_at: nowIso,
    updated_at: nowIso,
    ...overrides,
  };
}

function dayOffset(baseManilaDay: string, deltaDays: number): string {
  const ms = Date.parse(`${baseManilaDay}T00:00:00Z`) + deltaDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

describe('Plan 123b: Explore Impressions + Fatigue', () => {
  it('1. Fatigue curve applies x1.00 / x0.80 / x0.55 / x0.30 for 0 / 1 / 2 / >=3 prior days under R4', () => {
    const store = new SpotStore();
    const nowMs = Date.UTC(2026, 10, 26, 4, 0, 0); // 12:00 PHT on 2026-11-26
    const today = manilaDayKey(nowMs);
    const s0 = makeSpot(1, { id: 'spot-f0', slug: 'spot-f-a' });
    const s1 = makeSpot(2, { id: 'spot-f1', slug: 'spot-f-b' });
    const s2 = makeSpot(3, { id: 'spot-f2', slug: 'spot-f-c' });
    const s3 = makeSpot(4, { id: 'spot-f3', slug: 'spot-f-d' });
    store.spots = [s0, s1, s2, s3];

    const userId = 'user-fatigue-curve';
    // 1 prior day
    store.recordFeedImpressions(userId, [s1.id], dayOffset(today, -1));
    // 2 prior days
    store.recordFeedImpressions(userId, [s2.id], dayOffset(today, -1));
    store.recordFeedImpressions(userId, [s2.id], dayOffset(today, -2));
    // 3 prior days (4 days ago, 5 days ago, 6 days ago)
    store.recordFeedImpressions(userId, [s3.id], dayOffset(today, -4));
    store.recordFeedImpressions(userId, [s3.id], dayOffset(today, -5));
    store.recordFeedImpressions(userId, [s3.id], dayOffset(today, -6));

    const ranked = rankExploreSpotsPage(store, { userId, now: nowMs, limit: 10 });
    const score0 = ranked.items.find((i) => i.id === s0.id)!.recommendation_score;
    const score1 = ranked.items.find((i) => i.id === s1.id)!.recommendation_score;
    const score2 = ranked.items.find((i) => i.id === s2.id)!.recommendation_score;
    const score3 = ranked.items.find((i) => i.id === s3.id)!.recommendation_score;

    expect(score1 / score0).toBeCloseTo(0.8, 1);
    expect(score2 / score0).toBeCloseTo(0.55, 1);
    expect(score3 / score0).toBeCloseTo(0.3, 1);
  });

  it('2. Same-day impressions do not change today ranking or state fingerprint (R1), but apply tomorrow', () => {
    const store = new SpotStore();
    const nowMs = Date.UTC(2026, 10, 26, 4, 0, 0);
    const today = manilaDayKey(nowMs);
    const sA = makeSpot(10, { id: 'spot-sameday-a' });
    const sB = makeSpot(11, { id: 'spot-sameday-b' });
    store.spots = [sA, sB];

    const userId = 'user-sameday-1';
    const before = rankExploreSpotsPage(store, { userId, now: nowMs, limit: 10 });
    const scoreABefore = before.items.find((i) => i.id === sA.id)!.recommendation_score;

    // Record impression TODAY
    store.recordFeedImpressions(userId, [sA.id], today);

    // Same day -> score and order must be identical
    const afterToday = rankExploreSpotsPage(store, { userId, now: nowMs, limit: 10 });
    expect(afterToday.items.find((i) => i.id === sA.id)!.recommendation_score).toBe(scoreABefore);
    expect(afterToday.items.map((i) => i.id)).toEqual(before.items.map((i) => i.id));

    // Next day -> yesterday's impression now enters the 7-day-before-today window (x0.80)
    const tomorrowMs = nowMs + 86_400_000;
    const tomorrow = rankExploreSpotsPage(store, { userId, now: tomorrowMs, limit: 10 });
    const scoreATomorrow = tomorrow.items.find((i) => i.id === sA.id)!.recommendation_score;
    const scoreBTomorrow = tomorrow.items.find((i) => i.id === sB.id)!.recommendation_score;
    expect(scoreATomorrow / scoreBTomorrow).toBeCloseTo(0.8, 1);
  });

  it('2b. The fatigue cache keeps only the current day (bounded memory)', async () => {
    const store = new SpotStore();
    await loadUserFatigueDays(store, null, 'user-cache-a', '2026-11-25');
    await loadUserFatigueDays(store, null, 'user-cache-b', '2026-11-25');
    expect(store.feedImpressionDaysCache.size).toBe(2);
    await loadUserFatigueDays(store, null, 'user-cache-a', '2026-11-26');
    expect([...store.feedImpressionDaysCache.keys()]).toEqual(['user-cache-a|2026-11-26']);
  });

  it('3. Like, save, or detail open (view) in the 7-day window cancels fatigue', () => {
    const store = new SpotStore();
    const nowMs = Date.UTC(2026, 10, 26, 4, 0, 0);
    const today = manilaDayKey(nowMs);
    const clean = makeSpot(20, { id: 'spot-clean' });
    const fatigued = makeSpot(21, { id: 'spot-fatigued' });
    const viewed = makeSpot(22, { id: 'spot-viewed' });
    store.spots = [clean, fatigued, viewed];

    const userId = 'user-cancel-fatigue';
    for (const d of [-1, -2, -3]) {
      store.recordFeedImpressions(userId, [fatigued.id, viewed.id], dayOffset(today, d));
    }
    // Detail open ('view') inside the 7-day window cancels fatigue for `viewed`
    store.interact(userId, viewed.id, 'view', true);
    store.interactionTimestamps.set(`${userId}:${viewed.id}:view`, nowMs - 2 * 86_400_000);

    const ranked = rankExploreSpotsPage(store, { userId, now: nowMs, limit: 10 });
    const sClean = ranked.items.find((i) => i.id === clean.id)!.recommendation_score;
    const sFatigued = ranked.items.find((i) => i.id === fatigued.id)!.recommendation_score;
    const sViewed = ranked.items.find((i) => i.id === viewed.id)!.recommendation_score;

    expect(sFatigued / sClean).toBeCloseTo(0.3, 1);
    expect(sViewed).toBeGreaterThan(sFatigued * 2);
  });

  it('4. Guest gets 401 and batch > 30 IDs gets 400 on POST /api/v1/spots/impressions', async () => {
    const guestRes = await request(app)
      .post('/api/v1/spots/impressions')
      .send({ spot_ids: ['spot-1'] });
    expect(guestRes.status).toBe(401);

    const user =
      db.users[0] ??
      ({
        id: 'imp-val-1',
        seed_id: 'imp-val-1',
        email: 'imp-val@example.com',
        display_name: 'Imp Val',
        handle: 'imp_val_1',
        role: 'user',
      } as (typeof db.users)[number]);
    if (!db.users.includes(user)) db.users.push(user);
    const token = signSessionToken(user);

    const tooMany = Array.from({ length: 31 }, (_, i) => `spot-${i}`);
    const overRes = await request(app)
      .post('/api/v1/spots/impressions')
      .set('Authorization', `Bearer ${token}`)
      .send({ spot_ids: tooMany });
    expect(overRes.status).toBe(400);
  });

  it('5. Real-PG: upsert caps seen_count at 10, ignores unknown/unpublished, and prune deletes > 14d rows', async () => {
    const handle = await createTestDb({ schemaPrefix: 'plan123b_imp' });
    if (!handle.usingRealPostgres) {
      await handle.close();
      return;
    }

    const pool = handle.pool;
    setPool(pool);
    const originalSpots = [...spotStore.spots];
    try {
      const userId = '00000000-0000-4000-8000-00000000123b';
      await pool.query(
        `INSERT INTO users (id, email, display_name, handle, role)
         VALUES ($1, 'imp-pg@example.com', 'Imp PG', 'imp_pg_user', 'user')
         ON CONFLICT (id) DO NOTHING`,
        [userId],
      );

      const pubSpot = makeSpot(50, { id: 'spot-pg-pub', slug: 'spot-pg-pub', status: 'published' });
      const heldSpot = makeSpot(51, { id: 'spot-pg-held', slug: 'spot-pg-held', status: 'held' });
      for (const sp of [pubSpot, heldSpot]) {
        await pool.query(
          `INSERT INTO spots (id, slug, name, description, category, subcategory, tags, municipality, address, gps_lat, gps_lng, price_level, hours, amenities, image_url, source_type, source_name, trust_level, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           ON CONFLICT (id) DO NOTHING`,
          [
            sp.id,
            sp.slug,
            sp.name,
            sp.description,
            sp.category,
            sp.subcategory,
            JSON.stringify(sp.tags),
            sp.municipality,
            sp.address,
            sp.gps_lat,
            sp.gps_lng,
            sp.price_level,
            JSON.stringify(sp.hours),
            JSON.stringify(sp.amenities),
            sp.image_url,
            sp.source_type,
            sp.source_name,
            sp.trust_level,
            sp.status,
          ],
        );
      }
      spotStore.spots = [pubSpot, heldSpot];

      const nowMs = Date.UTC(2026, 10, 26, 4, 0, 0);
      const today = manilaDayKey(nowMs);

      // Call 12 times: seen_count should cap at 10, unknown/held ignored
      for (let i = 0; i < 12; i++) {
        await recordSpotFeedImpressions(spotStore, pool, userId, [pubSpot.id, heldSpot.id, 'nonexistent-id'], nowMs);
      }

      const { rows } = await pool.query<{ spot_id: string; seen_count: number }>(
        `SELECT spot_id, seen_count FROM spot_feed_impressions WHERE user_id = $1`,
        [userId],
      );
      expect(rows).toEqual([{ spot_id: pubSpot.id, seen_count: 10 }]);

      // Insert a 20-day-old row and verify prune removes it while keeping today's row
      const oldDay = dayOffset(today, -20);
      await pool.query(
        `INSERT INTO spot_feed_impressions (user_id, spot_id, manila_day, seen_count)
         VALUES ($1, $2, $3::date, 2)`,
        [userId, pubSpot.id, oldDay],
      );
      const deleted = await pruneOldFeedImpressions(spotStore, pool, today);
      expect(deleted).toBe(1);

      const { rows: afterPrune } = await pool.query<{ manila_day: string }>(
        `SELECT to_char(manila_day, 'YYYY-MM-DD') AS manila_day FROM spot_feed_impressions WHERE user_id = $1`,
        [userId],
      );
      expect(afterPrune.map((r) => r.manila_day)).toEqual([today]);
    } finally {
      spotStore.spots = originalSpots;
      setPool(null);
      await handle.close();
    }
  });
});
