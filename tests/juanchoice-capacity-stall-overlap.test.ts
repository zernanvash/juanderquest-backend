import { overlapDuration, retainLongestIntervals, stallOverlapReport, stallTimelineReport, validInterval } from '../scripts/juanchoice-capacity-stall-overlap.js';

describe('JuanChoice capacity stall overlap diagnostics', () => {
  it('calculates positive overlap and excludes touching or disjoint intervals', () => {
    expect(overlapDuration({ start: 10, end: 30 }, { start: 20, end: 50 })).toBe(10);
    expect(overlapDuration({ start: 10, end: 20 }, { start: 20, end: 50 })).toBe(0);
    expect(overlapDuration({ start: 10, end: 20 }, { start: 30, end: 50 })).toBe(0);
  });

  it('rejects invalid monotonic intervals', () => {
    expect(validInterval({ start: Number.NaN, end: 3 })).toBe(false);
    expect(validInterval({ start: 8, end: 7 })).toBe(false);
    expect(overlapDuration({ start: Infinity, end: Infinity }, { start: 1, end: 2 })).toBe(0);
  });

  it('retains only the longest bounded intervals', () => {
    const rows = [
      { start: 0, end: 10 }, { start: 20, end: 60 }, { start: 80, end: 100 },
    ].reduce((top, row) => retainLongestIntervals(top, row, 2), [] as Array<{ start: number; end: number }>);
    expect(rows).toEqual([{ start: 20, end: 60 }, { start: 80, end: 100 }]);
    expect(retainLongestIntervals(rows, { start: 9, end: 8 }, 2)).toEqual(rows);
  });

  it('reports only correlation, with each slow batch counted at most once', () => {
    const report = stallOverlapReport(
      [{ start: 20, end: 80 }, { start: 60, end: 100 }],
      [{ start: 0, end: 90 }, { start: 120, end: 150 }]
    );
    expect(report).toEqual({
      measurement_scope: 'same_process_request_window', interpretation: 'correlation_only',
      gap_count: 2, max_gap_duration_ms: 60, slowest_wallet_batch_duration_ms: 90,
      max_overlap_duration_ms: 60, slow_wallet_batches_intersecting_gap_count: 1,
    });
  });

  it('emits at most three identity-free monotonic positions', () => {
    const intervals = Array.from({ length: 5 }, (_, index) => ({ start: index + 0.4, end: index + 1.6 }));
    expect(stallTimelineReport(intervals, intervals)).toEqual({
      clock: 'performance_now_ms',
      gaps: [{ start: 0, end: 2 }, { start: 1, end: 3 }, { start: 2, end: 4 }],
      wallet_batches: [{ start: 0, end: 2 }, { start: 1, end: 3 }, { start: 2, end: 4 }],
    });
    expect(() => stallTimelineReport(intervals, intervals, 4)).toThrow('Invalid stall timeline limit');
  });
});
