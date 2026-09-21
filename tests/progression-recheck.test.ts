import { randomUUID } from 'crypto';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { progressionRepo } from '../src/progression/repository.js';

describe('Phase 1 independent remediation recheck', () => {
  let database: TestDbInstance;
  beforeAll(async () => { database = await createTestDb(); });
  afterAll(async () => { await database.close(); });

  it('does not let an earlier invocation acknowledge a newer claim with the same worker name', async () => {
    const id = randomUUID();
    await database.pool.query(`INSERT INTO outbox_events
      (id,event_key,event_type,payload,status,next_attempt_at)
      VALUES ($1,$2,'submission_approved_unresolved','{}','pending','2020-01-01T00:00:00Z')`, [id,id]);
    const first = await progressionRepo.claimPendingOutboxEvents(1,30,'worker-reused',database.pool);
    expect(first[0].id).toBe(id);
    await database.pool.query("UPDATE outbox_events SET lease_expires_at = '2020-01-01T00:00:00Z' WHERE id = $1",[id]);
    const second = await progressionRepo.claimPendingOutboxEvents(1,30,'worker-reused',database.pool);
    expect(second[0].id).toBe(id);
    // Old invocation has only its worker name; current API cannot distinguish claims.
    expect(await progressionRepo.markOutboxCompleted(id,first[0].lease_owner!,database.pool)).toBe(false);
  });

  it('rejects a totals result outside the safe integer range even if each input is safe', async () => {
    const userId = randomUUID();
    await database.pool.query(`INSERT INTO users (id,seed_id,display_name,email,role)
      VALUES ($1,$2,'Recheck',$3,'user')`,[userId,userId,`${userId}@example.test`]);
    const client = await database.pool.connect();
    try {
      await progressionRepo.updateProgressionTotals(userId,{explorerXp:Number.MAX_SAFE_INTEGER},client);
      await expect(progressionRepo.updateProgressionTotals(userId,{explorerXp:1},client)).rejects.toThrow();
    } finally { client.release(); }
  });
});
