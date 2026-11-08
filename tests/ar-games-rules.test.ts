import { describe, it, expect } from '@jest/globals';
import { implausibleReason } from '../src/services/arGames.js';
import { arCfgSchema } from '../src/quests/taskValidation.js';

// Plan 77 §4.3: the server only accepts results the AR Lab rules allow.
describe('AR mini-game rules', () => {
  const fence = { lat: 16.3, lng: 119.8, radius_meters: 50 };

  it('old AR tasks stay collect tasks', () => {
    expect(arCfgSchema.parse({ type: 'ar', fence }).game).toBe('collect');
    expect(arCfgSchema.parse({ type: 'ar', fence, game: 'pana' }).game).toBe('pana');
    expect(() => arCfgSchema.parse({ type: 'ar', fence, game: 'chess' })).toThrow();
  });

  it.each([
    ['tumbang_preso', 20_000, 120, true, { knocks: 5 }, null],
    ['tumbang_preso', 5_000, 120, true, { knocks: 5 }, 'too_fast'],
    ['tumbang_preso', 20_000, 400, true, { knocks: 10 }, 'score_cap'],
    ['tumbang_preso', 20_000, 30, true, { knocks: 3 }, 'passed_mismatch'],
    ['tumbang_preso', 20_000, 30, false, {}, 'stats_invalid'],
    ['shooting_hoop', 20_000, 12, true, { baskets: 4 }, null],
    ['shooting_hoop', 20_000, 31, true, { baskets: 10 }, 'score_cap'],
    ['pana', 20_000, 40, true, {}, null],
    ['pana', 20_000, 39, true, {}, 'passed_mismatch'],
    ['pana', 8_000, 60, true, {}, 'too_fast'],
    ['pabitin_palayok', 10_000, 3_000, true, {}, null],
    ['pabitin_palayok', 10_000, 1_000, true, {}, 'too_fast'],
    ['pabitin_palayok', 10_000, 12_000, true, {}, 'score_after_elapsed'],
    ['pabitin_palayok', 10_000, 3_000, false, {}, 'passed_mismatch'],
    ['sipa', 12_000, 10, true, {}, null],
    ['sipa', 12_000, 11, true, {}, 'too_fast'],
    ['sipa', 12_000, 4, false, {}, null],
    ['sipa', 12_000, 4, true, {}, 'passed_mismatch'],
  ] as const)('%s after %d ms, score %d, passed %s', (game, elapsed, score, passed, stats, want) => {
    expect(implausibleReason(game, elapsed, score, passed, stats as Record<string, unknown>)).toBe(want);
  });
});
