import { createHash, randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { governanceStore } from '../routes/proposals.js';
import { MJDQ_PER_JDQ } from '../governance/store.js';
import { lockGovernanceSnapshot, commitGovernanceTransaction } from '../governance/transaction.js';
import { canonicalSettings } from '../settings/schema.js';
import { movePoints } from './ledger.js';

export const MERCHANT_POINT_PACKAGES = [500, 1_000, 2_500, 5_000] as const;

export class MerchantPointsError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'MerchantPointsError';
  }
}

type Client = { query: (sql: string, params?: unknown[]) => Promise<any>; release: () => void };
type PoolLike = Pick<Pool, 'connect'>;

function safePoints(points: number): number {
  if (!Number.isSafeInteger(points) || points <= 0 || !Number.isSafeInteger(points * MJDQ_PER_JDQ)) {
    throw new MerchantPointsError('INVALID_AMOUNT', 400, 'Point amount is invalid.');
  }
  return points;
}

function safeBalance(value: unknown): number {
  const balance = Number(value);
  if (!Number.isSafeInteger(balance)) throw new MerchantPointsError('POINT_BALANCE_OVERFLOW', 409, 'Merchant point balance exceeds the supported safe-integer range.');
  return balance;
}

function requestHash(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

async function persistLedgerGroup(
  client: Client,
  params: { actorId: string; merchantId: string; points: number; direction: 'credit' | 'debit'; referenceId: string; idempotencyKey: string; source: string; reason?: string; isTest: boolean }
) {
  const merchantAccount = `merchant:${params.merchantId}`;
  const issuance = params.isTest ? 'merchant_issuance:test' : 'merchant_issuance';
  const from = params.direction === 'credit' ? issuance : merchantAccount;
  const to = params.direction === 'credit' ? merchantAccount : issuance;
  return movePoints(client, {
    from: { id: from, kind: params.direction === 'credit' ? 'issuance' : 'merchant' },
    to: { id: to, kind: params.direction === 'credit' ? 'merchant' : 'issuance' },
    points: safePoints(params.points),
    type: `merchant_points_${params.source}`,
    referenceType: 'merchant_point_credit',
    referenceId: params.referenceId,
    actorId: params.actorId,
    idempotencyKey: params.idempotencyKey,
    reason: params.reason,
    metadata: { merchant_id: params.merchantId, direction: params.direction, source: params.source },
  });
}

async function readCommand(client: Client, actorId: string, operation: string, key: string, hash: string) {
  const result = await client.query(
    'SELECT request_hash, response FROM quest_funding_commands WHERE actor_id = $1 AND operation = $2 AND idempotency_key = $3 FOR UPDATE',
    [actorId, operation, key]
  );
  if (!result.rows[0]) return null;
  if (result.rows[0].request_hash !== hash) {
    throw new MerchantPointsError('IDEMPOTENCY_CONFLICT', 409, 'This idempotency key was already used for a different request.');
  }
  return result.rows[0].response;
}

async function saveCommand(client: Client, actorId: string, operation: string, key: string, hash: string, response: unknown) {
  await client.query(
    `INSERT INTO quest_funding_commands (actor_id, operation, idempotency_key, request_hash, response)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [actorId, operation, key, hash, JSON.stringify(response)]
  );
}

async function getSettings(client: Client) {
  const result = await client.query('SELECT values FROM system_settings_document WHERE id = 1');
  return canonicalSettings(result.rows[0]?.values ?? {});
}

async function lockMerchantAccount(client: Client, merchantId: string, isTest: boolean) {
  await client.query(
    `INSERT INTO points_accounts (id, kind, merchant_id, is_test)
     VALUES ($1, 'merchant', $2, $3) ON CONFLICT (id) DO NOTHING`,
    [`merchant:${merchantId}`, merchantId, isTest]
  );
  const result = await client.query('SELECT id, balance_points, is_test FROM points_accounts WHERE id = $1 FOR UPDATE', [`merchant:${merchantId}`]);
  if (!result.rows[0]) throw new Error('MERCHANT_POINTS_ACCOUNT_UNAVAILABLE');
  if (Boolean(result.rows[0].is_test) !== isTest) throw new MerchantPointsError('SCOPE_MISMATCH', 409, 'Merchant account scope does not match its merchant.');
  return { id: result.rows[0].id as string, balance: safeBalance(result.rows[0].balance_points) };
}

async function assertActiveOwner(client: Client, actorId: string, merchantId: string, admin = false, readOnly = false) {
  const result = await client.query(
    `SELECT m.id, m.is_test, m.status, mm.role, mm.status AS membership_status,
       (SELECT is_test FROM users WHERE id=$2) AS actor_scope
     FROM merchants m LEFT JOIN merchant_memberships mm ON mm.merchant_id = m.id AND mm.user_id = $2
     WHERE m.id = $1 FOR UPDATE OF m`,
    [merchantId, actorId]
  );
  const row = result.rows[0];
  if (!row || row.status !== 'active') throw new MerchantPointsError('MERCHANT_NOT_FOUND', 404, 'Active merchant not found.');
  if (!admin && ((!readOnly && row.role !== 'owner') || !['owner','staff'].includes(row.role) || row.membership_status !== 'active')) {
    throw new MerchantPointsError('MERCHANT_OWNER_REQUIRED', 403, 'Only an active merchant owner may manage merchant points.');
  }
  if (!admin && Boolean(row.actor_scope) !== Boolean(row.is_test)) throw new MerchantPointsError('SCOPE_MISMATCH', 403, 'Merchant and owner scopes do not match.');
  return { isTest: Boolean(row.is_test) };
}

export class MerchantPointsService {
  constructor(private readonly pool: PoolLike) {}

  async purchase(actorId: string, merchantId: string, points: number, idempotencyKey: string) {
    safePoints(points);
    if (!MERCHANT_POINT_PACKAGES.includes(points as typeof MERCHANT_POINT_PACKAGES[number])) {
      throw new MerchantPointsError('INVALID_PACKAGE', 400, 'Choose one of the available simulated point packages.');
    }
    const operation = 'merchant_points_purchase';
    const hash = requestHash({ merchantId, points });
    const client = await this.pool.connect() as Client;
    let committed = false;
    let committedLedger: { entries: any[]; audit: any } | undefined;
    try {
      await client.query('BEGIN');
      await lockGovernanceSnapshot(client);
      const owner = await assertActiveOwner(client, actorId, merchantId);
      const replay = await readCommand(client, actorId, operation, idempotencyKey, hash);
      if (replay) {
        await client.query('COMMIT');
        return { ...replay, replayed: true };
      }
      const settings = await getSettings(client);
      const dailyCap = Number(settings.merchant_purchase_daily_cap);
      const monthlyCap = Number(settings.merchant_purchase_monthly_cap);
      const account = await lockMerchantAccount(client, merchantId, owner.isTest);
      if (!Number.isSafeInteger(account.balance + points)) throw new MerchantPointsError('POINT_BALANCE_OVERFLOW', 409, 'Merchant point balance exceeds the supported safe-integer range.');
      const usage = await client.query(
        `SELECT
           COALESCE(SUM(points) FILTER (WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0)::bigint AS daily,
           COALESCE(SUM(points) FILTER (WHERE created_at >= date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0)::bigint AS monthly,
           (date_trunc('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day') AT TIME ZONE 'UTC' AS daily_reset,
           (date_trunc('month', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 month') AT TIME ZONE 'UTC' AS monthly_reset
         FROM merchant_point_credits WHERE merchant_id = $1 AND source = 'simulated_purchase'`,
        [merchantId]
      );
      const daily = Number(usage.rows[0]?.daily ?? 0);
      const monthly = Number(usage.rows[0]?.monthly ?? 0);
      if (daily + points > dailyCap || monthly + points > monthlyCap) {
        throw new MerchantPointsError('PURCHASE_LIMIT_REACHED', 429, 'This simulated purchase would exceed the merchant point issuance limit.', {
          daily_remaining: Math.max(0, dailyCap - daily), monthly_remaining: Math.max(0, monthlyCap - monthly),
          next_reset_at: new Date(daily + points > dailyCap ? usage.rows[0].daily_reset : usage.rows[0].monthly_reset).toISOString(),
        });
      }
      const creditId = randomUUID();
      await client.query(
        `INSERT INTO merchant_point_credits
          (id, merchant_id, source, points, reference, actor_id, idempotency_key, ledger_group_id)
         VALUES ($1,$2,'simulated_purchase',$3,$4,$5,$6,$7)`,
        [creditId, merchantId, points, `package:${points}`, actorId, `${operation}:${idempotencyKey}`, creditId]
      );
      committedLedger = await persistLedgerGroup(client, {
        actorId, merchantId, points, direction: 'credit', referenceId: creditId, idempotencyKey, source: 'simulated_purchase', isTest: owner.isTest,
      });
      await client.query('UPDATE merchant_point_credits SET ledger_group_id=$2 WHERE id=$1', [creditId,committedLedger.entries[0].transaction_group_id]);
      const response = { merchant_id: merchantId, balance_points: account.balance + points, credited_points: points, receipt_id: creditId, simulated: true };
      await saveCommand(client, actorId, operation, idempotencyKey, hash, response);
      await commitGovernanceTransaction(client);
      committed = true;
      governanceStore.publishCommittedTransaction(committedLedger);
      return { ...response, replayed: false };
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async adminAdjust(actorId: string, merchantId: string, points: number, reason: string, idempotencyKey: string, reversesCreditId?: string) {
    if (!Number.isSafeInteger(points) || points === 0 || !Number.isSafeInteger(points * MJDQ_PER_JDQ)) {
      throw new MerchantPointsError('INVALID_AMOUNT', 400, 'Point adjustment must be a non-zero safe integer.');
    }
    if (reason.trim().length < 10 || reason.trim().length > 500) {
      throw new MerchantPointsError('INVALID_REASON', 400, 'Provide an audit reason between 10 and 500 characters.');
    }
    if (points < 0 && !reversesCreditId) {
      throw new MerchantPointsError('REVERSAL_REFERENCE_REQUIRED', 400, 'A negative correction must identify the credit it reverses.');
    }
    const source = points > 0 ? 'admin_grant' : 'admin_correction';
    const magnitude = Math.abs(points);
    const operation = 'admin_merchant_points_adjustment';
    const hash = requestHash({ merchantId, points, reason: reason.trim(), reversesCreditId: reversesCreditId ?? null });
    const client = await this.pool.connect() as Client;
    let committed = false;
    let committedLedger: { entries: any[]; audit: any } | undefined;
    try {
      await client.query('BEGIN');
      await lockGovernanceSnapshot(client);
      const merchant = await assertActiveOwner(client, actorId, merchantId, true);
      const replay = await readCommand(client, actorId, operation, idempotencyKey, hash);
      if (replay) {
        await client.query('COMMIT');
        return { ...replay, replayed: true };
      }
      const account = await lockMerchantAccount(client, merchantId, merchant.isTest);
      if (!Number.isSafeInteger(account.balance + points) || account.balance + points < 0) {
        throw new MerchantPointsError('INSUFFICIENT_MERCHANT_POINTS', 409, 'Adjustment would make the merchant balance negative.', { shortfall: Math.max(0, -(account.balance + points)) });
      }
      if (points < 0) {
        const originalResult = await client.query(
          'SELECT points FROM merchant_point_credits WHERE id = $1 AND merchant_id = $2 AND points > 0 FOR UPDATE',
          [reversesCreditId, merchantId]
        );
        const original = originalResult.rows[0];
        const reversedResult = original ? await client.query(
          'SELECT COALESCE(SUM(-points),0)::bigint AS already_reversed FROM merchant_point_credits WHERE reverses_credit_id = $1',
          [reversesCreditId]
        ) : null;
        if (!original || Number(original.points) - Number(reversedResult?.rows[0]?.already_reversed ?? 0) < magnitude) {
          throw new MerchantPointsError('INVALID_REVERSAL', 409, 'Correction exceeds the unreversed amount of the selected credit.');
        }
        if (account.balance < magnitude) {
          throw new MerchantPointsError('INSUFFICIENT_MERCHANT_POINTS', 409, 'Correction would make the merchant balance negative.', { shortfall: magnitude - account.balance });
        }
      }
      const creditId = randomUUID();
      await client.query(
        `INSERT INTO merchant_point_credits
          (id, merchant_id, source, points, reference, actor_id, idempotency_key, ledger_group_id, reverses_credit_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [creditId, merchantId, source, points, reason.trim(), actorId, `${operation}:${idempotencyKey}`, creditId, reversesCreditId ?? null]
      );
      committedLedger = await persistLedgerGroup(client, {
        actorId, merchantId, points: magnitude, direction: points > 0 ? 'credit' : 'debit',
        referenceId: creditId, idempotencyKey, source, reason: reason.trim(), isTest: merchant.isTest,
      });
      await client.query('UPDATE merchant_point_credits SET ledger_group_id=$2 WHERE id=$1', [creditId,committedLedger.entries[0].transaction_group_id]);
      const response = { merchant_id: merchantId, balance_points: account.balance + points, adjusted_points: points, receipt_id: creditId };
      await saveCommand(client, actorId, operation, idempotencyKey, hash, response);
      await commitGovernanceTransaction(client);
      committed = true;
      governanceStore.publishCommittedTransaction(committedLedger);
      return { ...response, replayed: false };
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getBalance(actorId: string, merchantId: string, limit = 20) {
    const client = await this.pool.connect() as Client;
    try {
      const owner = await assertActiveOwner(client, actorId, merchantId, false, true);
      const account = await client.query('SELECT balance_points FROM points_accounts WHERE id = $1', [`merchant:${merchantId}`]);
      const credits = await client.query(
        `SELECT id, source, points, reference, created_at FROM merchant_point_credits
         WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [merchantId, Math.min(Math.max(Math.trunc(limit) || 20, 1), 100)]
      );
      return { merchant_id: merchantId, balance_points: safeBalance(account.rows[0]?.balance_points ?? 0), is_test: owner.isTest, history: credits.rows };
    } finally {
      client.release();
    }
  }
}
