export interface FundingCapacity {
  contributionId: string;
  availablePoints: number;
  createdAt: string | Date;
}

export interface FundingAllocation extends FundingCapacity {
  points: number;
}

/** Fee charged only for a completed reward; whole points round up. */
export function feeForReward(rewardPoints: number, feeBps: number): number {
  if (!Number.isSafeInteger(rewardPoints) || rewardPoints < 0 || !Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new Error('INVALID_FUNDING_FEE_INPUT');
  }
  const numerator = BigInt(rewardPoints) * BigInt(feeBps);
  return Number((numerator + 9_999n) / 10_000n);
}

export function targetForCompletions(rewardPoints: number, feeBps: number, completions: number): number {
  if (!Number.isSafeInteger(completions) || completions < 1) throw new Error('INVALID_COMPLETION_TARGET');
  const totalPerCompletion = BigInt(rewardPoints) + BigInt(feeForReward(rewardPoints, feeBps));
  const target = totalPerCompletion * BigInt(completions);
  if (target > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('FUNDING_TARGET_OVERFLOW');
  return Number(target);
}

/**
 * Largest-remainder split with deterministic tie-breaking. Capacity must cover
 * the full requested amount; it never silently returns a partial hold.
 */
export function allocatePoints(totalPoints: number, capacities: FundingCapacity[]): FundingAllocation[] {
  if (!Number.isSafeInteger(totalPoints) || totalPoints < 0) throw new Error('INVALID_ALLOCATION_TOTAL');
  if (!capacities.length && totalPoints > 0) throw new Error('INSUFFICIENT_FUNDING_CAPACITY');

  const ids = new Set<string>();
  let totalCapacity = 0n;
  for (const item of capacities) {
    const createdAt = new Date(item.createdAt).getTime();
    if (!item.contributionId || ids.has(item.contributionId) || !Number.isSafeInteger(item.availablePoints) || item.availablePoints < 0) {
      throw new Error('INVALID_FUNDING_CAPACITY');
    }
    if (!Number.isFinite(createdAt)) throw new Error('INVALID_FUNDING_CAPACITY');
    ids.add(item.contributionId);
    totalCapacity += BigInt(item.availablePoints);
  }
  if (totalPoints === 0) return capacities.map((item) => ({ ...item, points: 0 }));
  const requested = BigInt(totalPoints);
  if (totalCapacity < requested) throw new Error('INSUFFICIENT_FUNDING_CAPACITY');

  const rows = capacities.map((item) => {
    const product = requested * BigInt(item.availablePoints);
    return {
      ...item,
      points: Number(product / totalCapacity),
      remainder: product % totalCapacity,
      sortTime: new Date(item.createdAt).getTime(),
    };
  });
  let undistributed = totalPoints - rows.reduce((sum, row) => sum + row.points, 0);
  const remainderOrder = [...rows].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    if (a.sortTime !== b.sortTime) return a.sortTime - b.sortTime;
    return a.contributionId.localeCompare(b.contributionId);
  });
  for (const row of remainderOrder) {
    if (undistributed === 0) break;
    if (row.points < row.availablePoints) {
      row.points++;
      undistributed--;
    }
  }
  if (undistributed !== 0 || rows.reduce((sum, row) => sum + row.points, 0) !== totalPoints ||
      rows.some((row) => row.points > row.availablePoints)) {
    throw new Error('FUNDING_ALLOCATION_INVARIANT_FAILED');
  }
  return rows.map(({ remainder: _remainder, sortTime: _sortTime, ...row }) => row);
}
