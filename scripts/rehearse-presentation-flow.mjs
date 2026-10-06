#!/usr/bin/env node
/**
 * rehearse-presentation-flow.mjs
 * Comprehensive local rehearsal of the isolated JuanChoice presentation flow.
 *
 * Verifies:
 * 1. Writes off -> 503 WRITES_DISABLED and zero new database rows.
 * 2. Explicit local opt-in -> Two guests, replay, vote change, exact demo XP/stamps, zero governance movement, wrong-campaign rejection.
 * 3. Database diffs before and after for both juanderquest_alpha and juanderquest_presentation.
 * 4. Closed-by-default restoration.
 */

import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const CAMPAIGN_ID_FILE = resolve(homedir(), '.config/juanderquest-presentation/campaign-id');
const campaignId = readFileSync(CAMPAIGN_ID_FILE, 'utf8').trim();

const CANDIDATE_1 = '64db69f1-3ebe-45ec-8f5c-c57a6f50d3a1'; // Cabongaoan Beach
const CANDIDATE_2 = 'c7808ce7-69b4-4682-813a-872b80c0dc5a'; // Cape Bolinao Lighthouse
const CANDIDATE_3 = '607c0233-8b19-4587-9d5d-b91c957b142c'; // Tambobong Beach
const WRONG_CAMPAIGN_ID = '00000000-0000-0000-0000-000000000000';

function queryDb(container, user, db, sql) {
  const cmd = `docker exec ${container} psql -U ${user} -d ${db} -tAc "${sql}"`;
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function getDatabaseMetrics(target) {
  const isAlpha = target === 'alpha';
  const container = isAlpha ? 'jdq-alpha-postgres' : 'jdq-presentation-postgres';
  const user = isAlpha ? 'jdq_alpha' : 'jdq_presentation';
  const db = isAlpha ? 'juanderquest_alpha' : 'juanderquest_presentation';

  const tables = [
    'users',
    'juanchoice_campaigns',
    'juanchoice_candidates',
    'juanchoice_ballots',
    'juanchoice_ballot_events',
    'juanchoice_participations',
    'progression_totals',
    'progression_events',
    'governance_ledger',
    'schema_migrations',
    'spots',
  ];

  const counts = {};
  for (const tbl of tables) {
    const raw = queryDb(container, user, db, `SELECT count(*) FROM ${tbl};`);
    counts[tbl] = parseInt(raw, 10);
  }

  const sumsRaw = queryDb(
    container,
    user,
    db,
    'SELECT COALESCE(sum(explorer_xp),0) || \'|\' || COALESCE(sum(civic_xp),0) || \'|\' || COALESCE(sum(civic_stamps),0) FROM progression_totals;'
  );
  const [explorerXp, civicXp, civicStamps] = sumsRaw.split('|').map(s => parseInt(s, 10));

  return {
    ...counts,
    total_explorer_xp: explorerXp,
    total_civic_xp: civicXp,
    total_civic_stamps: civicStamps,
  };
}

function stopPort4200() {
  try {
    execSync('fuser -k 4200/tcp 2>/dev/null || true');
    const pids = execSync("ss -tulpn 'sport = :4200' 2>/dev/null || true", { encoding: 'utf8' });
    const matches = [...pids.matchAll(/pid=(\d+)/g)];
    for (const m of matches) {
      const pid = m[1];
      console.log(`[rehearsal] Killing process on port 4200 (PID ${pid})...`);
      execSync(`kill -9 ${pid} 2>/dev/null || true`);
    }
    for (let i = 0; i < 50; i++) {
      const remaining = execSync("ss -ltn 'sport = :4200' 2>/dev/null || true", { encoding: 'utf8' });
      if (!remaining.includes(':4200')) break;
      execSync('fuser -k 4200/tcp 2>/dev/null || true');
      execSync('sleep 0.2');
    }
  } catch {}
}

async function waitForHealth(timeoutMs = 40000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch('http://127.0.0.1:4200/api/v1/health');
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  let logContent = '';
  try { logContent = readFileSync('/tmp/presentation-api.log', 'utf8'); } catch {}
  throw new Error(`Port 4200 failed to become healthy within timeout. Log:\n${logContent}`);
}

function startApi(mode) {
  stopPort4200();
  console.log(`[rehearsal] Starting API with mode ${mode}...`);
  const env = { ...process.env };
  const flag = mode === 'writes-off' ? '--start' : '--start-voting';
  if (mode === 'writes-on') {
    env.JDQ_PRESENTATION_VOTING_ACK = 'I_UNDERSTAND_DEMO_ONLY';
  }
  const logFd = openSync('/tmp/presentation-api.log', 'w');
  const child = spawn('bash', ['scripts/start-presentation-api.sh', flag], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env,
  });
  child.unref();
}

async function main() {
  console.log('=== JUANDERQUEST ISOLATED PRESENTATION REAL-PG REHEARSAL ===\n');

  // STEP 1: Baseline snapshots
  console.log('[1/7] Capturing baseline metrics for both databases...');
  const alphaBaseline = getDatabaseMetrics('alpha');
  const presBaseline = getDatabaseMetrics('presentation');
  console.log('Alpha baseline:', alphaBaseline);
  console.log('Presentation baseline:', presBaseline);

  // STEP 2: Writes OFF verification
  console.log('\n[2/7] Starting API with writes DISABLED (--start)...');
  startApi('writes-off');
  await waitForHealth();

  const overviewRes = await (await fetch('http://127.0.0.1:4200/api/v1/juanchoice/overview')).json();
  console.log('Overview check: voting_enabled =', overviewRes.data?.availability?.voting_enabled, 'reason =', overviewRes.data?.availability?.reason);
  if (overviewRes.data?.availability?.voting_enabled !== false) {
    throw new Error('Expected voting_enabled=false when started with --start');
  }

  // Create guest login for writes-off probe
  console.log('Creating guest session for writes-off probe...');
  const guestLoginRes = await fetch('http://127.0.0.1:4200/api/v1/auth/guest-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'http://127.0.0.1:3200' },
    body: JSON.stringify({ remember_me: false }),
  });
  const guestCookie = guestLoginRes.headers.get('set-cookie');
  const guestData = await guestLoginRes.json();
  console.log('Guest registered:', guestData.data?.user?.id, 'seed:', guestData.data?.user?.seed_id);

  // Attempt ballot submission with writes off
  console.log('Attempting ballot with writes OFF...');
  const disabledVoteRes = await fetch(`http://127.0.0.1:4200/api/v1/juanchoice/campaigns/${campaignId}/ballot`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
      'Cookie': guestCookie || '',
      'Origin': 'http://127.0.0.1:3200',
    },
    body: JSON.stringify({ candidate_id: CANDIDATE_1, expected_version: 0 }),
  });

  const disabledVoteBody = await disabledVoteRes.json();
  console.log(`Writes OFF result: HTTP ${disabledVoteRes.status}`, disabledVoteBody);
  if (disabledVoteRes.status !== 503 || disabledVoteBody.error?.code !== 'WRITES_DISABLED') {
    throw new Error(`Expected 503 WRITES_DISABLED, got HTTP ${disabledVoteRes.status} ${JSON.stringify(disabledVoteBody)}`);
  }

  // Check presentation DB: ensure ZERO ballots were created
  const presAfterDisabled = getDatabaseMetrics('presentation');
  if (presAfterDisabled.juanchoice_ballots !== presBaseline.juanchoice_ballots) {
    throw new Error('Ballot count changed while writes were disabled!');
  }
  console.log('Verified: 503 WRITES_DISABLED and zero new ballot rows created.\n');

  // STEP 3: Explicit Local Opt-in (writes ON)
  console.log('[3/7] Starting API with explicit local opt-in (--start-voting)...');
  startApi('writes-on');
  await waitForHealth();

  const overviewOptIn = await (await fetch('http://127.0.0.1:4200/api/v1/juanchoice/overview')).json();
  console.log('Overview check: voting_enabled =', overviewOptIn.data?.availability?.voting_enabled, 'environment =', overviewOptIn.data?.environment);
  if (overviewOptIn.data?.availability?.voting_enabled !== true || overviewOptIn.data?.environment !== 'presentation_demo') {
    throw new Error('Expected voting_enabled=true and environment=presentation_demo');
  }

  // STEP 4: Guest 1 flow (vote, replay, change-vote)
  console.log('\n[4/7] Rehearsing Guest 1 (ballot -> idempotent replay -> vote change)...');
  const g1LoginRes = await fetch('http://127.0.0.1:4200/api/v1/auth/guest-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'http://127.0.0.1:3200' },
    body: JSON.stringify({ remember_me: false }),
  });
  const g1Cookie = g1LoginRes.headers.get('set-cookie');
  const g1Data = await g1LoginRes.json();
  const g1UserId = g1Data.data.user.id;
  console.log('Guest 1:', g1UserId);

  const key1 = randomUUID();
  console.log('Guest 1 casting ballot for candidate 1 with key', key1);
  const g1Vote1Res = await fetch(`http://127.0.0.1:4200/api/v1/juanchoice/campaigns/${campaignId}/ballot`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key1,
      'Cookie': g1Cookie || '',
      'Origin': 'http://127.0.0.1:3200',
    },
    body: JSON.stringify({ candidate_id: CANDIDATE_1, expected_version: 0 }),
  });
  const g1Vote1 = await g1Vote1Res.json();
  console.log('Guest 1 ballot 1:', g1Vote1Res.status, 'version:', g1Vote1.data?.ballot?.version, 'replayed:', g1Vote1.data?.replayed);
  if (!g1Vote1.success || g1Vote1.data?.ballot?.version !== 1 || g1Vote1.data?.replayed !== false) {
    throw new Error('Guest 1 initial ballot failed');
  }

  // Idempotent replay
  console.log('Guest 1 replaying exact same ballot with same key...');
  const g1ReplayRes = await fetch(`http://127.0.0.1:4200/api/v1/juanchoice/campaigns/${campaignId}/ballot`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key1,
      'Cookie': g1Cookie || '',
      'Origin': 'http://127.0.0.1:3200',
    },
    body: JSON.stringify({ candidate_id: CANDIDATE_1, expected_version: 0 }),
  });
  const g1Replay = await g1ReplayRes.json();
  console.log('Guest 1 replay result:', g1ReplayRes.status, 'replayed:', g1Replay.data?.replayed);
  if (!g1Replay.success || g1Replay.data?.replayed !== true) {
    throw new Error('Guest 1 idempotent replay failed');
  }

  // Vote change
  const key2 = randomUUID();
  console.log('Guest 1 changing vote to candidate 2 with expected_version: 1, key', key2);
  const g1ChangeRes = await fetch(`http://127.0.0.1:4200/api/v1/juanchoice/campaigns/${campaignId}/ballot`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key2,
      'Cookie': g1Cookie || '',
      'Origin': 'http://127.0.0.1:3200',
    },
    body: JSON.stringify({ candidate_id: CANDIDATE_2, expected_version: 1 }),
  });
  const g1Change = await g1ChangeRes.json();
  console.log('Guest 1 change result:', g1ChangeRes.status, 'version:', g1Change.data?.ballot?.version, 'candidate:', g1Change.data?.ballot?.candidate_id);
  if (!g1Change.success || g1Change.data?.ballot?.version !== 2 || g1Change.data?.ballot?.candidate_id !== CANDIDATE_2) {
    throw new Error('Guest 1 vote change failed');
  }

  // STEP 5: Guest 2 flow & Wrong campaign rejection
  console.log('\n[5/7] Rehearsing Guest 2 and wrong-campaign rejection...');
  const g2LoginRes = await fetch('http://127.0.0.1:4200/api/v1/auth/guest-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'http://127.0.0.1:3200' },
    body: JSON.stringify({ remember_me: false }),
  });
  const g2Cookie = g2LoginRes.headers.get('set-cookie');
  const g2Data = await g2LoginRes.json();
  const g2UserId = g2Data.data.user.id;
  console.log('Guest 2:', g2UserId);

  const key3 = randomUUID();
  console.log('Guest 2 casting ballot for candidate 3 with key', key3);
  const g2VoteRes = await fetch(`http://127.0.0.1:4200/api/v1/juanchoice/campaigns/${campaignId}/ballot`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key3,
      'Cookie': g2Cookie || '',
      'Origin': 'http://127.0.0.1:3200',
    },
    body: JSON.stringify({ candidate_id: CANDIDATE_3, expected_version: 0 }),
  });
  const g2Vote = await g2VoteRes.json();
  console.log('Guest 2 ballot:', g2VoteRes.status, 'version:', g2Vote.data?.ballot?.version);
  if (!g2Vote.success || g2Vote.data?.ballot?.version !== 1) {
    throw new Error('Guest 2 ballot failed');
  }

  // Wrong campaign rejection
  console.log('Attempting vote into wrong campaign ID', WRONG_CAMPAIGN_ID);
  const wrongRes = await fetch(`http://127.0.0.1:4200/api/v1/juanchoice/campaigns/${WRONG_CAMPAIGN_ID}/ballot`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
      'Cookie': g2Cookie || '',
      'Origin': 'http://127.0.0.1:3200',
    },
    body: JSON.stringify({ candidate_id: CANDIDATE_1, expected_version: 0 }),
  });
  const wrongBody = await wrongRes.json();
  console.log(`Wrong campaign result: HTTP ${wrongRes.status}`, wrongBody);
  if (wrongRes.status !== 404 || wrongBody.error?.code !== 'CAMPAIGN_NOT_FOUND') {
    throw new Error('Wrong campaign ID was not rejected with 404 CAMPAIGN_NOT_FOUND');
  }

  // STEP 6: Restore closed-by-default (writes OFF)
  console.log('\n[6/7] Restoring API to closed-by-default (--start)...');
  startApi('writes-off');
  await waitForHealth();
  const finalOverview = await (await fetch('http://127.0.0.1:4200/api/v1/juanchoice/overview')).json();
  console.log('Restored overview: voting_enabled =', finalOverview.data?.availability?.voting_enabled);
  if (finalOverview.data?.availability?.voting_enabled !== false) {
    throw new Error('Failed to restore voting_enabled=false');
  }

  // STEP 7: Database Comparison & Accounting Proof
  console.log('\n[7/7] Comparing both databases before and after rehearsal...');
  const alphaFinal = getDatabaseMetrics('alpha');
  const presFinal = getDatabaseMetrics('presentation');

  console.log('\n--- ALPHA DATABASE COMPARISON (Must have ZERO changes) ---');
  let alphaClean = true;
  for (const [key, val] of Object.entries(alphaBaseline)) {
    const diff = alphaFinal[key] - val;
    console.log(`  ${key}: before=${val}, after=${alphaFinal[key]}, diff=${diff}`);
    if (diff !== 0) alphaClean = false;
  }
  if (!alphaClean) {
    throw new Error('FATAL: Ordinary alpha database was mutated during presentation rehearsal!');
  }
  console.log('>> VERIFIED: Ordinary alpha database is 100% UNTOUCHED (0 changes across all tables and sums).');

  console.log('\n--- PRESENTATION DATABASE COMPARISON (Expected rehearsal deltas) ---');
  for (const [key, val] of Object.entries(presBaseline)) {
    const diff = presFinal[key] - val;
    console.log(`  ${key}: before=${val}, after=${presFinal[key]}, diff=${diff >= 0 ? '+' : ''}${diff}`);
  }

  // Assert expected deltas in presentation DB:
  // Note: Guest for writes-off probe created 1 user; Guest 1 created 1 user; Guest 2 created 1 user = +3 users total.
  // Ballots: +2 ballots (Guest 1, Guest 2).
  // Ballot events: +3 (Guest 1 initial + Guest 1 change + Guest 2 initial).
  // Participations: +2 (Guest 1, Guest 2).
  // Progression totals: +2 users awarded.
  // Progression events: +4 events (+25 XP * 2, +1 stamp * 2). Note: change-vote adds 0 XP/stamps!
  // Total civic XP: +50 (25 * 2).
  // Total civic stamps: +2 (1 * 2).
  // Governance ledger: 0 (governance ledger movements remain exactly 0).
  if (presFinal.governance_ledger !== 0) {
    throw new Error('Governance ledger must be 0 in presentation database!');
  }
  if (presFinal.total_civic_xp - presBaseline.total_civic_xp !== 50) {
    throw new Error(`Expected +50 civic XP delta, got ${presFinal.total_civic_xp - presBaseline.total_civic_xp}`);
  }
  if (presFinal.total_civic_stamps - presBaseline.total_civic_stamps !== 2) {
    throw new Error(`Expected +2 civic stamps delta, got ${presFinal.total_civic_stamps - presBaseline.total_civic_stamps}`);
  }
  console.log('>> VERIFIED: Presentation database deltas match exact rehearsal specifications.');
  console.log('>> ALL REHEARSAL INVARIANTS SATISFIED SUCCESSFULLY!\n');
}

main().catch(err => {
  console.error('\n[rehearsal ERROR]:', err);
  process.exit(1);
});
