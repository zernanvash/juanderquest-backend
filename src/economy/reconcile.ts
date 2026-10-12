import type { Pool } from 'pg';
import { createHash } from 'crypto';

const LEGACY_SCALE = 1000n;

export interface LegacyBalanceFinding {
  userId: string;
  demoPoints: string;
  snapshotMjdq: string | null;
  classification: 'exact' | 'fractional_remainder' | 'missing_snapshot' | 'invalid_snapshot' | 'mismatch';
  differenceMjdq: string | null;
}

export interface AccountDriftFinding {
  accountId: string;
  storedMinor: string;
  transferDerivedMinor: string;
}

export interface EconomyReconciliation {
  legacy: LegacyBalanceFinding[];
  unbalancedLegacyGroups: Array<{ groupId: string; netMjdq: string }>;
  pilotAccountDrift: AccountDriftFinding[];
}

export interface EconomyShadowSummary {
  legacyClassifications: Record<LegacyBalanceFinding['classification'], number>;
  legacyUnbalancedGroupCount: number;
  legacyUnbalancedNetMjdq: string;
  pilotAccountDriftCount: number;
  canonicalDigestSha256: string;
  cutoverEligible: false;
  reason: 'HUMAN_DISPOSITION_AND_ROLLBACK_REVIEW_REQUIRED';
}

// The summary is safe for a shared report: no account, wallet, email or
// transaction-group identifier is emitted. Its digest changes with the full
// canonical findings, allowing repeated read-only shadow runs to be compared.
// Even a clean numeric comparison cannot approve a cutover automatically.
export function summarizeEconomyReconciliation(report: EconomyReconciliation): EconomyShadowSummary {
  const legacyClassifications: EconomyShadowSummary['legacyClassifications'] = {
    exact: 0, fractional_remainder: 0, missing_snapshot: 0,
    invalid_snapshot: 0, mismatch: 0,
  };
  for (const finding of report.legacy) legacyClassifications[finding.classification]++;
  const legacyNet = report.unbalancedLegacyGroups.reduce(
    (sum, group) => sum + BigInt(group.netMjdq), 0n
  );
  const canonical = {
    legacy: [...report.legacy].sort((a, b) => a.userId.localeCompare(b.userId)),
    unbalancedLegacyGroups: [...report.unbalancedLegacyGroups].sort((a, b) => a.groupId.localeCompare(b.groupId)),
    pilotAccountDrift: [...report.pilotAccountDrift].sort((a, b) => a.accountId.localeCompare(b.accountId)),
  };
  return {
    legacyClassifications,
    legacyUnbalancedGroupCount: report.unbalancedLegacyGroups.length,
    legacyUnbalancedNetMjdq: legacyNet.toString(),
    pilotAccountDriftCount: report.pilotAccountDrift.length,
    canonicalDigestSha256: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
    cutoverEligible: false,
    reason: 'HUMAN_DISPOSITION_AND_ROLLBACK_REVIEW_REQUIRED',
  };
}

// Read only: no migration, repair, opening-balance import, or balance rewrite.
export async function reconcileEconomy(pool: Pool): Promise<EconomyReconciliation> {
  const client = await pool.connect();
  let users;
  let snapshot;
  let ledger;
  let accounts;
  let transfers;
  try {
    const version = await client.query('SELECT version() AS version');
    const isPgMem = String(version.rows[0]?.version).includes('pg-mem');
    await client.query('BEGIN');
    // pg-mem does not implement transaction isolation. Real PostgreSQL must
    // give every read in this audit one stable MVCC view.
    if (!isPgMem) {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    }
    // Extract JSONB scalars as PostgreSQL text. Materializing the whole JSONB
    // object in JavaScript can round large integer mJDQ values before BigInt
    // sees them, making a shadow audit falsely report an exact balance.
    users = isPgMem
      ? await client.query('SELECT id, demo_points FROM users ORDER BY id')
      : await client.query(
        `SELECT u.id, u.demo_points, gs.data -> 'balances' ->> u.id AS snapshot_mjdq
         FROM users u LEFT JOIN governance_snapshot gs ON gs.id = 1 ORDER BY u.id`
      );
    snapshot = isPgMem ? await client.query('SELECT data FROM governance_snapshot WHERE id = 1') : null;
    ledger = await client.query('SELECT transaction_group_id, amount_mjdq FROM governance_ledger');
    accounts = await client.query("SELECT id, balance_minor FROM economic_accounts WHERE asset_code = 'EXPLORER_COIN_SIM'");
    transfers = await client.query("SELECT from_account_id, to_account_id, amount_minor FROM economic_transfers WHERE asset_code = 'EXPLORER_COIN_SIM'");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const legacy: LegacyBalanceFinding[] = users.rows.map((row) => {
    const points = BigInt(String(row.demo_points));
    const raw = snapshot ? snapshot.rows[0]?.data?.balances?.[row.id] : row.snapshot_mjdq;
    if (raw === undefined || raw === null) {
      return { userId: String(row.id), demoPoints: points.toString(), snapshotMjdq: null,
        classification: 'missing_snapshot' as const, differenceMjdq: null };
    }
    if (!/^(0|[1-9][0-9]*)$/.test(String(raw))) {
      return { userId: String(row.id), demoPoints: points.toString(), snapshotMjdq: String(raw),
        classification: 'invalid_snapshot' as const, differenceMjdq: null };
    }
    const mjdq = BigInt(String(raw));
    const expected = points * LEGACY_SCALE;
    const difference = mjdq - expected;
    const classification = difference === 0n ? 'exact' as const :
      difference > 0n && difference < LEGACY_SCALE ? 'fractional_remainder' as const : 'mismatch' as const;
    return { userId: String(row.id), demoPoints: points.toString(),
      snapshotMjdq: mjdq.toString(), classification, differenceMjdq: difference.toString() };
  });

  const groups = new Map<string, bigint>();
  for (const row of ledger.rows) {
    const id = String(row.transaction_group_id);
    groups.set(id, (groups.get(id) ?? 0n) + BigInt(String(row.amount_mjdq)));
  }
  const unbalancedLegacyGroups = [...groups.entries()]
    .filter(([, net]) => net !== 0n)
    .map(([groupId, net]) => ({ groupId, netMjdq: net.toString() }));

  const derived = new Map<string, bigint>();
  for (const row of accounts.rows) derived.set(String(row.id), 0n);
  for (const row of transfers.rows) {
    const amount = BigInt(String(row.amount_minor));
    const from = String(row.from_account_id);
    const to = String(row.to_account_id);
    derived.set(from, (derived.get(from) ?? 0n) - amount);
    derived.set(to, (derived.get(to) ?? 0n) + amount);
  }
  const pilotAccountDrift = accounts.rows.flatMap((row) => {
    const accountId = String(row.id);
    const stored = BigInt(String(row.balance_minor));
    const reconstructed = derived.get(accountId) ?? 0n;
    return stored === reconstructed ? [] : [{ accountId, storedMinor: stored.toString(),
      transferDerivedMinor: reconstructed.toString() }];
  });
  return { legacy, unbalancedLegacyGroups, pilotAccountDrift };
}
