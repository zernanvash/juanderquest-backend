import { createHash, randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { db } from '../db/index.js';
import { governanceStore } from '../routes/proposals.js';
import { lockGovernanceSnapshot, commitGovernanceTransaction } from '../governance/transaction.js';
import { movePoints, type MovePointsInput, type CommittedLedgerGroup } from './ledger.js';

export class FundingError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

export interface FundingTx {
  client: PoolClient;
  groups: CommittedLedgerGroup[];
  transfer(input: MovePointsInput): Promise<CommittedLedgerGroup>;
}

export function fundingTx(client: PoolClient): FundingTx {
  const groups: CommittedLedgerGroup[] = [];
  return { client, groups, transfer: async input => {
    const group = await movePoints(client, input);
    groups.push(group);
    return group;
  } };
}

export function publishFunding(groups: CommittedLedgerGroup[]): void {
  for (const group of groups) {
    governanceStore.publishCommittedTransaction(group);
    const update = group.userBalanceUpdate;
    const user = update && db.users.find(row => row.id === update.userId);
    if (user && update) user.demo_points = update.demoPoints;
  }
}

export async function fundingCommand<T>(pool: Pool, actorId: string, operation: string, key: string,
  payload: unknown, command: (tx: FundingTx) => Promise<T>): Promise<T & { replayed: boolean }> {
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const client = await pool.connect();
  const tx = fundingTx(client);
  try {
    await client.query('BEGIN');
    await lockGovernanceSnapshot(client);
    const previous = await client.query(
      'SELECT request_hash, response FROM quest_funding_commands WHERE actor_id=$1 AND operation=$2 AND idempotency_key=$3',
      [actorId, operation, key]);
    if (previous.rows[0]) {
      if (previous.rows[0].request_hash !== hash) throw new FundingError('IDEMPOTENCY_CONFLICT', 409, 'This key was already used with different terms.');
      await commitGovernanceTransaction(client);
      return { ...previous.rows[0].response, replayed: true };
    }
    const result = await command(tx);
    const audit = { id: randomUUID(), action: operation, actor_id: actorId, subject_type: 'quest_funding_command',
      subject_id: String((result as any)?.id ?? (payload as any)?.id ?? (payload as any)?.questId ?? key),
      metadata: { idempotency_key: key, request: payload }, created_at: new Date().toISOString() };
    await client.query('INSERT INTO governance_audit(id,action,actor_id,subject_type,subject_id,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',
      [audit.id,audit.action,actorId,audit.subject_type,audit.subject_id,JSON.stringify(audit.metadata),audit.created_at]);
    const snapshot = (await client.query('SELECT data FROM governance_snapshot WHERE id=1')).rows[0].data;
    snapshot.audit = [...(snapshot.audit || []), audit];
    await client.query('UPDATE governance_snapshot SET data=$1,updated_at=NOW() WHERE id=1',[JSON.stringify(snapshot)]);
    tx.groups.push({ entries: [], audit: [audit] });
    await client.query(
      'INSERT INTO quest_funding_commands(actor_id,operation,idempotency_key,request_hash,response) VALUES($1,$2,$3,$4,$5::jsonb)',
      [actorId, operation, key, hash, JSON.stringify(result)]);
    await commitGovernanceTransaction(client);
    publishFunding(tx.groups);
    return { ...result, replayed: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
