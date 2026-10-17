import { randomUUID } from 'crypto';
import { MJDQ_PER_JDQ, type AuditEvent, type LedgerEntry } from '../governance/store.js';

export interface FundingLedgerClient {
  query(text: string, params?: unknown[]): Promise<any>;
}

export interface PointAccountRef {
  id: string;
  /** Only `issuance` accounts may go negative. */
  kind: 'merchant' | 'quest_budget' | 'quest_hold' | 'treasury' | 'issuance' | 'traveler';
  userId?: string;
}

export interface MovePointsInput {
  from: PointAccountRef;
  to: PointAccountRef;
  points: number;
  type: string;
  referenceType: string;
  referenceId: string;
  actorId: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  reason?: string;
}

export interface CommittedLedgerGroup {
  entries: LedgerEntry[];
  audit: AuditEvent[];
  userBalanceUpdate?: { userId: string; demoPoints: number; previousDemoPoints: number; balanceDeltaMjdq: number; balanceMjdq?: number };
}

function validate(input: MovePointsInput): number {
  if (input.from.id === input.to.id) throw new Error('FUNDING_LEDGER_SAME_ACCOUNT');
  if (!Number.isSafeInteger(input.points) || input.points <= 0 || !Number.isSafeInteger(input.points * MJDQ_PER_JDQ)) {
    throw new Error('INVALID_FUNDING_POINTS');
  }
  if ((input.from.kind === 'traveler' && !input.from.userId) || (input.to.kind === 'traveler' && !input.to.userId)) {
    throw new Error('FUNDING_LEDGER_TRAVELER_ID_REQUIRED');
  }
  if ((input.from.kind === 'traveler' && input.from.id !== input.from.userId) ||
      (input.to.kind === 'traveler' && input.to.id !== input.to.userId)) {
    throw new Error('FUNDING_LEDGER_TRAVELER_ACCOUNT_MISMATCH');
  }
  return input.points * MJDQ_PER_JDQ;
}

async function updateSnapshot(client: FundingLedgerClient, group: CommittedLedgerGroup): Promise<void> {
  const result = await client.query('SELECT data FROM governance_snapshot WHERE id = 1');
  const snapshot = result.rows?.[0]?.data;
  if (!snapshot) throw new Error('GOVERNANCE_SNAPSHOT_MISSING');
  snapshot.ledger = [...(snapshot.ledger || []), ...group.entries];
  snapshot.audit = [...(snapshot.audit || []), ...group.audit];
  if (group.userBalanceUpdate) {
    const { userId, demoPoints, previousDemoPoints, balanceDeltaMjdq } = group.userBalanceUpdate;
    const hasPriorLedgerBalance = Object.prototype.hasOwnProperty.call(snapshot.balances || {}, userId);
    const previous = hasPriorLedgerBalance ? Number(snapshot.balances[userId]) : previousDemoPoints * MJDQ_PER_JDQ;
    const balanceMjdq = previous + balanceDeltaMjdq;
    group.userBalanceUpdate.balanceMjdq = balanceMjdq;
    snapshot.balances = { ...(snapshot.balances || {}), [userId]: balanceMjdq };
  }
  await client.query('UPDATE governance_snapshot SET data = $1, updated_at = NOW() WHERE id = 1', [JSON.stringify(snapshot)]);
}

/**
 * The single durable point-transfer primitive for funded quests and merchant
 * points. Callers must acquire the governance snapshot lock before invoking it.
 * It locks all non-traveler accounts in stable ID order, updates account/user
 * projections, writes one balanced mJDQ ledger group, and appends its audit row.
 */
export async function movePoints(client: FundingLedgerClient, input: MovePointsInput): Promise<CommittedLedgerGroup> {
  const amountMjdq = validate(input);
  const accountRefs = [input.from, input.to].filter((account) => account.kind !== 'traveler');
  const accountIds = [...new Set(accountRefs.map((account) => account.id))].sort();
  if (accountIds.length) {
    const accounts = await client.query(
      'SELECT id, kind, balance_points, is_test FROM points_accounts WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE',
      [accountIds],
    );
    if (accounts.rows.length !== accountIds.length) throw new Error('FUNDING_ACCOUNT_NOT_FOUND');
    const rows = new Map<string, { kind: string; balance: number }>(accounts.rows.map((row: any) => [row.id, { kind: row.kind, balance: Number(row.balance_points) }]));
    if (new Set(accounts.rows.map((row: any) => Boolean(row.is_test))).size > 1) throw new Error('SCOPE_MISMATCH');
    for (const account of accountRefs) {
      const row = rows.get(account.id)!;
      if (row.kind !== account.kind) throw new Error('FUNDING_ACCOUNT_KIND_MISMATCH');
      if (!Number.isSafeInteger(row.balance)) throw new Error('FUNDING_ACCOUNT_OVERFLOW');
    }
    for (const account of accountRefs) {
      const delta = account.id === input.from.id ? -input.points : input.points;
      const row = rows.get(account.id)!;
      const next = row.balance + delta;
      if (!Number.isSafeInteger(next) || (row.kind !== 'issuance' && next < 0)) throw new Error('INSUFFICIENT_FUNDING_BALANCE');
      await client.query('UPDATE points_accounts SET balance_points = $2, updated_at = NOW() WHERE id = $1', [account.id, next]);
    }
  }

  let userBalanceUpdate: CommittedLedgerGroup['userBalanceUpdate'];
  const travelerRefs = [input.from, input.to].filter((account) => account.kind === 'traveler');
  const travelerIds = [...new Set(travelerRefs.map((account) => account.userId!))].sort();
  if (travelerIds.length > 1) throw new Error('FUNDING_LEDGER_MULTIPLE_TRAVELERS_UNSUPPORTED');
  if (travelerIds.length) {
    const locked = await client.query('SELECT id, demo_points, is_test FROM users WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [travelerIds]);
    if (locked.rows.length !== travelerIds.length) throw new Error('USER_NOT_FOUND');
    const scope = await client.query('SELECT is_test FROM points_accounts WHERE id=$1', [accountIds[0]]);
    if (locked.rows.some((row: any) => Boolean(row.is_test) !== Boolean(scope.rows[0]?.is_test))) throw new Error('SCOPE_MISMATCH');
    const balances = new Map<string, number>(locked.rows.map((row: any) => [row.id, Number(row.demo_points)]));
    for (const account of travelerRefs) {
      const userId = account.userId!;
      const delta = account.id === input.from.id ? -input.points : input.points;
      const previousDemoPoints = balances.get(userId)!;
      const next = previousDemoPoints + delta;
      if (!Number.isSafeInteger(next) || next < 0) throw new Error('INSUFFICIENT_TRAVELER_POINTS');
      await client.query('UPDATE users SET demo_points = $2, updated_at = NOW() WHERE id = $1', [userId, next]);
      balances.set(userId, next);
      userBalanceUpdate = { userId, demoPoints: next, previousDemoPoints, balanceDeltaMjdq: delta * MJDQ_PER_JDQ };
    }
  }

  const groupId = randomUUID();
  const createdAt = new Date().toISOString();
  const entryBase = {
    transaction_group_id: groupId,
    type: input.type,
    reference_type: input.referenceType,
    reference_id: input.referenceId,
    actor_id: input.actorId,
    ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
    created_at: createdAt,
  };
  const entries = [
    { ...entryBase, id: randomUUID(), account: input.from.id, amount_mjdq: -amountMjdq, metadata: { ...(input.metadata || {}), counterparty: input.to.id } },
    { ...entryBase, id: randomUUID(), account: input.to.id, amount_mjdq: amountMjdq, metadata: { ...(input.metadata || {}), counterparty: input.from.id } },
  ];
  await client.query(
    `INSERT INTO governance_ledger
       (id, transaction_group_id, type, account, amount_mjdq, reference_type, reference_id, actor_id, idempotency_key, metadata, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11), ($12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22)`,
    [entries[0].id, groupId, input.type, input.from.id, -amountMjdq, input.referenceType, input.referenceId, input.actorId, input.idempotencyKey ?? null, JSON.stringify(entries[0].metadata), createdAt,
      entries[1].id, groupId, input.type, input.to.id, amountMjdq, input.referenceType, input.referenceId, input.actorId, input.idempotencyKey ?? null, JSON.stringify(entries[1].metadata), createdAt],
  );
  const audit = {
    id: randomUUID(), action: input.type, actor_id: input.actorId,
    subject_type: input.referenceType, subject_id: input.referenceId,
    ...(input.reason ? { reason: input.reason } : {}),
    metadata: { ...(input.metadata || {}), from: input.from.id, to: input.to.id, points: input.points }, created_at: createdAt,
  };
  await client.query(
    `INSERT INTO governance_audit (id, action, actor_id, subject_type, subject_id, reason, metadata, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [audit.id, audit.action, audit.actor_id, audit.subject_type, audit.subject_id, input.reason ?? null, JSON.stringify(audit.metadata), createdAt],
  );
  const committed = { entries, audit: [audit], userBalanceUpdate };
  await updateSnapshot(client, committed);
  return committed;
}
