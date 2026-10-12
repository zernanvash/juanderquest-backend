// Isolated fictional economy rehearsal. JDQ_REAL_PG_URL, when supplied, is
// accepted by createTestDb only for loopback /jdq_reliability_test; each run
// gets a disposable schema. Otherwise pg-mem is used for a quick local check.
import { createTestDb } from '../src/db/testHarness.js';
import { EconomyService } from '../src/economy/service.js';
import { reconcileEconomy } from '../src/economy/reconcile.js';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { MIGRATIONS } from '../src/db/migrations.js';

process.env.NODE_ENV = 'test';

export interface EconomySimulationScenario {
  version: 'economy-sim-v2';
  name: string;
  seed: number;
  registeredTravelers: number;
  fundedStarts: number;
  approved: number;
  rejected: number;
  rewardMinor: number;
  allocationMinor: number;
  cosmeticDemand: boolean;
  probeUnfundedStart?: boolean;
  arrivalDays?: number;
  reviewerHoursPerDay?: number;
  merchantStock?: number;
  merchantRequests?: number;
  sponsorCancellation?: boolean;
  chainFailure?: 'rpc-outage' | 'reorg-replay';
  multiDestination?: boolean;
}

export const BASELINE_SCENARIO: EconomySimulationScenario = {
  version: 'economy-sim-v2', name: 'baseline', seed: 10109,
  registeredTravelers: 12, fundedStarts: 12, approved: 6, rejected: 2,
  rewardMinor: 100, allocationMinor: 1200, cosmeticDemand: true,
};

// These are fictional stress inputs, not launch prices or demand forecasts.
export const FICTIONAL_SCENARIOS: readonly EconomySimulationScenario[] = [
  BASELINE_SCENARIO,
  { ...BASELINE_SCENARIO, name: 'zero-cosmetic-demand', seed: 10110, cosmeticDemand: false },
  { ...BASELINE_SCENARIO, name: 'overfunded-allowance', seed: 10111, allocationMinor: 2400 },
  { ...BASELINE_SCENARIO, name: 'underfunded-allowance', seed: 10112,
    fundedStarts: 6, approved: 4, rejected: 1, allocationMinor: 600, probeUnfundedStart: true },
  { ...BASELINE_SCENARIO, name: 'mass-abandoned-starts', seed: 10113,
    approved: 2, rejected: 0 },
  { ...BASELINE_SCENARIO, name: 'tenfold-account-creation', seed: 10114,
    registeredTravelers: 120 },
  { ...BASELINE_SCENARIO, name: 'high-growth', seed: 10115,
    registeredTravelers: 60, fundedStarts: 60, approved: 40, rejected: 10,
    allocationMinor: 6000, arrivalDays: 1, reviewerHoursPerDay: 1 },
  { ...BASELINE_SCENARIO, name: 'cloned-quest', seed: 10116 },
  { ...BASELINE_SCENARIO, name: 'author-reviewer-collusion', seed: 10117 },
  { ...BASELINE_SCENARIO, name: 'spoofed-unbound-proof', seed: 10118 },
  { ...BASELINE_SCENARIO, name: 'delayed-review-capacity', seed: 10119,
    registeredTravelers: 60, fundedStarts: 60, approved: 40, rejected: 10,
    allocationMinor: 6000, arrivalDays: 1, reviewerHoursPerDay: 0.25 },
  { ...BASELINE_SCENARIO, name: 'merchant-stock-exhaustion', seed: 10120,
    merchantStock: 2, merchantRequests: 6 },
  { ...BASELINE_SCENARIO, name: 'lower-reward-sensitivity', seed: 10121,
    rewardMinor: 50, allocationMinor: 600 },
  { ...BASELINE_SCENARIO, name: 'higher-reward-sensitivity', seed: 10122,
    rewardMinor: 200, allocationMinor: 2400 },
  { ...BASELINE_SCENARIO, name: 'sponsor-cancellation-after-start', seed: 10123,
    registeredTravelers: 13, sponsorCancellation: true },
  { ...BASELINE_SCENARIO, name: 'merchant-no-stock', seed: 10124,
    merchantStock: 0, merchantRequests: 3 },
  { ...BASELINE_SCENARIO, name: 'chain-rpc-outage', seed: 10125,
    chainFailure: 'rpc-outage' },
  { ...BASELINE_SCENARIO, name: 'chain-reorg-replay', seed: 10126,
    chainFailure: 'reorg-replay' },
  { ...BASELINE_SCENARIO, name: 'three-destination-benefit', seed: 10127,
    registeredTravelers: 18, multiDestination: true },
];

export function sourceProvenance() {
  const sourceRepo = join(__dirname, '..');
  const builtRepo = join(__dirname, '..', '..');
  const repo = existsSync(join(sourceRepo, 'migrations')) ? sourceRepo : builtRepo;
  const migrationDigest = createHash('sha256');
  for (const file of MIGRATIONS) {
    migrationDigest.update(file).update('\0');
    migrationDigest.update(createHash('sha256')
      .update(readFileSync(join(repo, 'migrations', file))).digest('hex')).update('\n');
  }
  const economySourceDigest = createHash('sha256');
  for (const file of [
    'scripts/economy-simulation.ts', 'src/economy/service.ts',
    'src/economy/reconcile.ts', 'src/db/migrations.ts',
    'src/services/submissions.ts',
  ]) {
    economySourceDigest.update(file).update('\0');
    economySourceDigest.update(createHash('sha256')
      .update(readFileSync(join(repo, file))).digest('hex')).update('\n');
  }
  return {
    backendCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    backendDirty: execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim().length > 0,
    migrationCount: MIGRATIONS.length,
    migrationDigestSha256: migrationDigest.digest('hex'),
    economySourceDigestSha256: economySourceDigest.digest('hex'),
  };
}

function nextSeeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function projectReviewerQueue(scenario: EconomySimulationScenario) {
  const days = 7;
  const submittedProofs = scenario.approved + scenario.rejected +
    (scenario.multiDestination ? 6 : 0);
  const arrivalDays = scenario.arrivalDays ?? days;
  const reviewerHoursPerDay = scenario.reviewerHoursPerDay ?? 1;
  const minutesPerProof = 3;
  if (!Number.isInteger(arrivalDays) || arrivalDays < 1 || arrivalDays > days ||
      !Number.isFinite(reviewerHoursPerDay) || reviewerHoursPerDay <= 0 ||
      reviewerHoursPerDay > 8) throw new Error('INVALID_REVIEW_CAPACITY_MODEL');
  const dailyCapacity = Math.floor(reviewerHoursPerDay * 60 / minutesPerProof);
  const chooseArrival = nextSeeded(scenario.seed ^ 0x7a51f03d);
  const arrival = Array.from({ length: days }, () => 0);
  for (let i = 0; i < submittedProofs; i++) {
    arrival[Math.floor(chooseArrival() * arrivalDays)]++;
  }
  const queue: number[] = [];
  const delays: number[] = [];
  let peakBacklog = 0;
  let backlogAfterSevenDays = 0;
  for (let day = 0; day < 365 && delays.length < submittedProofs; day++) {
    for (let i = 0; i < (arrival[day] ?? 0); i++) queue.push(day);
    peakBacklog = Math.max(peakBacklog, queue.length);
    for (let i = 0; i < dailyCapacity && queue.length; i++) {
      delays.push(day - queue.shift()!);
    }
    if (day === days - 1) backlogAfterSevenDays = queue.length;
  }
  if (delays.length !== submittedProofs) {
    throw new Error('REVIEW_QUEUE_DID_NOT_DRAIN');
  }
  delays.sort((a, b) => a - b);
  const percentile = (fraction: number) => delays.length
    ? delays[Math.ceil(delays.length * fraction) - 1] : 0;
  return {
    assumedMinutesPerSubmittedProof: minutesPerProof,
    assumedReviewerHoursPerDay: reviewerHoursPerDay,
    arrivalDays,
    submittedProofs,
    reviewerHours: Number((submittedProofs * minutesPerProof / 60).toFixed(2)),
    peakBacklog, backlogAfterSevenDays,
    p50DelayDays: percentile(0.5), p95DelayDays: percentile(0.95),
    label: 'Deterministic fictional queue model, not observed reviewer telemetry',
  };
}

// Analytical sensitivity grid. These are conditional calculations over a
// fictional 100-start cohort, never changes to an existing reservation or
// evidence of demand, unique humans, real visits, or merchant cash value.
export function projectPolicySensitivity() {
  const fundedStarts = 100;
  const rewards = [50, 100, 200];
  const completionRates = [0.25, 0.5, 0.75];
  const abandonmentRates = [0, 0.25, 0.5];
  const repeatRates = [0, 0.25];
  const reviewerHoursPerDay = [0.25, 1, 4];
  const cosmeticDemandRates = [0, 0.5];
  const assumedAbuseRates = [0, 0.05];
  const rows = [];
  for (const rewardMinor of rewards) for (const completionRate of completionRates)
    for (const abandonmentRate of abandonmentRates)
      for (const repeatRate of repeatRates)
      for (const reviewerHours of reviewerHoursPerDay)
        for (const cosmeticDemandRate of cosmeticDemandRates)
          for (const assumedAbuseRate of assumedAbuseRates) {
            const abandoned = Math.floor(fundedStarts * abandonmentRate);
            const submitted = fundedStarts - abandoned;
            const approved = Math.floor(submitted * completionRate);
            const repeatedSyntheticVisits = Math.floor(approved * repeatRate);
            const distinctSyntheticVisits = approved - repeatedSyntheticVisits;
            const issuedMinor = approved * rewardMinor;
            const cosmeticRetiredMinor = Math.floor(issuedMinor * cosmeticDemandRate);
            const circulatingMinor = issuedMinor - cosmeticRetiredMinor;
            const modeledDailyReviewCapacity = Math.floor(reviewerHours * 60 / 3);
            const backlogAfterSevenDays = Math.max(0, submitted - modeledDailyReviewCapacity * 7);
            const assumedAbuseLossMinor = Math.floor(issuedMinor * assumedAbuseRate);
            if (issuedMinor !== cosmeticRetiredMinor + circulatingMinor ||
                approved > submitted || submitted + abandoned !== fundedStarts ||
                backlogAfterSevenDays < 0) throw new Error('POLICY_SWEEP_CONSERVATION_FAILED');
            rows.push({ rewardMinor, completionRate, abandonmentRate, repeatRate,
              reviewerHoursPerDay: reviewerHours,
              cosmeticDemandRate, assumedAbuseRate, fundedStarts, submitted, approved, abandoned,
              repeatedSyntheticVisits, distinctSyntheticVisits,
              issuedMinor, cosmeticRetiredMinor, circulatingMinor,
              modeledDailyReviewCapacity, backlogAfterSevenDays, assumedAbuseLossMinor,
              costPerSyntheticApprovalMinor: approved ? issuedMinor / approved : null,
              costPerDistinctSyntheticVisitMinor: distinctSyntheticVisits
                ? Number((issuedMinor / distinctSyntheticVisits).toFixed(2)) : null,
              costPerRealVerifiedVisit: null });
          }
  return {
    version: 'economy-policy-sensitivity-v1',
    evidenceClass: 'analytical projection, not PostgreSQL transactions or pilot observations',
    assumptions: { fictionalFundedStarts: fundedStarts, arrivalPattern: 'all submitted proofs arrive on day one',
      reviewMinutesPerProof: 3, reviewDays: 7, noRealMerchantCashValue: true,
      noFraudClassifierOrFalsePositiveMeasurement: true },
    dimensions: { rewards, completionRates, abandonmentRates, repeatRates, reviewerHoursPerDay,
      cosmeticDemandRates, assumedAbuseRates },
    cases: rows,
  };
}

export async function runEconomySimulation(scenario: EconomySimulationScenario = BASELINE_SCENARIO) {
  if (scenario.version !== 'economy-sim-v2' || !Number.isSafeInteger(scenario.seed) ||
      !Number.isInteger(scenario.registeredTravelers) || scenario.registeredTravelers < 1 ||
      scenario.registeredTravelers > 200 || !Number.isInteger(scenario.fundedStarts) ||
      scenario.fundedStarts < 1 || scenario.fundedStarts > scenario.registeredTravelers ||
      !Number.isInteger(scenario.approved) || scenario.approved < 0 ||
      !Number.isInteger(scenario.rejected) || scenario.rejected < 0 ||
      scenario.approved + scenario.rejected > scenario.fundedStarts ||
      !Number.isSafeInteger(scenario.rewardMinor) || scenario.rewardMinor < 1 ||
      !Number.isSafeInteger(scenario.allocationMinor) ||
      scenario.allocationMinor < scenario.fundedStarts * scenario.rewardMinor ||
      (scenario.merchantStock !== undefined &&
        (!Number.isSafeInteger(scenario.merchantStock) || scenario.merchantStock < 0)) ||
      (scenario.merchantRequests !== undefined &&
        (!Number.isSafeInteger(scenario.merchantRequests) || scenario.merchantRequests < 0)) ||
      (scenario.chainFailure !== undefined &&
        !['rpc-outage', 'reorg-replay'].includes(scenario.chainFailure))) {
    throw new Error('INVALID_FICTIONAL_SIMULATION_SCENARIO');
  }
  if (!process.env.JDQ_REAL_PG_URL && process.env.JDQ_ECONOMY_ACCEPTANCE === 'true') {
    throw new Error('REAL_POSTGRES_REQUIRED_FOR_ECONOMY_ACCEPTANCE');
  }
  const fixture = await createTestDb();
  try {
    const economy = new EconomyService(fixture.pool);
    const random = nextSeeded(scenario.seed);
    const actorTraits = { sharedNetworkLegitimate: 0, accessibilityUsers: 0,
      intermittentConnectivityUsers: 0, adversarialAccounts: 0 };
    // Disposable simulation inventory, deliberately separate from any
    // merchant voucher, settlement or cash-liability production table.
    await fixture.pool.query(`CREATE TABLE sim_merchant_inventory (
      merchant_id TEXT PRIMARY KEY, stock INTEGER NOT NULL CHECK (stock >= 0),
      reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0)
    )`);
    const initialMerchantStock = scenario.merchantStock ?? 4;
    const merchantRequests = scenario.merchantRequests ?? 2;
    await fixture.pool.query(
      `INSERT INTO sim_merchant_inventory(merchant_id, stock) VALUES ('sim-merchant', $1)`,
      [initialMerchantStock]
    );
    await fixture.pool.query(`
      INSERT INTO users(id, seed_id, display_name, email, role)
      VALUES ('sim-admin', 'sim-admin', 'Independent reviewer', 'admin@sim.test', 'admin')
    `);
    await fixture.pool.query(`UPDATE users SET is_test = TRUE WHERE id = 'sim-admin'`);
    for (let i = 1; i <= scenario.registeredTravelers; i++) {
      await fixture.pool.query(
        `INSERT INTO users(id, seed_id, display_name, email, role, is_test)
         VALUES ($1, $2, $3, $4, 'user', TRUE)`,
        [`sim-user-${i}`, `sim-user-${i}`, `Traveler ${i}`, `traveler${i}@sim.test`]
      );
      if (i <= 2) actorTraits.sharedNetworkLegitimate++;
      if (i === 3) actorTraits.accessibilityUsers++;
      if (random() < 0.25) actorTraits.intermittentConnectivityUsers++;
      if (i === scenario.registeredTravelers) actorTraits.adversarialAccounts++;
    }
    await fixture.pool.query(`
      INSERT INTO users(id,seed_id,display_name,email,role,is_test) VALUES
      ('sim-author','sim-author','Destination author','author@sim.test','user',TRUE),
      ('sim-independent-admin','sim-independent-admin','Appeal reviewer','reviewer@sim.test','admin',TRUE),
      ('sim-merchant','sim-merchant','Fictional merchant','merchant@sim.test','user',TRUE),
      ('sim-sponsor','sim-sponsor','Fictional sponsor','sponsor@sim.test','user',TRUE)
    `);
    await fixture.pool.query(`
      INSERT INTO quests(id, title, description, category, location_name, gps_lat, gps_lng,
        reward_points, marker_code, marker_image_url)
      VALUES ('sim-quest', 'Fictional culture walk', 'Simulation only', 'cultural',
        'Fictional Pangasinan venue', 16.0, 120.0, 50, 'SIM_MARKER', 'https://example.test/sim.png')
    `);
    await fixture.pool.query(`UPDATE quests SET is_test = TRUE, author_id = 'sim-author' WHERE id = 'sim-quest'`);
    await fixture.pool.query(`
      INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,
        gps_lat,gps_lng,source_type,source_name,status,created_by,is_test) VALUES
      ('sim-spot-coast','sim-spot-coast','Fictional coastal stop','Simulation only',
       'nature','coast','Bolinao','Fictional',16.0,120.0,'community','Fictional Simulation',
       'published','sim-author',TRUE),
      ('sim-spot-food','sim-spot-food','Fictional food stop','Simulation only',
       'food','local','Dagupan','Fictional',16.0,120.0,'community','Fictional Simulation',
       'published','sim-author',TRUE),
      ('sim-spot-heritage','sim-spot-heritage','Fictional heritage stop','Simulation only',
       'heritage','walk','Lingayen','Fictional',16.0,120.0,'community','Fictional Simulation',
       'published','sim-author',TRUE)
    `);
    if (process.env.JDQ_REAL_PG_URL) {
      if (scenario.name === 'author-reviewer-collusion') {
        let rejected = false;
        try {
          await economy.createReviewedPilotAuthority({
            questId: 'sim-quest', scopeId: 'collusive-scope', scopeKey: 'collusive-scope',
            policyId: 'collusive-v1', policyKey: 'collusive-v1', policyVersion: 1,
            proposedBy: 'sim-author', reviewedBy: 'sim-author', countryCode: 'PH',
            activityKind: 'visit', activityFingerprint: 'collusive-scope',
            summary: 'Rejected self-review', rationale: 'Conflicted fictional review',
            rewardMinor: BigInt(scenario.rewardMinor), reservationSeconds: 3600,
            appealSeconds: 3600,
          });
        } catch (error) {
          rejected = error instanceof Error && error.message === 'INVALID_REVIEWED_AUTHORITY';
        }
        if (!rejected) throw new Error('COLLUSIVE_SELF_REVIEW_WAS_NOT_DENIED');
      }
      await economy.createReviewedPilotAuthority({
        questId: 'sim-quest', scopeId: 'sim:walk:one', scopeKey: 'sim:walk:one',
        policyId: 'sim-v1', policyKey: 'sim-v1', policyVersion: 1,
        proposedBy: 'sim-author', reviewedBy: 'sim-admin', countryCode: 'PH',
        provinceName: 'Pangasinan', municipalityName: 'Bolinao',
        destinationSpotId: 'sim-spot-coast', activityKind: 'visit', activityFingerprint: 'sim:walk:one',
        summary: 'Fictional culture walk', rationale: 'Independent simulation review',
        rewardMinor: BigInt(scenario.rewardMinor), reservationSeconds: 3600, appealSeconds: 3600,
      });
    }
    await economy.createPilotPool({
      id: 'sim-pool', questId: 'sim-quest', scopeKey: 'sim:walk:one', policyVersion: 'sim-v1',
      scopeId: 'sim:walk:one', policyId: 'sim-v1',
      rewardMinor: BigInt(scenario.rewardMinor), allocationMinor: BigInt(scenario.allocationMinor), reservationSeconds: 3600,
      appealSeconds: 3600, adminId: 'sim-admin',
    });
    await economy.activatePilotPool('sim-pool', 'sim-admin');
    await fixture.pool.query(`
      INSERT INTO economic_cosmetics(id, asset_code, cost_minor, active)
      VALUES ('sim-frame', 'EXPLORER_COIN_SIM', 40, true)
    `);

    const reservations: string[] = [];
    for (let i = 1; i <= scenario.fundedStarts; i++) {
      const held = await economy.reserveReward('sim-pool', `sim-user-${i}`);
      reservations.push(held.id);
    }
    let sponsorCancellationBlockedNewStart = false;
    if (scenario.sponsorCancellation) {
      // Model a cancellation of future participation only. A real sponsor
      // funding/refund contract does not exist in this internal pilot.
      await fixture.pool.query(
        `UPDATE reward_pools SET status = 'paused' WHERE id = 'sim-pool' AND status = 'active'`
      );
      try {
        await economy.reserveReward('sim-pool', `sim-user-${scenario.fundedStarts + 1}`);
      } catch (error) {
        sponsorCancellationBlockedNewStart = error instanceof Error && error.message === 'POOL_NOT_ACTIVE';
      }
      if (!sponsorCancellationBlockedNewStart) throw new Error('CANCELLATION_ALLOWED_NEW_START');
    }
    let unfundedStartDenied = false;
    if (scenario.probeUnfundedStart) {
      if (scenario.registeredTravelers <= scenario.fundedStarts) {
        throw new Error('UNFUNDED_PROBE_REQUIRES_ANOTHER_TRAVELER');
      }
      try {
        await economy.reserveReward('sim-pool', `sim-user-${scenario.fundedStarts + 1}`);
      } catch (error) {
        unfundedStartDenied = error instanceof Error && error.message === 'NO_FUNDED_SLOT';
      }
      if (!unfundedStartDenied) throw new Error('UNFUNDED_START_WAS_NOT_DENIED');
    }

    for (let i = 1; i <= scenario.approved + scenario.rejected; i++) {
      const status = i <= scenario.approved ? 'approved' : 'rejected';
      const id = `sim-sub-${i}`;
      await fixture.pool.query(
        `INSERT INTO submissions(id, idempotency_key, user_id, quest_id, scanned_marker_code,
         captured_lat, captured_lng, captured_accuracy, status, is_test)
         VALUES ($1, $2, $3, 'sim-quest', 'SIM_MARKER', 16.0, 120.0, 8, $4, TRUE)`,
        [id, id, `sim-user-${i}`, status]
      );
      if (process.env.JDQ_REAL_PG_URL) {
        const reservationId = reservations[i - 1];
        const attempt = await fixture.pool.query('SELECT attempt_id FROM reward_reservations WHERE id = $1', [reservationId]);
        await fixture.pool.query('UPDATE submissions SET economic_attempt_id = $2 WHERE id = $1',
          [id, attempt.rows[0].attempt_id]);
        await fixture.pool.query(
          `UPDATE reward_reservations SET status = 'submitted', submission_id = $2,
           submitted_at = (SELECT created_at FROM submissions WHERE id = $2) WHERE id = $1`,
          [reservationId, id]
        );
      }
      const client = await fixture.pool.connect();
      try {
        await client.query('BEGIN');
        const sub = (await client.query(
          'SELECT id, user_id, quest_id, created_at FROM submissions WHERE id = $1', [id]
        )).rows[0];
        if (status === 'approved') {
          await economy.settleApprovedSubmissionInTx(client, sub, 'sim-admin');
        } else {
          await economy.holdRejectedSubmissionInTx(client, sub);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    for (let i = scenario.approved + 1; i <= scenario.approved + scenario.rejected; i++) {
      await fixture.pool.query(
        "UPDATE reward_reservations SET appeal_until = now() - interval '1 second' WHERE id = $1",
        [reservations[i - 1]]
      );
      await economy.releaseExpiredReservation(reservations[i - 1]);
    }
    if (process.env.JDQ_REAL_PG_URL) {
      // Disposable-only fixture time travel. Real reservation deadlines are
      // immutable once the traveler receives the funded start receipt.
      await fixture.pool.query('ALTER TABLE reward_reservations DISABLE TRIGGER economic_reservation_authority_guard_trigger');
    }
    try {
      for (let i = scenario.approved + scenario.rejected + 1; i <= scenario.fundedStarts; i++) {
        await fixture.pool.query(
          "UPDATE reward_reservations SET expires_at = now() - interval '1 second' WHERE id = $1",
          [reservations[i - 1]]
        );
      }
    } finally {
      if (process.env.JDQ_REAL_PG_URL) {
        await fixture.pool.query('ALTER TABLE reward_reservations ENABLE TRIGGER economic_reservation_authority_guard_trigger');
      }
    }
    for (let i = scenario.approved + scenario.rejected + 1; i <= scenario.fundedStarts; i++) {
      await economy.releaseExpiredReservation(reservations[i - 1]);
    }

    let additionalApproved = 0;
    if (scenario.multiDestination) {
      const otherDestinations = [
        { questId: 'sim-quest-food', poolId: 'sim-pool-food', scopeId: 'sim:food:one',
          policyId: 'sim-food-v1', spotId: 'sim-spot-food', municipality: 'Dagupan',
          category: 'food_trade', firstUser: 13 },
        { questId: 'sim-quest-heritage', poolId: 'sim-pool-heritage', scopeId: 'sim:heritage:one',
          policyId: 'sim-heritage-v1', spotId: 'sim-spot-heritage', municipality: 'Lingayen',
          category: 'cultural', firstUser: 16 },
      ];
      for (const destination of otherDestinations) {
        await fixture.pool.query(
          `INSERT INTO quests(id,title,description,category,location_name,gps_lat,gps_lng,
            reward_points,marker_code,marker_image_url,author_id,is_test)
           VALUES ($1,$2,'Simulation only',$3,$4,16,120,50,$5,'https://example.test/sim.png',
             'sim-author',TRUE)`,
          [destination.questId, `Fictional ${destination.municipality} stop`,
            destination.category, destination.municipality, `MARKER_${destination.questId}`]
        );
        if (process.env.JDQ_REAL_PG_URL) {
          await economy.createReviewedPilotAuthority({
            questId: destination.questId, scopeId: destination.scopeId,
            scopeKey: destination.scopeId, policyId: destination.policyId,
            policyKey: destination.policyId, policyVersion: 1,
            proposedBy: 'sim-author', reviewedBy: 'sim-admin', countryCode: 'PH',
            provinceName: 'Pangasinan', municipalityName: destination.municipality,
            destinationSpotId: destination.spotId, activityKind: 'visit',
            activityFingerprint: destination.scopeId,
            summary: `Fictional ${destination.municipality} stop`,
            rationale: 'Independent fictional destination review',
            rewardMinor: BigInt(scenario.rewardMinor), reservationSeconds: 3600,
            appealSeconds: 3600,
          });
        }
        await economy.createPilotPool({
          id: destination.poolId, questId: destination.questId,
          scopeKey: destination.scopeId, policyVersion: destination.policyId,
          scopeId: destination.scopeId, policyId: destination.policyId,
          rewardMinor: BigInt(scenario.rewardMinor),
          allocationMinor: BigInt(3 * scenario.rewardMinor),
          reservationSeconds: 3600, appealSeconds: 3600, adminId: 'sim-admin',
        });
        await economy.activatePilotPool(destination.poolId, 'sim-admin');
        for (let offset = 0; offset < 3; offset++) {
          const userId = `sim-user-${destination.firstUser + offset}`;
          const reservation = await economy.reserveReward(destination.poolId, userId);
          const submissionId = `sim-sub-${destination.questId}-${offset}`;
          await fixture.pool.query(
            `INSERT INTO submissions(id,idempotency_key,user_id,quest_id,scanned_marker_code,
               captured_lat,captured_lng,captured_accuracy,status,is_test)
             VALUES ($1,$1,$2,$3,$4,16,120,8,'approved',TRUE)`,
            [submissionId, userId, destination.questId, `MARKER_${destination.questId}`]
          );
          if (process.env.JDQ_REAL_PG_URL) {
            const attempt = await fixture.pool.query(
              'SELECT attempt_id FROM reward_reservations WHERE id = $1', [reservation.id]
            );
            await fixture.pool.query(
              'UPDATE submissions SET economic_attempt_id = $2 WHERE id = $1',
              [submissionId, attempt.rows[0].attempt_id]
            );
            await fixture.pool.query(
              `UPDATE reward_reservations SET status = 'submitted', submission_id = $2,
               submitted_at = (SELECT created_at FROM submissions WHERE id = $2) WHERE id = $1`,
              [reservation.id, submissionId]
            );
          }
          const client = await fixture.pool.connect();
          try {
            await client.query('BEGIN');
            const sub = (await client.query(
              'SELECT id,user_id,quest_id,created_at FROM submissions WHERE id = $1',
              [submissionId]
            )).rows[0];
            await economy.settleApprovedSubmissionInTx(client, sub, 'sim-admin');
            await client.query('COMMIT');
            additionalApproved++;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        }
      }
    }

    if (scenario.cosmeticDemand && scenario.approved > 0 && scenario.rewardMinor >= 40) {
      const purchase = await economy.purchaseCosmetic('sim-user-1', 'sim-frame', 'sim-purchase-1');
      const replay = await economy.purchaseCosmetic('sim-user-1', 'sim-frame', 'sim-purchase-1');
      if (purchase.transactionId !== replay.transactionId) throw new Error('purchase replay changed receipt');
    }

    const stockAttempts = await Promise.all(Array.from({ length: merchantRequests }, () =>
      fixture.pool.query(
        `UPDATE sim_merchant_inventory SET stock = stock - 1, reserved = reserved + 1
         WHERE merchant_id = 'sim-merchant' AND stock > 0 RETURNING stock`
      )
    ));
    const merchantReservations = stockAttempts.reduce((sum, result) => sum + (result.rowCount ?? 0), 0);
    const merchant = (await fixture.pool.query(
      `SELECT stock, reserved FROM sim_merchant_inventory WHERE merchant_id = 'sim-merchant'`
    )).rows[0];
    const stockRemaining = Number(merchant.stock);
    const stockReserved = Number(merchant.reserved);
    if (merchantReservations !== Math.min(initialMerchantStock, merchantRequests) ||
        stockReserved !== merchantReservations ||
        stockRemaining + stockReserved !== initialMerchantStock) {
      throw new Error('FICTIONAL_MERCHANT_STOCK_CONSERVATION_FAILED');
    }

    const abuseChecks = { collusiveSelfReviewDenied: false, activeClonePoolDenied: false,
      cloneRewardDenied: false,
      unboundProofDenied: false,
      duplicatePurchaseReplayed: scenario.cosmeticDemand && scenario.approved > 0 && scenario.rewardMinor >= 40 };
    if (process.env.JDQ_REAL_PG_URL && scenario.name === 'author-reviewer-collusion') {
      abuseChecks.collusiveSelfReviewDenied = true;
    }
    if (process.env.JDQ_REAL_PG_URL && scenario.name === 'cloned-quest') {
      await fixture.pool.query(`
        INSERT INTO quests(id,title,description,category,location_name,gps_lat,gps_lng,
          marker_code,marker_image_url,author_id,status,is_test,version)
        VALUES ('sim-clone','Cloned walk','Same physical activity','cultural','Fictional',
          16,120,'SIM_CLONE','https://example.test/clone.png','sim-author','published',TRUE,1)
      `);
      await economy.bindReviewedQuestRevision({
        questId: 'sim-clone', scopeId: 'sim:walk:one', proposedBy: 'sim-author',
        reviewedBy: 'sim-admin', rationale: 'Same underlying visit as the original',
      });
      await economy.createPilotPool({
        id: 'sim-clone-pool', questId: 'sim-clone', scopeKey: 'sim:walk:one',
        policyVersion: 'sim-v1', scopeId: 'sim:walk:one', policyId: 'sim-v1',
        rewardMinor: BigInt(scenario.rewardMinor), allocationMinor: BigInt(scenario.rewardMinor),
        reservationSeconds: 3600, appealSeconds: 3600, adminId: 'sim-admin',
      });
      try { await economy.activatePilotPool('sim-clone-pool', 'sim-admin'); }
      catch (error) {
        abuseChecks.activeClonePoolDenied = Boolean(error && typeof error === 'object' &&
          'code' in error && error.code === '23505');
      }
      if (!abuseChecks.activeClonePoolDenied) throw new Error('PARALLEL_ACTIVE_CLONE_POOL_ALLOWED');
      await fixture.pool.query(`UPDATE reward_pools SET status = 'closed' WHERE id = 'sim-pool'`);
      await economy.activatePilotPool('sim-clone-pool', 'sim-admin');
      try { await economy.reserveReward('sim-clone-pool', 'sim-user-1'); }
      catch (error) { abuseChecks.cloneRewardDenied = error instanceof Error && error.message === 'ALREADY_AWARDED'; }
      if (!abuseChecks.cloneRewardDenied) throw new Error('CLONE_RESET_REWARD_ELIGIBILITY');
    }
    if (process.env.JDQ_REAL_PG_URL && scenario.name === 'spoofed-unbound-proof') {
      // The user has a released initial reservation and no award; a new funded
      // start exists, but this synthetic approved row has no matching attempt.
      const actor = `sim-user-${scenario.fundedStarts}`;
      const held = await economy.reserveReward('sim-pool', actor);
      await fixture.pool.query(
        `INSERT INTO submissions(id,idempotency_key,user_id,quest_id,scanned_marker_code,
          captured_lat,captured_lng,captured_accuracy,status,is_test)
         VALUES ('sim-forged-proof','sim-forged-proof-key',$1,'sim-quest',
          'SIM_MARKER',16,120,8,'approved',TRUE)`, [actor]
      );
      const forged = (await fixture.pool.query(
        `SELECT id,user_id,quest_id,created_at FROM submissions WHERE id = 'sim-forged-proof'`
      )).rows[0];
      try { await economy.settleApprovedSubmissionInTx(fixture.pool, forged, 'sim-admin'); }
      catch (error) { abuseChecks.unboundProofDenied = error instanceof Error && error.message === 'ATTEMPT_PROOF_MISMATCH'; }
      if (!abuseChecks.unboundProofDenied) throw new Error('UNBOUND_PROOF_WAS_AWARDED');
      await fixture.pool.query('ALTER TABLE reward_reservations DISABLE TRIGGER economic_reservation_authority_guard_trigger');
      try {
        await fixture.pool.query(
          `UPDATE reward_reservations SET expires_at = now() - interval '1 second' WHERE id = $1`,
          [held.id]
        );
      } finally {
        await fixture.pool.query('ALTER TABLE reward_reservations ENABLE TRIGGER economic_reservation_authority_guard_trigger');
      }
      await economy.releaseExpiredReservation(held.id);
    }

    let chainProjection: null | {
      failure: 'rpc-outage' | 'reorg-replay'; indexedEvents: number;
      canonicalEvents: number; offChainTransferRowsUnchanged: boolean;
      offChainTravelerBalanceUnchanged: boolean; simulatedProviderFailureObserved: boolean;
      label: string;
    } = null;
    if (scenario.chainFailure) {
      const before = await fixture.pool.query('SELECT count(*)::int AS n FROM economic_transfers');
      const balanceBefore = await economy.balance('sim-user-1');
      await fixture.pool.query(`CREATE TABLE sim_chain_projection (
        chain_id BIGINT NOT NULL CHECK (chain_id = 84532), tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL, block_hash TEXT NOT NULL,
        canonical BOOLEAN NOT NULL,
        PRIMARY KEY (chain_id, tx_hash, log_index, block_hash)
      )`);
      await fixture.pool.query(`CREATE UNIQUE INDEX sim_one_canonical_event
        ON sim_chain_projection(chain_id, tx_hash, log_index) WHERE canonical = TRUE`);
      let simulatedProviderFailureObserved = false;
      if (scenario.chainFailure === 'rpc-outage') {
        try {
          await Promise.reject(new Error('SIMULATED_RPC_UNAVAILABLE'));
        } catch (error) {
          simulatedProviderFailureObserved = error instanceof Error &&
            error.message === 'SIMULATED_RPC_UNAVAILABLE';
        }
      }
      if (scenario.chainFailure === 'reorg-replay') {
        const event = [84532, 'sim-tx-1', 0, 'sim-block-old'];
        await fixture.pool.query(
          `INSERT INTO sim_chain_projection VALUES ($1,$2,$3,$4,TRUE)`, event
        );
        await fixture.pool.query(
          `INSERT INTO sim_chain_projection VALUES ($1,$2,$3,$4,TRUE)
           ON CONFLICT DO NOTHING`, event
        );
        await fixture.pool.query(
          `UPDATE sim_chain_projection SET canonical = FALSE
           WHERE chain_id = $1 AND tx_hash = $2 AND log_index = $3 AND block_hash = $4`, event
        );
        await fixture.pool.query(
          `INSERT INTO sim_chain_projection VALUES ($1,$2,$3,$4,TRUE)`,
          [84532, 'sim-tx-1', 0, 'sim-block-new']
        );
      }
      const events = await fixture.pool.query(
        `SELECT canonical FROM sim_chain_projection`
      );
      const after = await fixture.pool.query('SELECT count(*)::int AS n FROM economic_transfers');
      const balanceAfter = await economy.balance('sim-user-1');
      const indexedEvents = events.rows.length;
      const canonicalEvents = events.rows.filter((row) => row.canonical === true).length;
      const offChainTransferRowsUnchanged = Number(before.rows[0].n) === Number(after.rows[0].n);
      const offChainTravelerBalanceUnchanged = balanceBefore === balanceAfter;
      if (!offChainTransferRowsUnchanged || !offChainTravelerBalanceUnchanged ||
          (scenario.chainFailure === 'rpc-outage' &&
            (!simulatedProviderFailureObserved || indexedEvents !== 0 || canonicalEvents !== 0)) ||
          (scenario.chainFailure === 'reorg-replay' && (indexedEvents !== 2 || canonicalEvents !== 1))) {
        throw new Error('FICTIONAL_CHAIN_PROJECTION_ISOLATION_FAILED');
      }
      chainProjection = { failure: scenario.chainFailure, indexedEvents, canonicalEvents,
        offChainTransferRowsUnchanged, offChainTravelerBalanceUnchanged,
        simulatedProviderFailureObserved,
        label: 'Disposable projection fixture only; not the production Base Sepolia indexer or RPC integration' };
    }

    const pool = (await fixture.pool.query('SELECT * FROM reward_pools WHERE id = $1', ['sim-pool'])).rows[0];
    const allocated = BigInt(pool.allocated_minor);
    const available = BigInt(pool.available_minor);
    const reserved = BigInt(pool.reserved_minor);
    const paid = BigInt(pool.paid_minor);
    const returned = BigInt(pool.returned_minor);
    if (allocated !== available + reserved + paid + returned) throw new Error('pool conservation failed');
    const accounts = await fixture.pool.query(
      "SELECT kind, balance_minor FROM economic_accounts WHERE asset_code = 'EXPLORER_COIN_SIM'"
    );
    const net = accounts.rows.reduce((sum, row) => sum + BigInt(row.balance_minor), 0n);
    if (net !== 0n) throw new Error('asset transfer conservation failed');
    const movements = await fixture.pool.query(
      `SELECT from_account_id,to_account_id,amount_minor FROM economic_transfers
       WHERE asset_code = 'EXPLORER_COIN_SIM'`
    );
    let issuance = 0n;
    let retirement = 0n;
    let refundFromRetirement = 0n;
    for (const movement of movements.rows) {
      const amount = BigInt(String(movement.amount_minor));
      if (movement.from_account_id === 'sim:issuance') issuance += amount;
      if (movement.to_account_id === 'sim:retired') retirement += amount;
      if (movement.from_account_id === 'sim:retired') refundFromRetirement += amount;
    }
    const circulation = accounts.rows
      .filter((row) => row.kind === 'traveler' || row.kind === 'treasury')
      .reduce((sum, row) => sum + BigInt(String(row.balance_minor)), 0n);
    if (circulation !== issuance + refundFromRetirement - retirement) {
      throw new Error('circulation equation failed');
    }
    const allPoolRows = (await fixture.pool.query(
      `SELECT id,allocated_minor,available_minor,reserved_minor,paid_minor,returned_minor
       FROM reward_pools ORDER BY id`
    )).rows;
    for (const row of allPoolRows) {
      if (BigInt(row.allocated_minor) !== BigInt(row.available_minor) +
          BigInt(row.reserved_minor) + BigInt(row.paid_minor) +
          BigInt(row.returned_minor)) throw new Error('ALL_POOL_CONSERVATION_FAILED');
    }
    const allPoolPaid = allPoolRows.reduce((sum, row) => sum + BigInt(row.paid_minor), 0n);
    if (allPoolPaid !== issuance) throw new Error('POOL_PAID_AND_LEDGER_ISSUANCE_DIVERGED');
    const rewardRows = (await fixture.pool.query(
      `SELECT p.quest_id,a.awarded_minor FROM reward_awards a
       JOIN reward_reservations r ON r.id = a.reservation_id
       JOIN reward_pools p ON p.id = r.pool_id`
    )).rows;
    const questDestinations: Record<string, { spotId: string; municipality: string }> = {
      'sim-quest': { spotId: 'sim-spot-coast', municipality: 'Bolinao' },
      'sim-quest-food': { spotId: 'sim-spot-food', municipality: 'Dagupan' },
      'sim-quest-heritage': { spotId: 'sim-spot-heritage', municipality: 'Lingayen' },
    };
    const benefitMinor = new Map<string, bigint>();
    for (const row of rewardRows) {
      const destination = questDestinations[row.quest_id];
      if (!destination) throw new Error('UNATTRIBUTED_REWARD_DESTINATION');
      benefitMinor.set(destination.spotId,
        (benefitMinor.get(destination.spotId) ?? 0n) + BigInt(row.awarded_minor));
    }
    const totalBenefits = [...benefitMinor.values()].reduce((sum, value) => sum + value, 0n);
    if (totalBenefits !== issuance) throw new Error('DESTINATION_BENEFITS_AND_ISSUANCE_DIVERGED');
    const destinationBenefits = Object.entries(questDestinations)
      .filter(([, destination]) => benefitMinor.has(destination.spotId))
      .map(([, destination]) => ({ spotId: destination.spotId,
        municipality: destination.municipality,
        issuedMinor: String(benefitMinor.get(destination.spotId)!) }));
    const topDestinationShare = issuance > 0n
      ? Number((Number([...benefitMinor.values()].reduce((max, value) => value > max ? value : max, 0n)) /
        Number(issuance)).toFixed(4)) : null;
    const awards = Number((await fixture.pool.query('SELECT count(*) AS n FROM reward_awards')).rows[0].n);
    const entitlements = Number((await fixture.pool.query('SELECT count(*) AS n FROM economic_entitlements')).rows[0].n);
    const expectedPaid = BigInt(scenario.approved) * BigInt(scenario.rewardMinor);
    const expectedEntitlements = scenario.cosmeticDemand && scenario.approved > 0 && scenario.rewardMinor >= 40 ? 1 : 0;
    if (awards !== scenario.approved + additionalApproved || entitlements !== expectedEntitlements ||
        reserved !== 0n || paid !== expectedPaid) {
      throw new Error('scenario outcomes did not match fixture');
    }
    const drift = (await reconcileEconomy(fixture.pool)).pilotAccountDrift;
    if (drift.length !== 0) throw new Error('transfer-derived account drift');
    const awardScopes = await fixture.pool.query('SELECT user_id,scope_key FROM reward_awards');
    const awardKeys = awardScopes.rows.map((row) => `${row.user_id}\0${row.scope_key}`);
    if (new Set(awardKeys).size !== awardKeys.length) throw new Error('duplicate scope award');
    const unquarantined = await fixture.pool.query(
      `SELECT count(*)::int AS n FROM users WHERE id LIKE 'sim-%' AND is_test = FALSE`
    );
    if (Number(unquarantined.rows[0].n) !== 0) throw new Error('fictional account scope leak');
    const report = {
      database: process.env.JDQ_REAL_PG_URL ? 'disposable PostgreSQL schema' : 'pg-mem quick check',
      scenario: { ...scenario },
      provenance: sourceProvenance(),
      modelWindow: { start: '2026-10-01T00:00:00.000Z', end: '2026-10-08T00:00:00.000Z',
        note: 'Analytical window only; PostgreSQL transaction timestamps are real wall time.' },
      actorTraits,
      fictionalTravelers: scenario.registeredTravelers,
      fundedStarts: scenario.fundedStarts + additionalApproved,
      submissions: scenario.approved + scenario.rejected + additionalApproved,
      approved: scenario.approved + additionalApproved, rejected: scenario.rejected,
      abandoned: scenario.fundedStarts - scenario.approved - scenario.rejected,
      unfundedStartDenied,
      sponsorCancellation: {
        requested: Boolean(scenario.sponsorCancellation),
        newStartBlocked: sponsorCancellationBlockedNewStart,
        existingApprovedProofsStillPaid: scenario.sponsorCancellation ? awards === scenario.approved : null,
        actualSponsorRefundOrCashTransfer: false,
        label: 'Pool pause fixture preserves prior funded promises; no real sponsor funding or refund exists',
      },
      additionalApproved, awards, entitlements, pool: { allocated: String(allocated), available: String(available),
        reserved: String(reserved), paid: String(paid), returned: String(returned) },
      allPools: allPoolRows.map((row) => ({ id: row.id, allocated: String(row.allocated_minor),
        available: String(row.available_minor), reserved: String(row.reserved_minor),
        paid: String(row.paid_minor), returned: String(row.returned_minor) })),
      destinationBenefit: { uniqueRewardedDestinations: destinationBenefits.length,
        topDestinationShare, destinations: destinationBenefits,
        label: 'Internal fictional reward allocation by reviewed destination, not measured tourism revenue' },
      accounting: { issuance: String(issuance), retirement: String(retirement),
        refundsFromRetirement: String(refundFromRetirement), circulation: String(circulation) },
      staffingProjection: projectReviewerQueue(scenario),
      merchantStockFixture: {
        startingUnits: initialMerchantStock, simulatedRequests: merchantRequests,
        reservations: merchantReservations, deniedForNoStock: merchantRequests - merchantReservations,
        remainingUnits: stockRemaining, merchantCashObligation: 0,
        label: 'Disposable PostgreSQL stock contention fixture only; no offer, voucher, cash or settlement contract',
      },
      chainProjection,
      visitEvidence: {
        approvedFixtureProofs: scenario.approved + additionalApproved,
        verifiedDistinctVisits: 0,
        costPerVerifiedDistinctVisit: null,
        label: 'Fixture does not execute the GPS/visit attestation pipeline; no verified-footfall claim',
      },
      fairnessProjection: {
        sharedNetworkFunded: Math.min(2, scenario.fundedStarts),
        sharedNetworkApproved: Math.min(2, scenario.approved),
        accessibilityFunded: scenario.fundedStarts >= 3 ? 1 : 0,
        accessibilityApproved: scenario.approved >= 3 ? 1 : 0,
        legitimateSharedNetworkBlocked: 0, accessibilityUsersBlocked: 0,
        label: 'Fixture has no anti-sybil classifier; false-positive rate is not established',
      },
      abuseChecks,
      invariantChecks: {
        poolConservation: true, assetNetZero: true, circulationEquation: true,
        transferDerivedBalanceDrift: 0, duplicateScopeAwards: 0,
        syntheticAccountLeaks: 0,
      },
      accountNet: String(net), travelerOneBalance: await economy.balance('sim-user-1'),
    };
    return report;
  } finally {
    await fixture.close();
  }
}

if (/economy-simulation\.(?:ts|js)$/.test(process.argv[1] ?? '')) {
  if (process.argv.includes('--policy-sweep')) {
    if (process.argv.includes('--all') || process.argv.some((arg) => arg.startsWith('--scenario='))) {
      process.stderr.write('--policy-sweep cannot be combined with a transaction scenario.\n');
      process.exitCode = 2;
    } else {
      const sweep = projectPolicySensitivity();
      const expectedCases = sweep.dimensions.rewards.length * sweep.dimensions.completionRates.length *
        sweep.dimensions.abandonmentRates.length * sweep.dimensions.repeatRates.length *
        sweep.dimensions.reviewerHoursPerDay.length *
        sweep.dimensions.cosmeticDemandRates.length * sweep.dimensions.assumedAbuseRates.length;
      if (sweep.cases.length !== expectedCases) throw new Error('POLICY_SWEEP_CASE_COUNT_MISMATCH');
      const issued = sweep.cases.map((row) => row.issuedMinor);
      const backlog = sweep.cases.map((row) => row.backlogAfterSevenDays);
      const abuse = sweep.cases.map((row) => row.assumedAbuseLossMinor);
      const examples = sweep.cases.filter((row) => row.rewardMinor === 100 &&
        row.completionRate === 0.5 && row.abandonmentRate === 0 &&
        row.repeatRate === 0 &&
        row.cosmeticDemandRate === 0 && row.assumedAbuseRate === 0);
      process.stdout.write(JSON.stringify({
        version: sweep.version, evidenceClass: sweep.evidenceClass,
        assumptions: sweep.assumptions, dimensions: sweep.dimensions,
        caseCount: sweep.cases.length, expectedCases,
        extrema: { minIssuedMinor: Math.min(...issued), maxIssuedMinor: Math.max(...issued),
          minBacklogAfterSevenDays: Math.min(...backlog),
          maxBacklogAfterSevenDays: Math.max(...backlog),
          maxAssumedAbuseLossMinor: Math.max(...abuse) },
        staffingExamples: examples, provenance: sourceProvenance(),
        reproduction: 'Call projectPolicySensitivity() from the checked source for all 648 deterministic rows',
      }) + '\n');
    }
  } else {
  const requested = process.argv.find((arg) => arg.startsWith('--scenario='))?.slice('--scenario='.length);
  const scenarios = process.argv.includes('--all') ? FICTIONAL_SCENARIOS :
    requested ? FICTIONAL_SCENARIOS.filter((scenario) => scenario.name === requested) :
      [BASELINE_SCENARIO];
  if (scenarios.length === 0 || (requested && process.argv.includes('--all'))) {
    process.stderr.write('Choose exactly one known --scenario=name or --all.\n');
    process.exitCode = 2;
  } else (async () => {
    const reports = [];
    for (const scenario of scenarios) reports.push(await runEconomySimulation(scenario));
    process.stdout.write(JSON.stringify({ version: 'economy-sim-v2', reports }) + '\n');
  })().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
  }
}
