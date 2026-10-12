import { createHash, randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';

const MAX_ATTEMPTS = 5;

export interface EconomicOutboxClaim {
  id: string;
  transactionId: string;
  eventType: string;
  payload: unknown;
  leaseOwner: string;
  claimToken: string;
  attempts: number;
}

async function transaction<T>(pool: Pool, task: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await task(client);
    const commit = await client.query('COMMIT');
    if (commit.command !== 'COMMIT') throw new Error('ECONOMIC_OUTBOX_COMMIT_ABORTED');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export class EconomicOutboxService {
  constructor(private readonly pool: Pool) {}

  async claimBatch(workerId: string, batchSize = 20, leaseSeconds = 30): Promise<EconomicOutboxClaim[]> {
    if (!workerId || workerId.length > 100 || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100 ||
        !Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300) {
      throw new Error('INVALID_ECONOMIC_OUTBOX_CLAIM');
    }
    return transaction(this.pool, async (client) => {
      const due = await client.query(
        `SELECT id, transaction_id, event_type, payload, attempts FROM economic_outbox
         WHERE ((status IN ('pending','failed') AND next_attempt_at <= clock_timestamp())
           OR (status = 'processing' AND lease_expires_at <= clock_timestamp()))
         ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT $1`, [batchSize]
      );
      const claims: EconomicOutboxClaim[] = [];
      for (const row of due.rows) {
        if (Number(row.attempts) >= MAX_ATTEMPTS) {
          await client.query(
            `UPDATE economic_outbox SET status = 'dead_letter', dead_letter_at = clock_timestamp(),
             last_error = 'MAX_ATTEMPTS_EXCEEDED', lease_owner = NULL,
             claim_token = NULL, lease_expires_at = NULL WHERE id = $1`, [row.id]
          );
          continue;
        }
        const claimToken = randomUUID();
        await client.query(
          `UPDATE economic_outbox SET status = 'processing', lease_owner = $2,
           claim_token = $3::uuid, lease_expires_at = clock_timestamp() + ($4::int * interval '1 second'),
           attempts = attempts + 1, last_error = NULL WHERE id = $1`,
          [row.id, workerId, claimToken, leaseSeconds]
        );
        claims.push({ id: row.id, transactionId: row.transaction_id, eventType: row.event_type,
          payload: row.payload, leaseOwner: workerId, claimToken, attempts: Number(row.attempts) + 1 });
      }
      return claims;
    });
  }

  // The local consumer receipt is the one durable downstream effect. No
  // external notification or chain action is implied by this operation.
  async complete(claim: EconomicOutboxClaim, consumerKey: string): Promise<boolean> {
    if (!consumerKey || consumerKey.length > 100) throw new Error('INVALID_ECONOMIC_OUTBOX_CONSUMER');
    return transaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT id, payload FROM economic_outbox
         WHERE id = $1 AND status = 'processing' AND lease_owner = $2
           AND claim_token = $3::uuid AND lease_expires_at > clock_timestamp()
         FOR UPDATE`, [claim.id, claim.leaseOwner, claim.claimToken]
      );
      if (!locked.rowCount) return false;
      const effectHash = createHash('sha256').update(JSON.stringify(locked.rows[0].payload)).digest('hex');
      await client.query(
        `INSERT INTO economic_outbox_receipts(id,outbox_id,consumer_key,effect_hash)
         VALUES ($1,$2,$3,$4) ON CONFLICT (outbox_id,consumer_key) DO NOTHING`,
        [randomUUID(), claim.id, consumerKey, effectHash]
      );
      const completed = await client.query(
        `UPDATE economic_outbox SET status = 'completed', delivered_at = clock_timestamp(),
         lease_owner = NULL, claim_token = NULL, lease_expires_at = NULL
         WHERE id = $1 AND status = 'processing' AND lease_owner = $2
           AND claim_token = $3::uuid AND lease_expires_at > clock_timestamp()`,
        [claim.id, claim.leaseOwner, claim.claimToken]
      );
      if (completed.rowCount !== 1) throw new Error('ECONOMIC_OUTBOX_FENCE_LOST');
      return true;
    });
  }

  async fail(claim: EconomicOutboxClaim, reason: string): Promise<boolean> {
    if (!reason.trim()) throw new Error('ECONOMIC_OUTBOX_FAILURE_REASON_REQUIRED');
    const retrySeconds = Math.min(300, 2 ** Math.min(claim.attempts, 8));
    const result = await this.pool.query(
      `UPDATE economic_outbox SET
         status = CASE WHEN attempts >= $4 THEN 'dead_letter' ELSE 'failed' END,
         dead_letter_at = CASE WHEN attempts >= $4 THEN clock_timestamp() ELSE NULL END,
         next_attempt_at = clock_timestamp() + ($5::int * interval '1 second'),
         last_error = $6, lease_owner = NULL, claim_token = NULL, lease_expires_at = NULL
       WHERE id = $1 AND status = 'processing' AND lease_owner = $2
         AND claim_token = $3::uuid AND lease_expires_at > clock_timestamp()`,
      [claim.id, claim.leaseOwner, claim.claimToken, MAX_ATTEMPTS, retrySeconds, reason.slice(0, 500)]
    );
    return result.rowCount === 1;
  }
}
