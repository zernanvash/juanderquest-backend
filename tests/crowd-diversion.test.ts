import { SpotStore } from '../src/spots/store.js';

describe('crowd diversion recommendations', () => {
  test('reports unknown without activity and deduplicates recent signals', () => {
    const store = new SpotStore();
    const spot = store.spots[0];
    expect(store.crowd(spot).crowd_status).toBe('unknown');
    expect(store.recordActivity('user-1', spot.id, 'view')).toBe(true);
    expect(store.recordActivity('user-1', spot.id, 'view')).toBe(false);
    expect(store.crowd(spot).crowd_status).toBe('quiet');
  });

  test('calibrates estimated busy status by capacity band', () => {
    const store = new SpotStore();
    const spot = store.spots[0];
    spot.crowd_capacity_band = 'low';
    store.recordActivity('user-1', spot.id, 'directions');
    store.recordActivity('user-1', spot.id, 'visit');
    expect(store.crowd(spot).crowd_status).toBe('estimated_busy');
    spot.crowd_capacity_band = 'high';
    expect(store.crowd(spot).crowd_status).toBe('quiet');
  });

  test('returns similar reviewed alternatives and excludes suppressed candidates', () => {
    const store = new SpotStore();
    const source = store.spots.find(spot => spot.slug === 'lingayen-baywalk')!;
    const alternatives = store.alternatives(source);
    expect(alternatives.some(spot => spot.slug === 'pangasinan-provincial-capitol')).toBe(true);
    const candidate = store.spots.find(spot => spot.slug === 'pangasinan-provincial-capitol')!;
    candidate.recommendation_suppressed = true;
    expect(store.alternatives(source).some(spot => spot.id === candidate.id)).toBe(false);
  });

  test('holds community contributions for review', () => {
    const store = new SpotStore();
    const result = store.create({name:'Local Pocket Park',description:'A quiet neighborhood green space.',category:'nature_outdoors',subcategory:'park',tags:['quiet'],municipality:'Dagupan City',address:'Test Street',gps_lat:16.08,gps_lng:120.39,price_level:0,hours:{},amenities:[],image_url:''}, 'user-1');
    expect(result.spot?.status).toBe('needs_review');
    expect(store.list({}).some(spot => spot.id === result.spot?.id)).toBe(false);
  });
});
