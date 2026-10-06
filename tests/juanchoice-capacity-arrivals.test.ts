import { summarizeArrivals, RawArrivalRecord } from '../scripts/juanchoice-capacity-arrivals';

describe('summarizeArrivals', () => {
  it('returns count 0 and all metrics 0 for empty array', () => {
    const res = summarizeArrivals([]);
    expect(res).toEqual({
      overview: { count: 0, ingressSpanMs: 0, maxIngressIn100ms: 0, maxIngressIn1s: 0, maxSimultaneousInFlight: 0 },
      standings: { count: 0, ingressSpanMs: 0, maxIngressIn100ms: 0, maxIngressIn1s: 0, maxSimultaneousInFlight: 0 },
      '0': { count: 0, ingressSpanMs: 0, maxIngressIn100ms: 0, maxIngressIn1s: 0, maxSimultaneousInFlight: 0 },
      '1': { count: 0, ingressSpanMs: 0, maxIngressIn100ms: 0, maxIngressIn1s: 0, maxSimultaneousInFlight: 0 },
      allRead: { count: 0, ingressSpanMs: 0, maxIngressIn100ms: 0, maxIngressIn1s: 0, maxSimultaneousInFlight: 0 },
      allBallot: { count: 0, ingressSpanMs: 0, maxIngressIn100ms: 0, maxIngressIn1s: 0, maxSimultaneousInFlight: 0 },
    });
  });

  describe('input validation', () => {
    it('rejects non-array input', () => {
      // @ts-expect-error testing invalid input
      expect(() => summarizeArrivals(null)).toThrow(TypeError);
    });

    it('rejects invalid kind', () => {
      const records = [{ kind: 'invalid', ingressMs: 10, finishMs: 20 }] as unknown as RawArrivalRecord[];
      expect(() => summarizeArrivals(records)).toThrow(/Invalid kind/);
    });

    it('rejects negative or non-finite ingressMs', () => {
      expect(() => summarizeArrivals([{ kind: 'overview', ingressMs: -1, finishMs: 10 }])).toThrow(/Invalid ingressMs/);
      expect(() => summarizeArrivals([{ kind: 'overview', ingressMs: Infinity, finishMs: 10 }])).toThrow(/Invalid ingressMs/);
      expect(() => summarizeArrivals([{ kind: 'overview', ingressMs: NaN, finishMs: 10 }])).toThrow(/Invalid ingressMs/);
    });

    it('rejects negative or non-finite finishMs', () => {
      expect(() => summarizeArrivals([{ kind: 'overview', ingressMs: 10, finishMs: -1 }])).toThrow(/Invalid finishMs/);
      expect(() => summarizeArrivals([{ kind: 'overview', ingressMs: 10, finishMs: Infinity }])).toThrow(/Invalid finishMs/);
    });

    it('rejects finishMs < ingressMs', () => {
      expect(() => summarizeArrivals([{ kind: 'overview', ingressMs: 100, finishMs: 90 }])).toThrow(/cannot be less than/);
    });
  });

  describe('sliding window and boundary semantics', () => {
    it('correctly handles separated and burst ingress', () => {
      const records: RawArrivalRecord[] = [
        { kind: 'overview', ingressMs: 1000, finishMs: 1050 },
        { kind: 'overview', ingressMs: 1010, finishMs: 1060 },
        { kind: 'overview', ingressMs: 1020, finishMs: 1070 },
        { kind: 'overview', ingressMs: 3000, finishMs: 3050 },
      ];
      const res = summarizeArrivals(records);
      expect(res.overview.count).toBe(4);
      expect(res.overview.ingressSpanMs).toBe(2000);
      expect(res.overview.maxIngressIn100ms).toBe(3);
      expect(res.overview.maxIngressIn1s).toBe(3);
    });

    it('handles exact 100 ms boundary inclusive tie semantics (difference <= 100)', () => {
      const records: RawArrivalRecord[] = [
        { kind: 'overview', ingressMs: 100, finishMs: 300 },
        { kind: 'overview', ingressMs: 200, finishMs: 300 }, // span is 200 - 100 = 100ms
      ];
      const res = summarizeArrivals(records);
      expect(res.overview.maxIngressIn100ms).toBe(2);

      const recordsBoundaryExceeded: RawArrivalRecord[] = [
        { kind: 'overview', ingressMs: 100, finishMs: 300 },
        { kind: 'overview', ingressMs: 201, finishMs: 300 }, // span is 101ms
      ];
      const resExceeded = summarizeArrivals(recordsBoundaryExceeded);
      expect(resExceeded.overview.maxIngressIn100ms).toBe(1);
    });
  });

  describe('concurrency and half-open request interval semantics', () => {
    it('handles overlapping vs non-overlapping intervals', () => {
      // [100, 200) and [150, 250) overlap between 150 and 200 -> max concurrency 2
      const records: RawArrivalRecord[] = [
        { kind: '0', ingressMs: 100, finishMs: 200 },
        { kind: '0', ingressMs: 150, finishMs: 250 },
      ];
      const res = summarizeArrivals(records);
      expect(res['0'].maxSimultaneousInFlight).toBe(2);
      expect(res.allBallot.maxSimultaneousInFlight).toBe(2);
    });

    it('handles simultaneous finish and ingress under half-open [ingress, finish) interval (no overlap at boundary)', () => {
      // First finishes at 200, second starts at 200. Since [100, 200) finishes before 200 starts, max concurrency is 1.
      const records: RawArrivalRecord[] = [
        { kind: '1', ingressMs: 100, finishMs: 200 },
        { kind: '1', ingressMs: 200, finishMs: 300 },
      ];
      const res = summarizeArrivals(records);
      expect(res['1'].maxSimultaneousInFlight).toBe(1);
    });

    it('handles simultaneous ingress and simultaneous finish', () => {
      const records: RawArrivalRecord[] = [
        { kind: 'standings', ingressMs: 100, finishMs: 200 },
        { kind: 'standings', ingressMs: 100, finishMs: 200 },
        { kind: 'standings', ingressMs: 100, finishMs: 200 },
      ];
      const res = summarizeArrivals(records);
      expect(res.standings.maxSimultaneousInFlight).toBe(3);
      expect(res.standings.maxIngressIn100ms).toBe(3);
    });

    it('handles zero-duration requests without negative concurrency', () => {
      const records: RawArrivalRecord[] = [
        { kind: 'standings', ingressMs: 100, finishMs: 100 },
        { kind: 'standings', ingressMs: 100, finishMs: 100 },
      ];
      const res = summarizeArrivals(records);
      expect(res.standings.count).toBe(2);
      expect(res.standings.maxSimultaneousInFlight).toBe(0);
      expect(res.standings.ingressSpanMs).toBe(0);
    });

    it('does not leak IDs, URLs, tokens, headers or raw timestamps into output', () => {
      const records: RawArrivalRecord[] = [
        { kind: 'overview', ingressMs: 500, finishMs: 600 },
      ];
      const res = summarizeArrivals(records);
      const keys = Object.keys(res.overview);
      expect(keys.sort()).toEqual([
        'count',
        'ingressSpanMs',
        'maxIngressIn100ms',
        'maxIngressIn1s',
        'maxSimultaneousInFlight',
      ].sort());
    });
  });

  describe('group aggregations: allRead and allBallot', () => {
    it('aggregates overview and standings into allRead, and 0 and 1 into allBallot', () => {
      const records: RawArrivalRecord[] = [
        { kind: 'overview', ingressMs: 100, finishMs: 200 },
        { kind: 'standings', ingressMs: 150, finishMs: 250 },
        { kind: '0', ingressMs: 1000, finishMs: 1200 },
        { kind: '1', ingressMs: 1100, finishMs: 1300 },
      ];
      const res = summarizeArrivals(records);
      expect(res.overview.count).toBe(1);
      expect(res.standings.count).toBe(1);
      expect(res.allRead.count).toBe(2);
      expect(res.allRead.maxSimultaneousInFlight).toBe(2);

      expect(res['0'].count).toBe(1);
      expect(res['1'].count).toBe(1);
      expect(res.allBallot.count).toBe(2);
      expect(res.allBallot.maxSimultaneousInFlight).toBe(2);
    });
  });
});
