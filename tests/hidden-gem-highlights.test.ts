import request from 'supertest';
import { app } from '../src/app.js';
import { SpotStore } from '../src/spots/store.js';
import { hiddenGemHighlights } from '../src/spots/highlights.js';

const now = Date.parse('2026-10-11T12:00:00Z');
function fixture() {
  const store = new SpotStore();
  const template = store.spots[0];
  store.spots = Array.from({ length: 8 }, (_, i) => ({ ...template, id: `gem-${i}`, slug: `gem-${i}`, tags: [],
    trust_level: 'editorial' as const, status: 'published' as const, is_test: false,
    category: i === 0 ? 'culture_heritage' as const : 'nature_outdoors' as const }));
  return store;
}
describe('curated hidden gems', () => {
  test('bounds stable daily picks and never invents quiet status', () => {
    const store = fixture();
    const result = hiddenGemHighlights(store, undefined, now);
    expect(result).toHaveLength(3);
    expect(result).toEqual(hiddenGemHighlights(store, undefined, now));
    expect(result.every(s => s.crowd_status === 'unknown')).toBe(true);
    expect(result[0]).not.toHaveProperty('score');
  });
  test('excludes uncurated, unpublished, suppressed, synthetic and busy places', () => {
    const store = fixture();
    store.spots[0].slug = 'hundred-islands-national-park';
    store.spots[1].trust_level = 'community';
    store.spots[2].status = 'needs_review';
    store.spots[3].recommendation_suppressed = true;
    store.spots[4].is_test = true;
    jest.spyOn(store, 'crowd').mockImplementation(s => ({ crowd_status: s.id === 'gem-5' ? 'estimated_busy' : 'unknown',
      crowd_confidence: 'none', pressure_score: 0, crowd_updated_at: null }));
    expect(hiddenGemHighlights(store, undefined, now).map(s => s.id).sort()).toEqual(['gem-6', 'gem-7']);
  });
  test('explicit preferences personalize ranking without leaking across users', () => {
    const store = fixture();
    store.setPreferences('one', { ...store.getPreferences('one'), categories: ['culture_heritage'] });
    expect(hiddenGemHighlights(store, 'one', now)[0]).toMatchObject({ id: 'gem-0', reason: 'Matches your travel interests' });
    expect(hiddenGemHighlights(store, 'two', now).every(s => s.reason === 'Discover somewhere different')).toBe(true);
  });
  test('saved and liked categories personalize, synthetic history does not', () => {
    const store = fixture();
    store.interact('one', 'gem-0', 'save');
    expect(hiddenGemHighlights(store, 'one', now)[0]).toMatchObject({ id: 'gem-0', reason: 'Inspired by places you saved or liked' });
    store.spots[0].is_test = true;
    expect(hiddenGemHighlights(store, 'one', now).every(s => s.reason === 'Discover somewhere different')).toBe(true);
  });
  test('daily rotation changes exposure over multiple days', () => {
    const store = fixture();
    const days = new Set(Array.from({ length: 7 }, (_, i) => JSON.stringify(hiddenGemHighlights(store, undefined, now + i * 86400000))));
    expect(days.size).toBeGreaterThan(1);
  });
  test('lower activity gets exposure without requiring a tag', () => {
    const store = fixture();
    jest.spyOn(store, 'trend').mockImplementation(id => id === 'gem-0' ? 0 : 50);
    expect(hiddenGemHighlights(store, undefined, now)[0].id).toBe('gem-0');
    expect(store.spots[0].tags).toEqual([]);
  });
  test('route precedes slug handler and does not publicly cache personalized responses', async () => {
    const res = await request(app).get('/api/v1/spots/highlights');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body.meta.algorithm).toBe('curated_hidden_gems_v1');
    expect(res.body.data.length).toBeLessThanOrEqual(3);
  });
});
