import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.NODE_ENV = 'test';

const userCount = Number.parseInt(process.env.COMMUNITY_USERS || '25', 10);
assert(Number.isInteger(userCount) && userCount >= 2 && userCount <= 100, 'COMMUNITY_USERS must be an integer from 2 to 100.');

const latencies: Record<string, number[]> = {};

async function timed<T>(operation: string, request: PromiseLike<T>): Promise<T> {
  const started = performance.now();
  const response = await request;
  (latencies[operation] ||= []).push(performance.now() - started);
  return response;
}

function requireStatus(label: string, response: { status: number; body: unknown }, expected: number) {
  assert.equal(response.status, expected, `${label}: expected ${expected}, received ${response.status}: ${JSON.stringify(response.body)}`);
}

function percentile(values: number[], ratio: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] || 0;
}

async function main() {
  const { db } = await import('../src/db/index.js');
  const createdAt = new Date().toISOString();
  const eligibilityQuestId = 'q5555555-5555-5555-5555-555555555555';

  const users = Array.from({ length: userCount }, (_, index) => ({
    id: randomUUID(),
    seed_id: `simulation-user-${index + 1}`,
    display_name: `Simulation User ${index + 1}`,
    email: `simulation-${index + 1}@example.test`,
    avatar_url: '',
    role: 'user' as const,
    demo_points: 200,
    created_at: createdAt,
    updated_at: createdAt,
  }));

  db.users.push(...users);
  db.submissions.push(...users.map((user, index) => ({
    id: `simulation-eligibility-${index + 1}`,
    idempotency_key: randomUUID(),
    user_id: user.id,
    quest_id: eligibilityQuestId,
    scanned_marker_code: 'MARKER_DAGUPAN_BANGUS_01',
    captured_lat: 16.0433,
    captured_lng: 120.3334,
    captured_accuracy: 5,
    status: 'approved' as const,
    reviewed_by: '22222222-2222-2222-2222-222222222222',
    reviewed_at: createdAt,
    created_at: createdAt,
    updated_at: createdAt,
  })));

  const [{ app }, requestModule, jwtModule, { env }] = await Promise.all([
    import('../src/app.js'),
    import('supertest'),
    import('jsonwebtoken'),
    import('../src/config/env.js'),
  ]);
  const request = requestModule.default;
  const jwt = jwtModule.default;
  app.set('trust proxy', 1);
  const api = request(app);
  const admin = db.findUserBySeed('admin-1');
  assert(admin, 'Seeded admin account is missing.');

  const tokenFor = (user: typeof users[number] | typeof admin) => jwt.sign(
    { id: user.id, seed_id: user.seed_id, role: user.role },
    env.JWT_SECRET,
    { expiresIn: '1h' },
  );
  const tokens = users.map(tokenFor);
  const adminToken = tokenFor(admin);
  const clientIp = (index: number) => `10.20.0.${index + 1}`;

  const screening = await timed('governance-screen', api
    .post('/api/v1/admin/governance/proposals/prop_1/screen')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      decision: 'approve',
      reason: 'Approved for isolated community simulation.',
      evidence_reference: 'simulation-run',
      checklist_complete: true,
    }));
  requireStatus('proposal screening', screening, 200);

  const yesVotes = Math.ceil(userCount * 0.6);
  const voteKeys = users.map(() => `simulation-vote-${randomUUID()}`);
  const voteResponses = await Promise.all(users.map((_, index) => timed('governance-vote', api
    .post('/api/v1/proposals/prop_1/votes')
    .set('Authorization', `Bearer ${tokens[index]}`)
    .set('X-Forwarded-For', clientIp(index))
    .send({ choice: index < yesVotes ? 'yes' : 'no', idempotency_key: voteKeys[index] }))));
  voteResponses.forEach((response, index) => requireStatus(`vote ${index + 1}`, response, 200));

  const voteReplay = await timed('idempotent-replay', api
    .post('/api/v1/proposals/prop_1/votes')
    .set('Authorization', `Bearer ${tokens[0]}`)
    .set('X-Forwarded-For', clientIp(0))
    .send({ choice: 'yes', idempotency_key: voteKeys[0] }));
  requireStatus('vote replay', voteReplay, 200);

  const duplicateVote = await timed('expected-conflict', api
    .post('/api/v1/proposals/prop_1/votes')
    .set('Authorization', `Bearer ${tokens[0]}`)
    .set('X-Forwarded-For', clientIp(0))
    .send({ choice: 'no', idempotency_key: `simulation-duplicate-${randomUUID()}` }));
  requireStatus('duplicate vote', duplicateVote, 409);
  assert.equal(duplicateVote.body.error.code, 'ALREADY_VOTED');

  const proposalResponse = await timed('governance-read', api.get('/api/v1/proposals/prop_1'));
  requireStatus('proposal read', proposalResponse, 200);
  const proposal = proposalResponse.body.data;
  assert.equal(proposal.votes, userCount);
  assert.equal(proposal.yes_votes, yesVotes);
  assert.equal(proposal.no_votes, userCount - yesVotes);
  assert.equal(proposal.escrow_mjdq, userCount * 4000);

  const submissionKeys = users.map(() => randomUUID());
  const submissionResponses = await Promise.all(users.map((_, index) => timed('quest-submit', api
    .post('/api/v1/submissions')
    .set('Authorization', `Bearer ${tokens[index]}`)
    .set('X-Forwarded-For', clientIp(index))
    .send({
      idempotency_key: submissionKeys[index],
      quest_id: 'q1111111-1111-1111-1111-111111111111',
      scanned_marker_code: 'MARKER_HUNDRED_ISLANDS_01',
      captured_lat: 16.2063,
      captured_lng: 119.9706,
      captured_accuracy: 5,
    }))));
  submissionResponses.forEach((response, index) => requireStatus(`submission ${index + 1}`, response, 201));

  const submissionReplay = await timed('idempotent-replay', api
    .post('/api/v1/submissions')
    .set('Authorization', `Bearer ${tokens[0]}`)
    .set('X-Forwarded-For', clientIp(0))
    .send({
      idempotency_key: submissionKeys[0],
      quest_id: 'q1111111-1111-1111-1111-111111111111',
      scanned_marker_code: 'MARKER_HUNDRED_ISLANDS_01',
      captured_lat: 16.2063,
      captured_lng: 119.9706,
      captured_accuracy: 5,
    }));
  requireStatus('submission replay', submissionReplay, 200);

  const outOfRange = await timed('expected-validation', api
    .post('/api/v1/submissions')
    .set('Authorization', `Bearer ${tokens[0]}`)
    .set('X-Forwarded-For', clientIp(0))
    .send({
      idempotency_key: randomUUID(),
      quest_id: 'q2222222-2222-2222-2222-222222222222',
      scanned_marker_code: 'MARKER_BOLINAO_LIGHTHOUSE_01',
      captured_lat: 16.5,
      captured_lng: 119.9706,
      captured_accuracy: 5,
    }));
  requireStatus('out-of-range submission', outOfRange, 422);
  assert.equal(outOfRange.body.error.code, 'OUT_OF_RANGE');

  const approvedCount = Math.ceil(userCount * 0.7);
  const reviewResponses = await Promise.all(submissionResponses.map((submission, index) => timed('admin-review', api
    .patch(`/api/v1/admin/submissions/${submission.body.data.id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send(index < approvedCount
      ? { action: 'approve' }
      : { action: 'reject', rejection_reason: 'Synthetic proof selected for rejection coverage.' }))));
  reviewResponses.forEach((response, index) => requireStatus(`review ${index + 1}`, response, 200));
  assert.equal(reviewResponses.filter((response) => response.body.data.status === 'approved').length, approvedCount);

  const redemptionKeys = users.map(() => `simulation-redeem-${randomUUID()}`);
  const redemptionResponses = await Promise.all(users.map((_, index) => timed('voucher-redeem', api
    .post('/api/v1/vouchers/v1/redeem')
    .set('Authorization', `Bearer ${tokens[index]}`)
    .set('X-Forwarded-For', clientIp(index))
    .send({ idempotency_key: redemptionKeys[index] }))));
  redemptionResponses.forEach((response, index) => requireStatus(`redemption ${index + 1}`, response, 201));
  const codes = redemptionResponses.map((response) => response.body.data.code);
  assert.equal(new Set(codes).size, userCount, 'Redemption codes must be unique.');

  const redemptionReplay = await timed('idempotent-replay', api
    .post('/api/v1/vouchers/v1/redeem')
    .set('Authorization', `Bearer ${tokens[0]}`)
    .set('X-Forwarded-For', clientIp(0))
    .send({ idempotency_key: redemptionKeys[0] }));
  requireStatus('redemption replay', redemptionReplay, 200);
  assert.equal(redemptionReplay.body.data.code, codes[0]);

  const duplicateRedemption = await timed('expected-conflict', api
    .post('/api/v1/vouchers/v1/redeem')
    .set('Authorization', `Bearer ${tokens[0]}`)
    .set('X-Forwarded-For', clientIp(0))
    .send({ idempotency_key: `simulation-redeem-duplicate-${randomUUID()}` }));
  requireStatus('duplicate redemption', duplicateRedemption, 409);
  assert.equal(duplicateRedemption.body.error.code, 'ALREADY_REDEEMED');

  const walletResponses = await Promise.all(users.map((_, index) => timed('wallet-read', api
    .get('/api/v1/wallet')
    .set('Authorization', `Bearer ${tokens[index]}`)
    .set('X-Forwarded-For', clientIp(index)))));
  walletResponses.forEach((response, index) => {
    requireStatus(`wallet ${index + 1}`, response, 200);
    const expectedMjdq = (index < approvedCount ? 145 : 95) * 1000;
    assert.equal(response.body.data.balance_mjdq, expectedMjdq, `Unexpected wallet balance for user ${index + 1}.`);
  });

  const allLatencies = Object.values(latencies).flat();
  console.log('\nCommunity simulation passed');
  console.table({
    users: userCount,
    quest_submissions: userCount,
    approved_submissions: approvedCount,
    rejected_submissions: userCount - approvedCount,
    yes_votes: yesVotes,
    no_votes: userCount - yesVotes,
    burned_mjdq: userCount * 1000,
    escrowed_mjdq: userCount * 4000,
    voucher_redemptions: userCount,
    expected_rejections: 3,
    median_latency_ms: Number(percentile(allLatencies, 0.5).toFixed(1)),
    p95_latency_ms: Number(percentile(allLatencies, 0.95).toFixed(1)),
  });
}

main().catch((error) => {
  console.error('\nCommunity simulation failed:', error);
  process.exitCode = 1;
});
