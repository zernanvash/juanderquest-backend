import { randomUUID } from 'crypto';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { progressionRepo } from '../src/progression/repository.js';
import { progressionService } from '../src/progression/service.js';
import { submissionsService } from '../src/services/submissions.js';
import { governanceStore } from '../src/routes/proposals.js';
import { db } from '../src/db/index.js';

// Independent Phase 1 acceptance regressions. Intentionally expose unresolved defects.
describe('Independent progression Phase 1 review', () => {
  let database: TestDbInstance;
  beforeAll(async () => {
    database = await createTestDb();
    setPool(database.pool);
  });
  afterAll(async () => {
    setPool(null);
    await database.close();
  });

  it('reclaims a processing event after its worker lease expires', async () => {
    const id = randomUUID();
    await database.pool.query(`INSERT INTO outbox_events
      (id,event_key,event_type,payload,status,lease_owner,lease_expires_at,next_attempt_at)
      VALUES ($1,$2,'submission_approved_unresolved','{}','processing','dead-worker',
        '2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')`, [id, id]);
    const claimed = await progressionRepo.claimPendingOutboxEvents(20, 30, 'replacement', database.pool);
    expect(claimed.some(event => event.id === id)).toBe(true);
  });

  it('seeds the 48 LGUs claimed by the passport denominator', async () => {
    const { rows } = await database.pool.query('SELECT id FROM municipalities');
    expect(rows).toHaveLength(48);
    expect(rows.map(row => row.id)).toEqual(expect.arrayContaining(['basista', 'binmaley']));
  });

  it('does not regrant the same source merely because rule_version changes', async () => {
    const userId = randomUUID();
    await database.pool.query(`INSERT INTO users (id,seed_id,display_name,email,role)
      VALUES ($1,$2,'Review Fixture',$3,'user')`, [userId, userId, `${userId}@example.test`]);
    const client = await database.pool.connect();
    try {
      const base = {user_id:userId,track:'explorer' as const,delta:50,source_type:'submission_approval',
        source_id:'same-proof',award_kind:'xp',earned_at:new Date().toISOString(),is_test:false};
      const first = await progressionRepo.recordProgressionEvent({...base,id:randomUUID(),rule_version:'v1'},client);
      const second = await progressionRepo.recordProgressionEvent({...base,id:randomUUID(),rule_version:'v2'},client);
      expect(first).not.toBeNull();
      expect(second).toBeNull();
    } finally { client.release(); }
  });

  // R1: Exhausted Expired Leases Reach Dead-Letter
  it('transitions exhausted expired processing events to dead_letter instead of becoming invisible', async () => {
    const exhaustedId = randomUUID();
    await database.pool.query(`INSERT INTO outbox_events
      (id, event_key, event_type, payload, status, lease_owner, lease_expires_at, next_attempt_at, attempts, max_attempts)
      VALUES ($1, $2, 'submission_approved_unresolved', '{}', 'processing', 'crashed-worker-max',
        '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', 5, 5)`,
      [exhaustedId, `exhausted-key-${exhaustedId}`]
    );

    const claimed = await progressionRepo.claimPendingOutboxEvents(10, 30, 'replacement-worker', database.pool);
    // Exhausted event must NOT be claimed
    expect(claimed.some(e => e.id === exhaustedId)).toBe(false);

    // Verify it transitioned to dead_letter
    const { rows } = await database.pool.query('SELECT status, last_error FROM outbox_events WHERE id = $1', [exhaustedId]);
    expect(rows[0].status).toBe('dead_letter');
    expect(rows[0].last_error).toContain('LEASE_EXPIRED_MAX_ATTEMPTS_EXCEEDED');
  });

  // R1: Worker Fencing & Stale Completion Protection
  it('prevents stale worker from completing an event after lease ownership expired and was reclaimed', async () => {
    const eventId = randomUUID();
    await database.pool.query(`INSERT INTO outbox_events
      (id, event_key, event_type, payload, status, lease_owner, lease_expires_at, next_attempt_at, attempts, max_attempts)
      VALUES ($1, $2, 'submission_approved_unresolved', '{}', 'processing', 'stale-worker',
        '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', 1, 5)`,
      [eventId, `fence-key-${eventId}`]
    );

    // Worker 2 reclaims the expired lease
    const claimed = await progressionRepo.claimPendingOutboxEvents(10, 30, 'worker-2', database.pool);
    expect(claimed.some(e => e.id === eventId)).toBe(true);
    const targetClaim = claimed.find(e => e.id === eventId)!;

    // Stale Worker 1 attempts to complete: returns false
    const staleResult = await progressionRepo.markOutboxCompleted(eventId, 'stale-worker', database.pool);
    expect(staleResult).toBe(false);

    // Stale Worker 1 attempts to fail: returns false
    const staleFailResult = await progressionRepo.markOutboxFailed(eventId, 'stale-worker', 'err', 10, database.pool);
    expect(staleFailResult).toBe(false);

    // Legitimate Worker 2 completes successfully: returns true
    const legitimateResult = await progressionRepo.markOutboxCompleted(eventId, targetClaim.lease_owner!, database.pool, targetClaim.claim_token);
    expect(legitimateResult).toBe(true);
  });

  // R1: Crash Recovery After Claim & Idempotent Reprocessing
  it('re-processes an event idempotently without duplicating visits or XP if worker crashes after claim', async () => {
    const userId = randomUUID();
    const subId = randomUUID();
    await database.pool.query(`INSERT INTO users (id, seed_id, display_name, email, role)
      VALUES ($1, $2, 'Crash Test User', $3, 'user')`, [userId, userId, `${userId}@example.test`]);
    await database.pool.query(`INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng, source_type, source_name, trust_level, status)
      VALUES ('spot-crash-1', 'spot-crash-1', 'Crash Spot', 'Desc', 'nature_outdoors', 'park', 'Alaminos City', 'Alaminos', 16.2, 119.9, 'lgu', 'Alaminos', 'lgu_verified', 'published')
      ON CONFLICT (id) DO NOTHING`);
    await database.pool.query(`INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url)
      VALUES ('quest-crash-1', 'Crash Quest', 'Desc', 'eco', 'Alaminos', 16.2, 119.9, 100, 50, 'MARKER_CRASH_1', '')
      ON CONFLICT (id) DO NOTHING`);
    const bindingId = randomUUID();
    await database.pool.query(`INSERT INTO reviewed_quest_spot_bindings (id, quest_id, spot_id, binding_version, status, is_test)
      VALUES ($1, 'quest-crash-1', 'spot-crash-1', 'v1', 'active', false)`, [bindingId]);
    await database.pool.query(`INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status)
      VALUES ($1, $2, $3, 'quest-crash-1', 'MARKER_CRASH_1', 16.2, 119.9, 5, 'approved')`,
      [subId, `sub-crash-${subId}`, userId]
    );

    const outboxId = randomUUID();
    await database.pool.query(`INSERT INTO outbox_events
      (id, event_key, event_type, payload, status, next_attempt_at, attempts, max_attempts)
      VALUES ($1, $2, 'submission_approved', $3, 'pending', NOW(), 0, 5)`,
      [
        outboxId,
        `approval-${outboxId}`,
        JSON.stringify({
          submission_id: subId,
          user_id: userId,
          quest_id: 'quest-crash-1',
          binding_id: bindingId,
          spot_id: 'spot-crash-1',
          municipality_id: 'alaminos_city',
          occurred_at: new Date().toISOString(),
          verified_at: new Date().toISOString(),
          is_test: false,
        }),
      ]
    );

    // First worker claims and processes
    const { processed: p1 } = await progressionService.processOutboxBatch(10, 'worker-crash-1');
    expect(p1).toBe(1);

    // Verify visit recorded and 50 XP awarded
    const { rows: visits1 } = await database.pool.query('SELECT * FROM verified_visits WHERE source_submission_id = $1', [subId]);
    expect(visits1).toHaveLength(1);
    const totals1 = await progressionRepo.getTotalsForUser(userId, database.pool);
    expect(totals1?.explorer_xp).toBe(50);

    // Simulate event reset to expired processing (as if worker crashed before final ACK)
    await database.pool.query(`UPDATE outbox_events
      SET status = 'processing', lease_owner = 'worker-crash-1', lease_expires_at = '2020-01-01T00:00:00Z', next_attempt_at = '2020-01-01T00:00:00Z'
      WHERE id = $1`, [outboxId]);

    // Replacement worker claims and re-processes
    const { processed: p2 } = await progressionService.processOutboxBatch(10, 'worker-crash-2');
    expect(p2).toBe(1);

    // Verify visit count remains 1 and XP remains 50 (NO duplicate awards)
    const { rows: visits2 } = await database.pool.query('SELECT * FROM verified_visits WHERE source_submission_id = $1', [subId]);
    expect(visits2).toHaveLength(1);
    const totals2 = await progressionRepo.getTotalsForUser(userId, database.pool);
    expect(totals2?.explorer_xp).toBe(50);
  });

  // R4: Scope Isolation: Real Totals Exclude Test Events
  it('excludes synthetic test progression events from real user totals during rebuild', async () => {
    const realUserId = randomUUID();
    await database.pool.query(`INSERT INTO users (id, seed_id, display_name, email, role, is_test)
      VALUES ($1, $2, 'Real User Scope Test', $3, 'user', FALSE)`, [realUserId, realUserId, `${realUserId}@example.test`]);

    const client = await database.pool.connect();
    try {
      // Record 1 real event (+50)
      await progressionRepo.recordProgressionEvent(
        {
          id: randomUUID(),
          user_id: realUserId,
          track: 'explorer',
          delta: 50,
          source_type: 'submission_approval',
          source_id: 'real-proof-1',
          award_kind: 'xp',
          rule_version: 'v1',
          earned_at: new Date().toISOString(),
          is_test: false,
        },
        client
      );

      // Record 1 test event (+100) on the same user
      await progressionRepo.recordProgressionEvent(
        {
          id: randomUUID(),
          user_id: realUserId,
          track: 'explorer',
          delta: 100,
          source_type: 'test_fixture',
          source_id: 'test-proof-1',
          award_kind: 'xp',
          rule_version: 'v1',
          earned_at: new Date().toISOString(),
          is_test: true,
        },
        client
      );

      // Rebuild totals for the real user
      const rebuilt = await progressionRepo.rebuildTotalsForUser(realUserId, client);
      // Must be EXACTLY 50, test event (+100) must be quarantined!
      expect(rebuilt.explorer_xp).toBe(50);
    } finally {
      client.release();
    }
  });

  // Rollback Verification: Approval Outbox Failure Injection
  it('rolls back submission status, user demo_points, and governance ledger if outbox insertion fails', async () => {
    const testAdminId = randomUUID();
    const testTravelerId = randomUUID();
    const testQuestId = randomUUID();
    const testSubId = randomUUID();

    await database.pool.query(`INSERT INTO users (id, seed_id, display_name, email, role, demo_points) VALUES
      ($1, $2, 'Admin Rollback', $3, 'admin', 500),
      ($4, $5, 'Traveler Rollback', $6, 'user', 0)
      ON CONFLICT (id) DO NOTHING`,
      [testAdminId, testAdminId, `${testAdminId}@test.ph`, testTravelerId, testTravelerId, `${testTravelerId}@test.ph`]
    );

    await database.pool.query(`INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url)
      VALUES ($1, 'Rollback Quest', 'Desc', 'eco', 'Alaminos', 16.2, 119.9, 100, 75, $2, '')
      ON CONFLICT (id) DO NOTHING`,
      [testQuestId, `MK_ROLLBACK_${testQuestId}`]
    );

    await database.pool.query(`INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status)
      VALUES ($1, $2, $3, $4, $5, 16.2, 119.9, 5, 'pending')`,
      [testSubId, `sub-key-${testSubId}`, testTravelerId, testQuestId, `MK_ROLLBACK_${testQuestId}`]
    );

    // Spy on recordApprovalOutboxEvent to simulate database failure during outbox insertion
    const spy = jest.spyOn(progressionService, 'recordApprovalOutboxEvent').mockRejectedValueOnce(
      new Error('INJECTED_OUTBOX_DISK_FAILURE')
    );

    await expect(
      submissionsService.reviewSubmission(testSubId, 'approve', testAdminId)
    ).rejects.toThrow('INJECTED_OUTBOX_DISK_FAILURE');

    spy.mockRestore();

    // 1. In-memory submission status MUST still be pending (not approved)
    const memSub = db.submissions.find((s) => s.id === testSubId);
    if (memSub) {
      expect(memSub.status).toBe('pending');
    }

    // 2. User demo_points in memory MUST remain 0
    const memUser = db.findUserById(testTravelerId);
    if (memUser) {
      expect(memUser.demo_points).toBe(0);
    }

    // 3. In-memory governance ledger MUST NOT have published entries
    const unpublishedEntries = governanceStore.getLedger().filter((e) => e.reference_id === testSubId);
    expect(unpublishedEntries).toHaveLength(0);

    // 4. Real PostgreSQL MVCC rollback assertions (when JDQ_REAL_PG_URL is set)
    if (process.env.JDQ_REAL_PG_URL) {
      const { rows: subRows } = await database.pool.query('SELECT status FROM submissions WHERE id = $1', [testSubId]);
      expect(subRows[0].status).toBe('pending');

      const { rows: userRows } = await database.pool.query('SELECT demo_points FROM users WHERE id = $1', [testTravelerId]);
      expect(userRows[0].demo_points).toBe(0);

      const { rows: govRows } = await database.pool.query(
        "SELECT * FROM governance_ledger WHERE reference_type = 'submission' AND reference_id = $1",
        [testSubId]
      );
      expect(govRows).toHaveLength(0);
    }

    // 5. Outbox events table MUST contain no entry
    const { rows: outboxRows } = await database.pool.query(
      'SELECT * FROM outbox_events WHERE event_key = $1',
      [`submission_approval_${testSubId}`]
    );
    expect(outboxRows).toHaveLength(0);
  });
});
