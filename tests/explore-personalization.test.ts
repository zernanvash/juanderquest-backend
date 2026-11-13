import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';
import { spotStore, SpotStore } from '../src/spots/store.js';
import {
  buildUserTasteProfile,
  clearExploreRankingCache,
  manilaDayKey,
  rankExploreSpots,
} from '../src/spots/recommender.js';
import { setHomeTown } from '../src/social/homeTown.js';
import { setPool } from '../src/db/pool.js';

describe('Plan 80: ExploreRanker v2 Personalization, Home Town, Privacy & Diversity', () => {
  const userBeachId = 'u8000001-0000-4000-8000-000000000001';
  const userCafeId = 'u8000002-0000-4000-8000-000000000002';
  const userImplicitId = 'u8000003-0000-4000-8000-000000000003';
  const friendPublicId = 'u8000004-0000-4000-8000-000000000004';
  const friendPrivateId = 'u8000005-0000-4000-8000-000000000005';
  const friendTestId = 'u8000006-0000-4000-8000-000000000006';
  const friendNoHandleId = 'u8000007-0000-4000-8000-000000000007';
  const friendNoShareId = 'u8000008-0000-4000-8000-000000000008';

  const tokenBeach = jwt.sign({ id: userBeachId, seed_id: 'seed_beach', role: 'user', typ: 'session' }, env.JWT_SECRET);
  const tokenCafe = jwt.sign({ id: userCafeId, seed_id: 'seed_cafe', role: 'user', typ: 'session' }, env.JWT_SECRET);

  beforeEach(async () => {
    setPool(null);
    clearExploreRankingCache();

    // Ensure test users exist in memory db
    const now = new Date().toISOString();
    const ensureUser = (u: {
      id: string;
      seed_id: string;
      display_name: string;
      handle: string | null;
      is_public: boolean;
      share_activity?: boolean;
      is_test?: boolean;
    }) => {
      const existing = db.users.find((x) => x.id === u.id);
      if (existing) {
        existing.handle = u.handle;
        existing.is_public = u.is_public;
        existing.share_activity = u.share_activity ?? true;
        existing.is_test = Boolean(u.is_test);
      } else {
        db.users.push({
          id: u.id,
          seed_id: u.seed_id,
          display_name: u.display_name,
          email: `${u.seed_id}@example.com`,
          avatar_url: '',
          role: 'user',
          demo_points: 0,
          mjdq_balance: 0,
          jdq_governance_balance: 0,
          scout_reputation: 0,
          is_public: u.is_public,
          share_activity: u.share_activity ?? true,
          handle: u.handle,
          is_test: Boolean(u.is_test),
          created_at: now,
          updated_at: now,
        });
      }
    };

    ensureUser({
      id: userBeachId,
      seed_id: 'seed_beach',
      display_name: 'Beach Lover',
      handle: 'beach_lover',
      is_public: true,
    });
    ensureUser({
      id: userCafeId,
      seed_id: 'seed_cafe',
      display_name: 'Cafe Hopper',
      handle: 'cafe_hopper',
      is_public: true,
    });
    ensureUser({
      id: userImplicitId,
      seed_id: 'seed_implicit',
      display_name: 'Implicit Scout',
      handle: 'implicit_scout',
      is_public: true,
    });
    ensureUser({
      id: friendPublicId,
      seed_id: 'seed_aira',
      display_name: 'Aira Coast',
      handle: 'aira_coast',
      is_public: true,
    });
    ensureUser({
      id: friendPrivateId,
      seed_id: 'seed_priv',
      display_name: 'Private Friend',
      handle: 'secret_handle',
      is_public: false,
    });
    ensureUser({
      id: friendTestId,
      seed_id: 'seed_qa_friend',
      display_name: 'QA Bot',
      handle: 'qa_bot',
      is_public: true,
      is_test: true,
    });
    ensureUser({
      id: friendNoHandleId,
      seed_id: 'seed_nohandle',
      display_name: 'No Handle Friend',
      handle: null,
      is_public: true,
    });
    ensureUser({
      id: friendNoShareId,
      seed_id: 'seed_noshare',
      display_name: 'No Share Friend',
      handle: 'noshare_friend',
      is_public: true,
      share_activity: false,
    });

    spotStore.preferences.delete(userBeachId);
    spotStore.preferences.delete(userCafeId);
    spotStore.preferences.delete(userImplicitId);
    spotStore.interactions.delete(userBeachId);
    spotStore.interactions.delete(userCafeId);
    spotStore.interactions.delete(userImplicitId);
    spotStore.interactions.delete(friendPublicId);
    spotStore.interactions.delete(friendPrivateId);
    spotStore.interactions.delete(friendTestId);
    spotStore.interactions.delete(friendNoHandleId);
    spotStore.interactions.delete(friendNoShareId);

    await setHomeTown(userBeachId, null);
    await setHomeTown(userCafeId, null);
    await setHomeTown(userImplicitId, null);
  });

  it('1. Two-User Personalization Proof: User A (beaches/Bolinao) and User B (cafes/Dagupan) get distinct top-5 rankings & tailored reasons', async () => {
    // User A: prefers nature_outdoors / beach and home town Bolinao
    spotStore.setPreferences(userBeachId, {
      categories: ['nature_outdoors'],
      tags: ['beach', 'sunset'],
      occasions: ['friends'],
      price_levels: [1, 2],
      radius_km: 25,
      onboarding_state: 'completed',
    });
    await setHomeTown(userBeachId, 'Bolinao');

    // User B: prefers eat_drink / coffee and home town Dagupan City
    spotStore.setPreferences(userCafeId, {
      categories: ['eat_drink'],
      tags: ['coffee', 'seafood', 'local_food'],
      occasions: ['work_friendly'],
      price_levels: [1, 2],
      radius_km: 25,
      onboarding_state: 'completed',
    });
    await setHomeTown(userCafeId, 'Dagupan City');

    const [resA, resB] = await Promise.all([
      request(app).get('/api/v1/spots').set('Authorization', `Bearer ${tokenBeach}`),
      request(app).get('/api/v1/spots').set('Authorization', `Bearer ${tokenCafe}`),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const top5A = resA.body.data.slice(0, 5).map((s: any) => s.id);
    const top5B = resB.body.data.slice(0, 5).map((s: any) => s.id);

    expect(top5A).not.toEqual(top5B);
    expect(resA.body.data[0].category).toBe('nature_outdoors');
    expect(resB.body.data[0].category).toBe('eat_drink');

    expect(
      resA.body.data[0].recommendation_reasons.some((r: string) =>
        r.includes('Matches your Nature & Outdoors interests'),
      ),
    ).toBe(true);
    expect(
      resB.body.data[0].recommendation_reasons.some((r: string) => r.includes('Matches your Eat & Drink interests')),
    ).toBe(true);
  });

  it('2. Implicit Behavior Override: user who skipped onboarding but liked/saved heritage spots gets culture_heritage boosted and "Because you liked..." reason', () => {
    spotStore.setPreferences(userImplicitId, {
      categories: [],
      tags: [],
      occasions: [],
      price_levels: [],
      radius_km: 25,
      onboarding_state: 'skipped',
    });

    // User liked Minor Basilica of Manaoag (culture_heritage, tags: heritage, family, pilgrimage, architecture)
    spotStore.interact(userImplicitId, 'spot-manaoag', 'like', true);
    spotStore.interact(userImplicitId, 'spot-manaoag', 'visit', true);

    const ranked = spotStore.list({ userId: userImplicitId });
    const capitol = ranked.find((s) => s.id === 'spot-capitol')!;
    expect(capitol).toBeDefined();
    expect(capitol.recommendation_reasons).toContain('Because you liked Minor Basilica of Our Lady of Manaoag');
    expect(capitol.recommendation_reasons).toContain('Matches your Culture & Heritage interests');
    // Unvisited heritage spot (spot-capitol) ranks above already-visited spot-manaoag
    const capitolIdx = ranked.findIndex((s) => s.id === 'spot-capitol');
    const manaoagIdx = ranked.findIndex((s) => s.id === 'spot-manaoag');
    expect(capitolIdx).toBeLessThan(manaoagIdx);
  });

  it('3. Visited Novelty Decay & Saved Wishlist Boost: visited spots decay by 0.30x while saved unvisited spots boost by 1.15x', () => {
    spotStore.setPreferences(userBeachId, {
      categories: ['nature_outdoors'],
      tags: ['beach', 'scenic'],
      occasions: [],
      price_levels: [],
      radius_km: 25,
      onboarding_state: 'completed',
    });

    const beforeVisit = spotStore.list({ userId: userBeachId });
    const patarBefore = beforeVisit.find((s) => s.id === 'spot-patar')!;

    // Save Patar (unvisited) -> gets 1.15x boost and "Saved in your wishlist"
    spotStore.interact(userBeachId, 'spot-patar', 'save', true);
    const afterSave = spotStore.list({ userId: userBeachId });
    const patarSaved = afterSave.find((s) => s.id === 'spot-patar')!;
    expect(patarSaved.recommendation_score).toBeGreaterThan(patarBefore.recommendation_score);
    expect(patarSaved.recommendation_reasons[0]).toBe('Saved in your wishlist');

    // Now visit Patar -> gets 0.30x novelty decay so unvisited nature spots surface above it
    spotStore.interact(userBeachId, 'spot-patar', 'visit', true);
    const afterVisit = spotStore.list({ userId: userBeachId });
    const patarVisited = afterVisit.find((s) => s.id === 'spot-patar')!;
    expect(patarVisited.recommendation_score).toBeLessThan(patarBefore.recommendation_score * 0.5);

    // Explicit search (?q=Patar) disables novelty penalty so user can always find a visited spot
    const searched = spotStore.list({ userId: userBeachId, search: 'Patar' });
    expect(searched[0].id).toBe('spot-patar');
    expect(searched[0].recommendation_score).toBeGreaterThan(patarVisited.recommendation_score);
  });

  it('4. Friend Signals Privacy & Isolation: only followed public non-test profiles with handles appear as @handle (never IDs, private, unfollowed, or test users)', () => {
    // Follow public friend, private friend, test friend, and no-handle friend
    db.follows = db.follows.filter((f) => f.follower_id !== userBeachId);
    const now = new Date().toISOString();
    db.follows.push(
      { follower_id: userBeachId, following_id: friendPublicId, created_at: now },
      { follower_id: userBeachId, following_id: friendPrivateId, created_at: now },
      { follower_id: userBeachId, following_id: friendTestId, created_at: now },
      { follower_id: userBeachId, following_id: friendNoHandleId, created_at: now },
    );

    // Public friend visits Patar
    spotStore.interact(friendPublicId, 'spot-patar', 'visit', true);
    // Private friend visits Hundred Islands
    spotStore.interact(friendPrivateId, 'spot-hundred-islands', 'visit', true);
    // Test friend visits Bolinao Falls
    spotStore.interact(friendTestId, 'spot-bolinao-falls', 'visit', true);
    // No-handle friend visits Lingayen Baywalk
    spotStore.interact(friendNoHandleId, 'spot-lingayen', 'visit', true);
    // Unfollowed public user (userCafeId) visits Third Wave Cafe
    spotStore.interact(userCafeId, 'spot-cafe', 'visit', true);

    const taste = buildUserTasteProfile(spotStore, userBeachId);
    expect(taste.friendHandlesBySpotId.get('spot-patar')).toEqual(['@aira_coast']);
    expect(taste.friendHandlesBySpotId.has('spot-hundred-islands')).toBe(false);
    expect(taste.friendHandlesBySpotId.has('spot-bolinao-falls')).toBe(false);
    expect(taste.friendHandlesBySpotId.has('spot-lingayen')).toBe(false);
    expect(taste.friendHandlesBySpotId.has('spot-cafe')).toBe(false);

    const ranked = spotStore.list({ userId: userBeachId });
    const patar = ranked.find((s) => s.id === 'spot-patar')!;
    expect(patar.recommendation_reasons).toContain('Visited by @aira_coast');

    // Verify no reason anywhere contains a raw user ID or private/test handle
    for (const item of ranked) {
      for (const reason of item.recommendation_reasons) {
        expect(reason).not.toContain(friendPublicId);
        expect(reason).not.toContain(friendPrivateId);
        expect(reason).not.toContain('secret_handle');
        expect(reason).not.toContain('qa_bot');
        expect(reason).not.toContain(friendNoHandleId);
      }
    }
  });

  it('a public friend with share_activity=false gives no friend reason', () => {
    db.follows = db.follows.filter((f) => f.follower_id !== userBeachId);
    const now = new Date().toISOString();
    db.follows.push({
      follower_id: userBeachId,
      following_id: friendNoShareId,
      created_at: now,
    });
    spotStore.interact(friendNoShareId, 'spot-patar', 'visit', true);

    const taste = buildUserTasteProfile(spotStore, userBeachId);
    expect(taste.friendHandlesBySpotId.has('spot-patar')).toBe(false);

    const ranked = spotStore.list({ userId: userBeachId });
    const patar = ranked.find((s) => s.id === 'spot-patar')!;
    expect(patar.recommendation_reasons).not.toContain('Visited by @noshare_friend');
  });

  it('5. Tier 3 Home Town & Fallback: uses users.home_municipality when set, and falls back to top-affinity town when NULL', () => {
    // Case A: homeTown = 'Dagupan City'
    const withHomeTown = spotStore.list({ userId: userImplicitId, homeTown: 'Dagupan City' });
    const dagupanScoreWithHome = withHomeTown.find((s) => s.id === 'spot-bangus')!.recommendation_score;
    const bolinaoScoreWithHome = withHomeTown.find((s) => s.id === 'spot-patar')!.recommendation_score;

    // Case B: homeTown = null, but user has visited/saved in Bolinao (top-affinity town = Bolinao)
    spotStore.interact(userImplicitId, 'spot-bolinao-falls', 'save', true);
    const withAffinityFallback = spotStore.list({ userId: userImplicitId, homeTown: null });
    const bolinaoScoreFallback = withAffinityFallback.find((s) => s.id === 'spot-patar')!.recommendation_score;

    expect(dagupanScoreWithHome).toBeGreaterThan(0.35);
    expect(bolinaoScoreFallback).toBeGreaterThan(bolinaoScoreWithHome);
  });

  it('6. MMR Diversity Gate & 60s Cache Slicing: never returns 3 consecutive items from the same municipality and slices cached pages cleanly', () => {
    const customStore = new SpotStore();
    const now = new Date().toISOString();
    customStore.spots = [
      ...Array.from({ length: 8 }, (_, idx) => ({
        id: `bolinao-beach-${idx + 1}`,
        slug: `bolinao-beach-${idx + 1}`,
        name: `Bolinao Beach ${idx + 1}`,
        description: 'Scenic coastal beach in Bolinao.',
        category: 'nature_outdoors' as const,
        subcategory: 'beach',
        tags: ['beach', 'scenic'],
        municipality: 'Bolinao',
        address: 'Patar, Bolinao',
        gps_lat: 16.32 + idx * 0.001,
        gps_lng: 119.78 + idx * 0.001,
        price_level: 1,
        hours: { daily: '06:00-18:00' },
        amenities: ['parking'],
        image_url: '',
        source_type: 'lgu' as const,
        source_name: 'Bolinao LGU',
        trust_level: 'lgu_verified' as const,
        status: 'published' as const,
        created_at: now,
        updated_at: now,
      })),
      ...Array.from({ length: 4 }, (_, idx) => ({
        id: `dagupan-food-${idx + 1}`,
        slug: `dagupan-food-${idx + 1}`,
        name: `Dagupan Food Stop ${idx + 1}`,
        description: 'Fresh seafood and local dining in Dagupan.',
        category: 'eat_drink' as const,
        subcategory: 'restaurant',
        tags: ['seafood', 'local_food', 'hidden_gem'],
        municipality: 'Dagupan City',
        address: 'Downtown Dagupan',
        gps_lat: 16.04 + idx * 0.001,
        gps_lng: 120.33 + idx * 0.001,
        price_level: 1,
        hours: { daily: '08:00-20:00' },
        amenities: ['parking'],
        image_url: '',
        source_type: 'editorial' as const,
        source_name: 'Curators',
        trust_level: 'editorial' as const,
        status: 'published' as const,
        created_at: now,
        updated_at: now,
      })),
      ...Array.from({ length: 4 }, (_, idx) => ({
        id: `alaminos-island-${idx + 1}`,
        slug: `alaminos-island-${idx + 1}`,
        name: `Alaminos Island ${idx + 1}`,
        description: 'Island hopping and heritage in Alaminos.',
        category: 'culture_heritage' as const,
        subcategory: 'heritage_site',
        tags: ['heritage', 'hidden_gem'],
        municipality: 'Alaminos City',
        address: 'Lucap, Alaminos',
        gps_lat: 16.2 + idx * 0.001,
        gps_lng: 119.97 + idx * 0.001,
        price_level: 1,
        hours: { daily: '06:00-17:00' },
        amenities: ['parking'],
        image_url: '',
        source_type: 'lgu' as const,
        source_name: 'Alaminos LGU',
        trust_level: 'lgu_verified' as const,
        status: 'published' as const,
        created_at: now,
        updated_at: now,
      })),
    ];

    const rankedTop10 = rankExploreSpots(customStore, { userId: userBeachId, limit: 10, offset: 0 });
    expect(rankedTop10.length).toBe(10);

    // Verify no 3 consecutive items in top 8 share the same municipality while alternatives exist
    for (let i = 2; i < 8; i++) {
      const sameThreeMuni =
        rankedTop10[i].municipality === rankedTop10[i - 1].municipality &&
        rankedTop10[i - 1].municipality === rankedTop10[i - 2].municipality;
      expect(sameThreeMuni).toBe(false);
    }

    // Verify pagination slicing from the 60s cache has zero overlap
    const page1 = rankExploreSpots(customStore, { userId: userBeachId, limit: 4, offset: 0 });
    const page2 = rankExploreSpots(customStore, { userId: userBeachId, limit: 4, offset: 4 });
    expect(page1.map((s) => s.id)).toEqual(rankedTop10.slice(0, 4).map((s) => s.id));
    expect(page2.map((s) => s.id)).toEqual(rankedTop10.slice(4, 8).map((s) => s.id));

    // Verify Manila day key uses UTC+8 (2026-11-07T20:00:00Z is 2026-11-08 04:00 Manila)
    const utcLateNight = Date.parse('2026-11-07T20:00:00.000Z');
    expect(manilaDayKey(utcLateNight)).toBe('2026-11-08');
  });

  it('7. Community Merit & 14-Day Exhaustion Duration: recent likes boost spot reach with Popular chip, then exhaust after 14 days', () => {
    const nowMs = Date.parse('2026-11-08T10:00:00.000Z');
    clearExploreRankingCache();
    spotStore.interactions.clear();
    spotStore.interactionTimestamps.clear();

    // Baseline score for spot-cafe before community likes
    const baselineList = rankExploreSpots(spotStore, { userId: userBeachId, now: nowMs });
    const baselineCafe = baselineList.find((s) => s.id === 'spot-cafe')!;

    // Two public non-test explorers like spot-cafe recently (1 day ago)
    const oneDayAgoMs = nowMs - 1 * 86_400_000;
    spotStore.interact(friendPublicId, 'spot-cafe', 'like', true, oneDayAgoMs);
    spotStore.interact(userImplicitId, 'spot-cafe', 'like', true, oneDayAgoMs);

    clearExploreRankingCache();
    const activeMeritList = rankExploreSpots(spotStore, { userId: userBeachId, now: nowMs });
    const activeCafe = activeMeritList.find((s) => s.id === 'spot-cafe')!;
    expect(activeCafe.recommendation_score).toBeGreaterThan(baselineCafe.recommendation_score);
    expect(activeCafe.recommendation_reasons).toContain('Popular · 2 likes');

    // Fast-forward 15 days (> 14-day exhaustion duration): popularity boost and chip are exhausted
    const afterExhaustionMs = nowMs + 15 * 86_400_000;
    clearExploreRankingCache();
    const exhaustedList = rankExploreSpots(spotStore, { userId: userBeachId, now: afterExhaustionMs });
    const exhaustedCafe = exhaustedList.find((s) => s.id === 'spot-cafe')!;
    expect(exhaustedCafe.recommendation_reasons).not.toContain('Popular · 2 likes');
    expect(exhaustedCafe.recommendation_score).toBeLessThan(activeCafe.recommendation_score);
  });
});
