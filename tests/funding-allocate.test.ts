import { allocatePoints, feeForReward, targetForCompletions } from '../src/funding/allocate';

describe('funded quest deterministic allocation', () => {
  it('preserves allocation invariants over 500 seeded capacity distributions', () => {
    let seed = 39917;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
    for (let trial=0; trial<500; trial++) {
      const capacities = Array.from({ length: 2 + Math.floor(random()*12) }, (_,i) => ({
        contributionId: `contribution-${i}`, availablePoints: i === 0 ? 0 : 1+Math.floor(random()*10000), createdAt: new Date(1700000000000+i*1000),
      }));
      const totalCapacity = capacities.reduce((sum,row)=>sum+row.availablePoints,0);
      const requested = Math.floor(random()*(totalCapacity+1));
      const allocated = allocatePoints(requested, capacities);
      expect(allocated.reduce((sum,row)=>sum+row.points,0)).toBe(requested);
      expect(allocated.every(row=>row.points>=0 && row.points<=row.availablePoints)).toBe(true);
      expect(allocated[0].points).toBe(0);
      const reordered = new Map(allocatePoints(requested,[...capacities].reverse()).map(row=>[row.contributionId,row.points]));
      expect(allocated.every(row=>row.points===reordered.get(row.contributionId))).toBe(true);
    }
  });
  it('calculates upward-rounded fee and target using whole points', () => {
    expect(feeForReward(50, 500)).toBe(3);
    expect(feeForReward(75, 500)).toBe(4);
    expect(feeForReward(100, 500)).toBe(5);
    expect(targetForCompletions(50, 500, 20)).toBe(1060);
  });

  it('uses largest remainder and deterministic creation-time/id tie breaks', () => {
    const capacities = [
      { contributionId: 'merchant', availablePoints: 636, createdAt: '2026-01-02T00:00:00Z' },
      { contributionId: 'author', availablePoints: 424, createdAt: '2026-01-01T00:00:00Z' },
    ];
    expect(allocatePoints(53, capacities).map((item) => [item.contributionId, item.points]))
      .toEqual([['merchant', 32], ['author', 21]]);
    const normalize = (input: typeof capacities) => allocatePoints(53, input)
      .map((item) => [item.contributionId, item.points]).sort(([a], [b]) => String(a).localeCompare(String(b)));
    expect(normalize(capacities)).toEqual(normalize([...capacities].reverse()));
    expect(allocatePoints(1, [
      { contributionId: 'b', availablePoints: 1, createdAt: '2026-01-01T00:00:00Z' },
      { contributionId: 'a', availablePoints: 1, createdAt: '2026-01-01T00:00:00Z' },
    ]).map((item) => [item.contributionId, item.points])).toEqual([['b', 0], ['a', 1]]);
  });

  it('never returns partial allocations and handles zero-value requests', () => {
    expect(() => allocatePoints(2, [{ contributionId: 'a', availablePoints: 1, createdAt: '2026-01-01' }]))
      .toThrow('INSUFFICIENT_FUNDING_CAPACITY');
    expect(allocatePoints(0, [{ contributionId: 'a', availablePoints: 1, createdAt: '2026-01-01' }])[0].points).toBe(0);
  });

  it('rejects overflow and invalid/duplicate capacities', () => {
    expect(() => targetForCompletions(100, 1000, Number.MAX_SAFE_INTEGER)).toThrow('FUNDING_TARGET_OVERFLOW');
    expect(() => allocatePoints(1, [
      { contributionId: 'a', availablePoints: 1, createdAt: '2026-01-01' },
      { contributionId: 'a', availablePoints: 1, createdAt: '2026-01-02' },
    ])).toThrow('INVALID_FUNDING_CAPACITY');
  });
});
