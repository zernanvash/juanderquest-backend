import { FICTIONAL_SCENARIOS, projectPolicySensitivity, runEconomySimulation } from '../scripts/economy-simulation.js';

describe('fictional economy run', () => {
  it('sweeps fictional policy variables without inventing real visit or cash value', () => {
    const first = projectPolicySensitivity();
    const second = projectPolicySensitivity();
    expect(second).toEqual(first);
    expect(first.cases).toHaveLength(648);
    expect(first.cases.every((row) =>
      row.issuedMinor === row.cosmeticRetiredMinor + row.circulatingMinor &&
      row.submitted + row.abandoned === row.fundedStarts &&
      row.distinctSyntheticVisits + row.repeatedSyntheticVisits === row.approved &&
      row.costPerRealVerifiedVisit === null
    )).toBe(true);
    const lowCapacity = first.cases.find((row) => row.rewardMinor === 100 &&
      row.completionRate === 0.5 && row.abandonmentRate === 0 &&
      row.repeatRate === 0 &&
      row.reviewerHoursPerDay === 0.25 && row.cosmeticDemandRate === 0 &&
      row.assumedAbuseRate === 0);
    expect(lowCapacity?.backlogAfterSevenDays).toBe(65);
    const highCapacity = first.cases.find((row) => row.rewardMinor === 100 &&
      row.completionRate === 0.5 && row.abandonmentRate === 0 &&
      row.repeatRate === 0 &&
      row.reviewerHoursPerDay === 4 && row.cosmeticDemandRate === 0 &&
      row.assumedAbuseRate === 0);
    expect(highCapacity?.backlogAfterSevenDays).toBe(0);
  });
  it('reconciles rewards, abandoned starts, rejections and optional spending', async () => {
    const result = await runEconomySimulation();
    expect(result).toMatchObject({
      fictionalTravelers: 12,
      approved: 6,
      rejected: 2,
      abandoned: 4,
      awards: 6,
      entitlements: 1,
      accountNet: '0',
      travelerOneBalance: '60',
      pool: { allocated: '1200', available: '600', reserved: '0', paid: '600', returned: '0' },
    });
  }, 120_000);

  it.each(FICTIONAL_SCENARIOS.slice(1))(
    'preserves fictional accounting in $name', async (scenario) => {
      const result = await runEconomySimulation(scenario);
      expect(result.scenario).toMatchObject({ name: scenario.name, seed: scenario.seed });
      expect(result.accountNet).toBe('0');
      expect(result.awards).toBe(scenario.approved + (scenario.multiDestination ? 6 : 0));
      expect(result.staffingProjection.submittedProofs).toBe(result.submissions);
      expect(result.abandoned).toBe(
        scenario.fundedStarts - scenario.approved - scenario.rejected
      );
      expect(result.unfundedStartDenied).toBe(Boolean(scenario.probeUnfundedStart));
      if (scenario.name === 'delayed-review-capacity') {
        expect(result.staffingProjection.backlogAfterSevenDays).toBeGreaterThan(0);
        expect(result.staffingProjection.p95DelayDays).toBeGreaterThan(7);
      }
      expect(result.fairnessProjection.sharedNetworkApproved)
        .toBe(Math.min(2, scenario.approved));
      expect(result.visitEvidence.verifiedDistinctVisits).toBe(0);
      if (scenario.name === 'three-destination-benefit') {
        expect(result.destinationBenefit.uniqueRewardedDestinations).toBe(3);
        expect(result.destinationBenefit.topDestinationShare).toBe(0.5);
        expect(result.destinationBenefit.destinations.map((row) => row.municipality).sort())
          .toEqual(['Bolinao', 'Dagupan', 'Lingayen']);
        expect(result.accounting.issuance).toBe('1200');
      }
      expect(result.merchantStockFixture.reservations +
        result.merchantStockFixture.remainingUnits)
        .toBe(result.merchantStockFixture.startingUnits);
      expect(result.merchantStockFixture.merchantCashObligation).toBe(0);
      if (scenario.name === 'merchant-stock-exhaustion') {
        expect(result.merchantStockFixture.deniedForNoStock).toBe(4);
      }
      if (scenario.name === 'merchant-no-stock') {
        expect(result.merchantStockFixture.reservations).toBe(0);
        expect(result.merchantStockFixture.deniedForNoStock).toBe(3);
      }
      if (scenario.name === 'lower-reward-sensitivity') {
        expect(result.accounting.issuance).toBe('300');
      }
      if (scenario.name === 'higher-reward-sensitivity') {
        expect(result.accounting.issuance).toBe('1200');
      }
      if (scenario.name === 'sponsor-cancellation-after-start') {
        expect(result.sponsorCancellation).toMatchObject({
          requested: true, newStartBlocked: true,
          existingApprovedProofsStillPaid: true,
          actualSponsorRefundOrCashTransfer: false,
        });
      }
      if (scenario.name === 'chain-rpc-outage') {
        expect(result.chainProjection).toMatchObject({
          failure: 'rpc-outage', indexedEvents: 0, canonicalEvents: 0,
          simulatedProviderFailureObserved: true,
          offChainTransferRowsUnchanged: true, offChainTravelerBalanceUnchanged: true,
        });
      }
      if (scenario.name === 'chain-reorg-replay') {
        expect(result.chainProjection).toMatchObject({
          failure: 'reorg-replay', indexedEvents: 2, canonicalEvents: 1,
          offChainTransferRowsUnchanged: true, offChainTravelerBalanceUnchanged: true,
        });
      }
      if (process.env.JDQ_REAL_PG_URL) {
        if (scenario.name === 'cloned-quest') {
          expect(result.abuseChecks.activeClonePoolDenied).toBe(true);
          expect(result.abuseChecks.cloneRewardDenied).toBe(true);
        }
        if (scenario.name === 'author-reviewer-collusion') {
          expect(result.abuseChecks.collusiveSelfReviewDenied).toBe(true);
        }
        if (scenario.name === 'spoofed-unbound-proof') {
          expect(result.abuseChecks.unboundProofDenied).toBe(true);
        }
      }
      expect(BigInt(result.pool.allocated)).toBe(
        BigInt(result.pool.available) + BigInt(result.pool.reserved) +
        BigInt(result.pool.paid) + BigInt(result.pool.returned)
      );
    }, 120_000
  );

  it('repeats canonical metrics for the same fictional seed and scenario', async () => {
    const scenario = FICTIONAL_SCENARIOS[1];
    const first = await runEconomySimulation(scenario);
    const second = await runEconomySimulation(scenario);
    expect(second).toEqual(first);
  }, 120_000);
});
