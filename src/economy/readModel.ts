import type { Pool } from 'pg';
import { SIM_ASSET } from './service.js';

export class EconomyReadError extends Error {
  constructor(public readonly code: 'INVALID_CURSOR' | 'INVALID_LIMIT') { super(code); }
}

type PageCursor = { at: string; id: string };

function parsePage(limitValue: unknown, cursorValue: unknown): { limit: number; cursor: PageCursor | null } {
  const limit = limitValue === undefined ? 20 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new EconomyReadError('INVALID_LIMIT');
  if (cursorValue === undefined) return { limit, cursor: null };
  if (typeof cursorValue !== 'string' || cursorValue.length > 512) throw new EconomyReadError('INVALID_CURSOR');
  try {
    const decoded = JSON.parse(Buffer.from(cursorValue, 'base64url').toString('utf8')) as PageCursor;
    if (typeof decoded.at !== 'string' || Number.isNaN(Date.parse(decoded.at)) ||
        typeof decoded.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,120}$/.test(decoded.id)) {
      throw new Error('invalid');
    }
    return { limit, cursor: decoded };
  } catch { throw new EconomyReadError('INVALID_CURSOR'); }
}

function asIso(value: unknown): string { return new Date(String(value)).toISOString(); }
function pageResult<T extends { id: string; created_at: unknown; cursor_at: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items: items.map(({ cursor_at: _cursorAt, ...item }) => item), next_cursor: hasMore && last
    ? Buffer.from(JSON.stringify({ at: last.cursor_at, id: last.id })).toString('base64url')
    : null };
}

export class EconomyReadModel {
  constructor(private readonly pool: Pool) {}

  async capabilities() {
    const result = await this.pool.query(
      `SELECT count(*)::int AS applied FROM schema_migrations
       WHERE filename = '035_chain_indexer_reorg_safety.sql' AND checksum IS NOT NULL`
    );
    if (result.rows[0]?.applied !== 1) throw new Error('ECONOMY_SCHEMA_UNAVAILABLE');
    return { environment: 'local_simulation', asset: SIM_ASSET, can_view: true,
      can_start: true, can_spend: true, schema_ready: true };
  }

  async me(userId: string) {
    const result = await this.pool.query(
      `SELECT balance_minor::text AS balance_minor FROM economic_accounts
       WHERE asset_code = $1 AND user_id = $2 AND kind = 'traveler'`, [SIM_ASSET, userId]
    );
    return { asset: SIM_ASSET, balance_minor: result.rows[0]?.balance_minor ?? '0',
      label: 'Explorer Coins (local simulation)', cash_value: null, converts_to_jdq: false };
  }

  async activity(userId: string, limitValue: unknown, cursorValue: unknown) {
    const { limit, cursor } = parsePage(limitValue, cursorValue);
    const result = await this.pool.query(
      `SELECT tx.id, tx.operation, tx.created_at, tx.created_at::text AS cursor_at,
              tr.amount_minor::text AS amount_minor,
              CASE WHEN dst.user_id = $2 THEN 'credit' ELSE 'debit' END AS direction,
              CASE WHEN aw.id IS NOT NULL THEN 'reservation'
                   WHEN en.id IS NOT NULL THEN 'cosmetic'
                   WHEN correction.id IS NOT NULL THEN 'original_transaction'
                   ELSE 'transaction' END AS reference_kind,
              COALESCE(aw.reservation_id, en.cosmetic_id, correction.original_transaction_id, tx.id) AS reference_id
       FROM economic_transactions tx
       JOIN economic_transfers tr ON tr.transaction_id = tx.id AND tr.sequence = 1
       JOIN economic_accounts src ON src.id = tr.from_account_id
       JOIN economic_accounts dst ON dst.id = tr.to_account_id
       LEFT JOIN reward_awards aw ON aw.transaction_id = tx.id AND aw.user_id = $2
       LEFT JOIN economic_entitlements en ON en.transaction_id = tx.id AND en.user_id = $2
       LEFT JOIN economic_corrections correction ON correction.correcting_transaction_id = tx.id
       WHERE tx.asset_code = $1 AND (src.user_id = $2 OR dst.user_id = $2)
         AND ($3::timestamptz IS NULL OR (tx.created_at, tx.id) < ($3::timestamptz, $4::text))
       ORDER BY tx.created_at DESC, tx.id DESC LIMIT $5`,
      [SIM_ASSET, userId, cursor?.at ?? null, cursor?.id ?? null, limit + 1]
    );
    const rows = result.rows.map(row => ({
      id: String(row.id), operation: String(row.operation), created_at: asIso(row.created_at),
      cursor_at: String(row.cursor_at),
      amount_minor: String(row.amount_minor), direction: row.direction as 'credit' | 'debit',
      signed_amount_minor: row.direction === 'credit' ? String(row.amount_minor) : `-${String(row.amount_minor)}`,
      status: 'committed' as const, reference_kind: String(row.reference_kind),
      reference_id: String(row.reference_id), asset: SIM_ASSET,
    }));
    return pageResult(rows, limit);
  }

  async reservations(userId: string, limitValue: unknown, cursorValue: unknown) {
    const { limit, cursor } = parsePage(limitValue, cursorValue);
    const result = await this.pool.query(
      `SELECT r.id, r.pool_id, p.quest_id, r.attempt_id, r.submission_id, r.status,
              r.amount_minor::text AS amount_minor, r.policy_id, p.policy_version,
              r.expires_at, r.appeal_until, r.submitted_at, r.created_at, r.created_at::text AS cursor_at, r.updated_at,
              CASE WHEN r.status = 'released' AND EXISTS
                (SELECT 1 FROM reward_appeals a WHERE a.reservation_id = r.id AND a.status = 'rejected')
                THEN 'appeal_rejected'
                WHEN r.status = 'released' THEN 'deadline_expired' ELSE NULL END AS release_reason
       FROM reward_reservations r JOIN reward_pools p ON p.id = r.pool_id
       WHERE r.user_id = $1 AND p.asset_code = $2
         AND ($3::timestamptz IS NULL OR (r.created_at, r.id) < ($3::timestamptz, $4::text))
       ORDER BY r.created_at DESC, r.id DESC LIMIT $5`,
      [userId, SIM_ASSET, cursor?.at ?? null, cursor?.id ?? null, limit + 1]
    );
    return pageResult(result.rows.map(row => this.reservationRow(row)), limit);
  }

  async reservation(userId: string, id: string) {
    const result = await this.pool.query(
      `SELECT r.id, r.pool_id, p.quest_id, r.attempt_id, r.submission_id, r.status,
              r.amount_minor::text AS amount_minor, r.policy_id, p.policy_version,
              r.expires_at, r.appeal_until, r.submitted_at, r.created_at,
              r.created_at::text AS cursor_at, r.updated_at,
              CASE WHEN r.status = 'released' AND EXISTS
                (SELECT 1 FROM reward_appeals a WHERE a.reservation_id = r.id AND a.status = 'rejected')
                THEN 'appeal_rejected'
                WHEN r.status = 'released' THEN 'deadline_expired' ELSE NULL END AS release_reason
       FROM reward_reservations r JOIN reward_pools p ON p.id = r.pool_id
       WHERE r.id = $1 AND r.user_id = $2 AND p.asset_code = $3`, [id, userId, SIM_ASSET]
    );
    return result.rows[0] ? this.reservationRow(result.rows[0]) : null;
  }

  private reservationRow(row: Record<string, unknown>) {
    const date = (value: unknown) => value ? asIso(value) : null;
    return { id: String(row.id), pool_id: String(row.pool_id), quest_id: String(row.quest_id),
      attempt_id: row.attempt_id ? String(row.attempt_id) : null,
      submission_id: row.submission_id ? String(row.submission_id) : null,
      status: String(row.status), amount_minor: String(row.amount_minor), asset: SIM_ASSET,
      policy_id: row.policy_id ? String(row.policy_id) : null,
      policy_version: String(row.policy_version), expires_at: date(row.expires_at),
      appeal_until: date(row.appeal_until), submitted_at: date(row.submitted_at),
      created_at: asIso(row.created_at), cursor_at: String(row.cursor_at), updated_at: asIso(row.updated_at),
      release_reason: row.release_reason ? String(row.release_reason) : null };
  }

  async entitlements(userId: string, limitValue: unknown, cursorValue: unknown) {
    const { limit, cursor } = parsePage(limitValue, cursorValue);
    const result = await this.pool.query(
      `SELECT e.id, e.cosmetic_id, e.transaction_id, e.created_at, e.created_at::text AS cursor_at,
              e.refunded_at, e.refund_transaction_id, c.cost_minor::text AS cost_minor
       FROM economic_entitlements e JOIN economic_cosmetics c ON c.id = e.cosmetic_id
       WHERE e.user_id = $1 AND c.asset_code = $2
         AND ($3::timestamptz IS NULL OR (e.created_at, e.id) < ($3::timestamptz, $4::text))
       ORDER BY e.created_at DESC, e.id DESC LIMIT $5`,
      [userId, SIM_ASSET, cursor?.at ?? null, cursor?.id ?? null, limit + 1]
    );
    return pageResult(result.rows.map(row => ({
      id: String(row.id), cosmetic_id: String(row.cosmetic_id),
      transaction_id: String(row.transaction_id), cost_minor: String(row.cost_minor),
      created_at: asIso(row.created_at), cursor_at: String(row.cursor_at),
      refunded_at: row.refunded_at ? asIso(row.refunded_at) : null,
      refund_transaction_id: row.refund_transaction_id ? String(row.refund_transaction_id) : null,
      status: row.refunded_at ? 'refunded' : 'owned', asset: SIM_ASSET,
    })), limit);
  }

  async poolSummary(id: string) {
    const result = await this.pool.query(
      `SELECT id, quest_id, status, allocated_minor::text, available_minor::text,
              reserved_minor::text, paid_minor::text, returned_minor::text,
              reward_minor::text, policy_version
       FROM reward_pools WHERE id = $1 AND asset_code = $2`, [id, SIM_ASSET]
    );
    if (!result.rows[0]) return null;
    const states = await this.pool.query(
      `SELECT status, count(*)::int AS count FROM reward_reservations
       WHERE pool_id = $1 GROUP BY status`, [id]
    );
    return { ...result.rows[0], asset: SIM_ASSET,
      reservation_counts: Object.fromEntries(states.rows.map(row => [row.status, row.count])) };
  }

  async queue() {
    const result = await this.pool.query(
      `SELECT r.status, count(*)::int AS count,
              max(extract(epoch from (now() - r.updated_at)))::bigint::text AS oldest_age_seconds
       FROM reward_reservations r JOIN reward_pools p ON p.id = r.pool_id
       WHERE p.asset_code = $1 AND r.status IN ('submitted', 'appeal')
       GROUP BY r.status`, [SIM_ASSET]
    );
    return result.rows;
  }

  async pendingAppeals() {
    const result = await this.pool.query(
      `SELECT a.id, a.reservation_id, a.submission_id, a.original_reviewer_id,
              a.requested_at, r.amount_minor::text AS amount_minor
         FROM reward_appeals a JOIN reward_reservations r ON r.id = a.reservation_id
        WHERE a.status = 'submitted' ORDER BY a.requested_at ASC, a.id ASC LIMIT 20`
    );
    return result.rows.map(row => ({ ...row, requested_at: asIso(row.requested_at), asset: SIM_ASSET }));
  }

  async recentCosmeticPurchases() {
    const result = await this.pool.query(
      `SELECT e.transaction_id, e.cosmetic_id, e.created_at, e.refunded_at,
              c.cost_minor::text AS amount_minor
         FROM economic_entitlements e JOIN economic_cosmetics c ON c.id = e.cosmetic_id
        WHERE c.asset_code = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 20`, [SIM_ASSET]
    );
    return result.rows.map(row => ({ ...row, created_at: asIso(row.created_at),
      refunded_at: row.refunded_at ? asIso(row.refunded_at) : null, asset: SIM_ASSET }));
  }
}
