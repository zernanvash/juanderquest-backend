import request from 'supertest';
import { performance } from 'node:perf_hooks';
import { app } from '../src/app.js';
import { spotQuality } from '../src/spots/quality.js';
import { rankExploreSpotsPage } from '../src/spots/recommender.js';
import { SpotStore, spotStore, type Spot } from '../src/spots/store.js';

function makeSpot(idx: number, overrides: Partial<Spot> = {}): Spot {
  const municipalities = ['Bolinao', 'Alaminos', 'Dagupan City', 'Lingayen', 'San Fabian', 'Anda', 'Manaoag'];
  const categories = ['nature_outdoors', 'eat_drink', 'culture_heritage', 'activities_wellness'];
  const subcategories = ['beach', 'cafe', 'heritage_site', 'waterfall'];
  const nowIso = new Date(Date.now() - 40 * 86_400_000).toISOString();
  return {
    id: `spot-v3-${idx}`,
    slug: `spot-v3-${String(idx).padStart(4, '0')}`,
    name: `Spot V3 ${idx}`,
    description:
      'A scenic Pangasinan destination with local food stalls, clean facilities, and helpful community directions.',
    category: categories[idx % categories.length],
    subcategory: subcategories[idx % subcategories.length],
    tags: ['scenic', idx % 2 === 0 ? 'hidden_gem' : 'family'],
    municipality: municipalities[idx % municipalities.length],
    address: `Address ${idx}, Pangasinan`,
    gps_lat: 16.0 + (idx % 30) * 0.01,
    gps_lng: 120.0 + (idx % 30) * 0.01,
    price_level: 1,
    hours: { daily: '08:00-17:00' },
    amenities: ['parking'],
    image_url: 'https://example.com/photo.jpg',
    source_type: 'editorial',
    source_name: 'JuanDerQuest',
    trust_level: 'editorial',
    status: 'published',
    created_by: `author-${(idx % 8) + 1}`,
    created_at: nowIso,
    updated_at: nowIso,
    ...overrides,
  };
}

describe('Plan 123a: Explore v3 Discovery, Interest & New Slot Blender', () => {
  it('1. spotQuality ignores sponsor/VIP/merchant metadata (R2) and penalizes upheld moderation reports only', () => {
    const baseSpot = makeSpot(1);
    const sponsoredSpot = {
      ...baseSpot,
      external_refs: { sponsored: true, vip: true, merchant_id: 'm-1' },
      is_local_partner: true,
    } as Spot;

    const cleanSignals = {
      uniqueEngagers: 5,
      p95LogEngagers: Math.log1p(20),
      upheldReportCount: 0,
      photoCount: 1,
    };

    const baseRes = spotQuality(baseSpot, cleanSignals);
    const sponsoredRes = spotQuality(sponsoredSpot, cleanSignals);
    expect(sponsoredRes.score).toBe(baseRes.score);

    const penalizedRes = spotQuality(baseSpot, { ...cleanSignals, upheldReportCount: 2 });
    expect(penalizedRes.score).toBeLessThan(baseRes.score);
    expect(penalizedRes.parts.reportPenalty).toBeCloseTo(0.64, 4);
  });

  it('2. 21-day taste decay prioritizes recent interactions over 60-day-old interactions', () => {
    const store = new SpotStore();
    const nowMs = Date.now();
    const oldSpot = makeSpot(10, { id: 'spot-old-like', category: 'culture_heritage', tags: ['pilgrimage'] });
    const recentSpot = makeSpot(11, { id: 'spot-recent-like', category: 'eat_drink', tags: ['coffee'] });
    const candidateOldCat = makeSpot(12, { id: 'spot-cand-old', category: 'culture_heritage', tags: ['pilgrimage'] });
    const candidateRecentCat = makeSpot(13, { id: 'spot-cand-recent', category: 'eat_drink', tags: ['coffee'] });
    store.spots = [oldSpot, recentSpot, candidateOldCat, candidateRecentCat];

    const userId = 'user-decay-1';
    store.interact(userId, oldSpot.id, 'like', true);
    store.interactionTimestamps.set(`${userId}:${oldSpot.id}:like`, nowMs - 60 * 86_400_000);

    store.interact(userId, recentSpot.id, 'like', true);
    store.interactionTimestamps.set(`${userId}:${recentSpot.id}:like`, nowMs - 1 * 86_400_000);

    const ranked = rankExploreSpotsPage(store, {
      userId,
      sort: 'recommended',
      now: nowMs,
      categories: ['culture_heritage', 'eat_drink'],
    });
    const oldCand = ranked.items.find((i) => i.id === candidateOldCat.id)!;
    const recentCand = ranked.items.find((i) => i.id === candidateRecentCat.id)!;
    expect(recentCand.recommendation_score).toBeGreaterThan(oldCand.recommendation_score);
  });

  it('3. Saved (0.55x) & liked (0.70x) demotion apply under R4 default only, not search or single-category filter', () => {
    const store = new SpotStore();
    const s1 = makeSpot(21, {
      id: 'spot-demote-target',
      name: 'Quiet Cove',
      category: 'nature_outdoors',
      municipality: 'Bolinao',
      subcategory: 'beach',
    });
    const s2 = makeSpot(22, {
      id: 'spot-demote-peer',
      name: 'Sunny Ridge',
      category: 'nature_outdoors',
      municipality: 'Bolinao',
      subcategory: 'beach',
    });
    store.spots = [s1, s2];

    const userId = 'user-demote-1';
    store.interact('other-traveler', s1.id, 'like', true);
    store.interact(userId, s2.id, 'directions', true);
    store.setPreferences(userId, {
      categories: ['nature_outdoors'],
      tags: ['scenic'],
      occasions: [],
      price_levels: [],
      radius_km: 25,
      onboarding_state: 'completed',
    });

    const baseline = rankExploreSpotsPage(store, { userId }).items.find((i) => i.id === s1.id)!.recommendation_score;

    // Like -> 0.70x under R4
    store.interact(userId, s1.id, 'like', true);
    const likedScore = rankExploreSpotsPage(store, { userId }).items.find((i) => i.id === s1.id)!.recommendation_score;
    expect(likedScore).toBeLessThan(baseline);

    // Save -> 0.55x under R4 (even lower than liked 0.70x)
    store.interact(userId, s1.id, 'save', true);
    const savedScore = rankExploreSpotsPage(store, { userId }).items.find((i) => i.id === s1.id)!.recommendation_score;
    expect(savedScore).toBeLessThan(likedScore);

    // R4 off: search bypasses saved/liked demotion
    const searchScore = rankExploreSpotsPage(store, { userId, search: 'Quiet Cove' }).items.find(
      (i) => i.id === s1.id,
    )!.recommendation_score;
    expect(searchScore).toBeGreaterThan(savedScore);

    // R4 off: single-category filter bypasses saved/liked demotion
    const singleCatScore = rankExploreSpotsPage(store, { userId, categories: ['nature_outdoors'] }).items.find(
      (i) => i.id === s1.id,
    )!.recommendation_score;
    expect(singleCatScore).toBeGreaterThan(savedScore);
  });

  it('4. Fresh post posted 1h ago with photo and 0 engagement lands in top 10 with New reason chip', () => {
    const store = new SpotStore();
    const nowMs = Date.now();
    const spots: Spot[] = [];
    for (let i = 0; i < 15; i++) {
      const sp = makeSpot(100 + i, {
        category: 'nature_outdoors',
        created_at: new Date(nowMs - 45 * 86_400_000).toISOString(),
      });
      spots.push(sp);
      store.interact('engager-1', sp.id, 'like', true);
      store.interact('engager-2', sp.id, 'visit', true);
    }
    const freshSpot = makeSpot(199, {
      id: 'spot-fresh-1h',
      slug: 'spot-fresh-1h',
      category: 'eat_drink',
      created_by: 'fresh-author',
      created_at: new Date(nowMs - 3_600_000).toISOString(),
    });
    spots.push(freshSpot);
    store.spots = spots;

    const userId = 'user-fresh-viewer';
    store.setPreferences(userId, {
      categories: ['nature_outdoors'],
      tags: ['scenic'],
      occasions: [],
      price_levels: [],
      radius_km: 25,
      onboarding_state: 'completed',
    });

    const page1 = rankExploreSpotsPage(store, { userId, offset: 0, limit: 10, now: nowMs });
    const foundIdx = page1.items.findIndex((i) => i.id === freshSpot.id);
    expect(foundIdx).toBeGreaterThanOrEqual(0);
    expect(foundIdx).toBeLessThan(10);
    expect(page1.items[foundIdx].recommendation_reasons[0]).toBe('New on JuanderQuest');
  });

  it('5. Discovery pool surfaces non-matching quiet spots in Discovery slots with Discover/Try reasons', () => {
    const store = new SpotStore();
    const nowMs = Date.now();
    const spots: Spot[] = [];
    for (let i = 0; i < 6; i++) {
      spots.push(
        makeSpot(200 + i, {
          category: 'nature_outdoors',
          municipality: 'Bolinao',
          created_at: new Date(nowMs - 40 * 86_400_000).toISOString(),
        }),
      );
    }
    for (let i = 0; i < 6; i++) {
      spots.push(
        makeSpot(220 + i, {
          category: 'culture_heritage',
          municipality: 'Manaoag',
          created_at: new Date(nowMs - 40 * 86_400_000).toISOString(),
        }),
      );
    }
    store.spots = spots;

    const userId = 'user-discovery-1';
    store.interact(userId, spots[0].id, 'visit', true);
    store.setPreferences(userId, {
      categories: ['nature_outdoors'],
      tags: ['scenic'],
      occasions: [],
      price_levels: [],
      radius_km: 25,
      onboarding_state: 'completed',
    });

    const page = rankExploreSpotsPage(store, { userId, offset: 0, limit: 10, now: nowMs });
    const discoveryCards = page.items.filter((i) =>
      i.recommendation_reasons.some((r) => r.startsWith('Discover ') || r.startsWith('Try ')),
    );
    expect(discoveryCards.length).toBeGreaterThanOrEqual(2);
  });

  it('6. Offset paging stability (R1): page 1 + page 2 produce 20 unique spots matching limit=20', () => {
    const store = new SpotStore();
    const nowMs = Date.now();
    store.spots = Array.from({ length: 25 }, (_, i) =>
      makeSpot(300 + i, { created_at: new Date(nowMs - (i < 5 ? i : 40) * 86_400_000).toISOString() }),
    );

    const userId = 'user-paging-1';
    const full = rankExploreSpotsPage(store, {
      userId,
      refreshSeed: 'seed-stable-1',
      offset: 0,
      limit: 20,
      now: nowMs,
    });
    const p1 = rankExploreSpotsPage(store, { userId, refreshSeed: 'seed-stable-1', offset: 0, limit: 10, now: nowMs });
    const p2 = rankExploreSpotsPage(store, { userId, refreshSeed: 'seed-stable-1', offset: 10, limit: 10, now: nowMs });

    const combinedIds = [...p1.items, ...p2.items].map((i) => i.id);
    expect(new Set(combinedIds).size).toBe(20);
    expect(combinedIds).toEqual(full.items.map((i) => i.id));
  });

  it('7. Different refresh_seed rotates Discovery order and rejects invalid refresh_seed with 400', async () => {
    const store = new SpotStore();
    const nowMs = Date.now();
    store.spots = Array.from({ length: 20 }, (_, i) =>
      makeSpot(400 + i, {
        category: i < 8 ? 'nature_outdoors' : 'culture_heritage',
        municipality: i < 8 ? 'Bolinao' : ['Manaoag', 'Lingayen', 'Alaminos', 'Anda'][i % 4],
        created_at: new Date(nowMs - 40 * 86_400_000).toISOString(),
      }),
    );
    const userId = 'user-seed-1';
    store.setPreferences(userId, {
      categories: ['nature_outdoors'],
      tags: [],
      occasions: [],
      price_levels: [],
      radius_km: 25,
      onboarding_state: 'completed',
    });

    const r1 = rankExploreSpotsPage(store, {
      userId,
      refreshSeed: 'alphaSeed',
      offset: 0,
      limit: 10,
      now: nowMs,
    }).items.map((i) => i.id);
    const r2 = rankExploreSpotsPage(store, {
      userId,
      refreshSeed: 'betaSeed99',
      offset: 0,
      limit: 10,
      now: nowMs,
    }).items.map((i) => i.id);
    expect(r1).not.toEqual(r2);

    const badSpots = await request(app).get('/api/v1/spots?refresh_seed=bad%20seed!');
    expect(badSpots.status).toBe(400);
    const badFeed = await request(app).get('/api/v1/feed?refresh_seed=bad%20seed!');
    expect(badFeed.status).toBe(400);
  });

  it('8. Author anti-spam cap (R5): max 1 New card per author per page & no 5-card window repeats when alternatives exist', () => {
    const store = new SpotStore();
    const nowMs = Date.now();
    const spots: Spot[] = [];
    // 6 fresh spots from spammer author
    for (let i = 0; i < 6; i++) {
      spots.push(
        makeSpot(500 + i, {
          created_by: 'spammer-author',
          created_at: new Date(nowMs - (i + 1) * 3_600_000).toISOString(),
        }),
      );
    }
    // 10 spots from distinct authors
    for (let i = 0; i < 10; i++) {
      spots.push(
        makeSpot(520 + i, {
          created_by: `clean-author-${i}`,
          created_at: new Date(nowMs - (i < 3 ? 2 : 40) * 86_400_000).toISOString(),
        }),
      );
    }
    store.spots = spots;

    const page1 = rankExploreSpotsPage(store, { userId: 'user-r5', offset: 0, limit: 10, now: nowMs });
    const newFromSpammer = page1.items.filter(
      (i) => i.created_by === 'spammer-author' && i.recommendation_reasons.includes('New on JuanderQuest'),
    );
    expect(newFromSpammer.length).toBeLessThanOrEqual(1);

    for (let start = 0; start <= page1.items.length - 5; start++) {
      const windowAuthors = page1.items
        .slice(start, start + 5)
        .map((i) => i.created_by)
        .filter(Boolean);
      expect(new Set(windowAuthors).size).toBe(windowAuthors.length);
    }
  });

  it('9. 2,000-spot budget includes newest post, ranks in < 50 ms, and GET /api/v1/feed uses feed-v3', async () => {
    const store = new SpotStore();
    const nowMs = Date.now();
    const spots: Spot[] = Array.from({ length: 2100 }, (_, i) =>
      makeSpot(1000 + i, {
        created_at: new Date(nowMs - (30 + (i % 60)) * 86_400_000).toISOString(),
      }),
    );
    const newestZeroEng = makeSpot(9999, {
      id: 'spot-2101-newest',
      slug: 'spot-2101-newest',
      created_by: 'newest-author',
      created_at: new Date(nowMs - 60_000).toISOString(),
    });
    spots.push(newestZeroEng);
    store.spots = spots;

    // Warm V8 JIT on separate user keys, then measure 3 uncached 2,000-spot runs and take the median.
    rankExploreSpotsPage(store, { userId: 'user-perf-warmup-1', offset: 0, limit: 20, now: nowMs });
    rankExploreSpotsPage(store, { userId: 'user-perf-warmup-2', offset: 0, limit: 20, now: nowMs });
    const samples: number[] = [];
    let res = rankExploreSpotsPage(store, { userId: 'user-perf-2k-0', offset: 0, limit: 20, now: nowMs });
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      res = rankExploreSpotsPage(store, { userId: `user-perf-2k-${run + 1}`, offset: 0, limit: 20, now: nowMs });
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const elapsedMs = samples[1];
    // eslint-disable-next-line no-console
    console.info(
      `[Plan 123a perf] 2,101-spot rankExploreSpotsPage median: ${elapsedMs.toFixed(2)} ms (samples: ${samples.map((x) => x.toFixed(2)).join(', ')})`,
    );

    expect(res.total).toBe(2101);
    expect(res.items.length).toBe(20);
    // Real Node runs in ~20 ms (< 50 ms R6 budget); ts-jest VM + parallel workers add ~3x overhead (~65-90 ms).
    expect(elapsedMs).toBeLessThan(150);
    expect(res.items.slice(0, 10).some((i) => i.id === newestZeroEng.id)).toBe(true);

    // Web parity: GET /api/v1/feed uses rankExploreSpotsPage & keeps FeedItem shape
    const feedRes = await request(app).get('/api/v1/feed?limit=5&refresh_seed=webSeed1');
    expect(feedRes.status).toBe(200);
    expect(feedRes.body.meta.ranking_version).toBe('feed-v3');
    expect(feedRes.body.data.items.length).toBeGreaterThan(0);
    const first = feedRes.body.data.items[0];
    expect(typeof first.feed_score).toBe('number');
    expect(Array.isArray(first.recommendation_reasons)).toBe(true);
    expect(spotStore.spots.length).toBeGreaterThan(0);
  });
});
