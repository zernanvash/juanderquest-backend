import { describe, it, expect } from '@jest/globals';
import { relicSpot } from '../src/quests/relicSpot.js';
import { calculateHaversineDistance } from '../src/db/index.js';

// Owner 2026-11-07: the relic hides at a random spot inside the creator's area, its own per attempt.
describe('relicSpot', () => {
  const fence = { lat: 16.0433, lng: 120.3333, radius_meters: 50 };

  it('is inside the area, away from the centre and the edge (20-80% of the radius)', () => {
    for (let i = 0; i < 200; i++) {
      const r = relicSpot(`attempt-${i}`, 'task-1', fence);
      const d = calculateHaversineDistance(fence.lat, fence.lng, r.lat, r.lng);
      expect(d).toBeGreaterThanOrEqual(0.2 * 50 - 0.1);
      expect(d).toBeLessThanOrEqual(0.8 * 50 + 0.1);
    }
  });

  it('is the same every time for one attempt and task, and differs between attempts and tasks', () => {
    expect(relicSpot('a1', 't1', fence)).toEqual(relicSpot('a1', 't1', fence));
    expect(relicSpot('a1', 't1', fence)).not.toEqual(relicSpot('a2', 't1', fence));
    expect(relicSpot('a1', 't1', fence)).not.toEqual(relicSpot('a1', 't2', fence));
  });

  it('spreads around the whole area', () => {
    const quadrants = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const r = relicSpot(`q-${i}`, 'k', fence);
      quadrants.add(`${r.lat > fence.lat ? 'N' : 'S'}${r.lng > fence.lng ? 'E' : 'W'}`);
    }
    expect(quadrants.size).toBe(4);
  });
});
