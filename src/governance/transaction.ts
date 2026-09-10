import type { GovernanceStore } from './store.js';

type Client = { query: (sql: string, params?: any[]) => Promise<any> };

// Must be acquired before user/submission locks by every accounting writer.
// A missing singleton is a migration/readiness failure, never a memory fallback.
export async function lockGovernanceSnapshot(client: Client): Promise<ReturnType<GovernanceStore['snapshot']>> {
  const result = await client.query('SELECT data FROM governance_snapshot WHERE id = 1 FOR UPDATE');
  if (!result.rows?.[0]?.data) throw new Error('GOVERNANCE_SNAPSHOT_MISSING');
  const snapshot = structuredClone(result.rows[0].data);
  // Migration 011 creates an empty baseline. Initialize opening circulation once,
  // under the same lock and before the caller changes any balance.
  if (!snapshot.ledger?.length && !Object.keys(snapshot.balances || {}).length && !snapshot.issuedMjdq) {
    const { rows } = await client.query('SELECT id, demo_points FROM users');
    snapshot.balances = Object.fromEntries(rows.map((user: any) => [user.id, Number(user.demo_points) * 1000]));
    snapshot.issuedMjdq = rows.reduce((sum: number, user: any) => sum + Number(user.demo_points) * 1000, 0);
    await client.query('UPDATE governance_snapshot SET data = $1, updated_at = NOW() WHERE id = 1', [JSON.stringify(snapshot)]);
  }
  return snapshot;
}

// Preserve sub-point mJDQ from payouts; demo_points is the whole-point projection.
export function authoritativeBalance(points: number, previousMjdq = 0): number {
  const balance = Number(points) * 1000 + previousMjdq % 1000;
  if (!Number.isSafeInteger(balance) || balance < 0) throw new Error('INVALID_GOVERNANCE_BALANCE');
  return balance;
}

export async function commitGovernanceTransaction(client: Client): Promise<void> {
  const result = await client.query('COMMIT');
  if (result?.command !== 'COMMIT') throw new Error(`TRANSACTION_ABORTED: commit returned ${result?.command}`);
}
