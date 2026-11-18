import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { keccak256, toUtf8Bytes } from 'ethers';
import { movePoints } from '../funding/ledger.js';
import { commitGovernanceTransaction, lockGovernanceSnapshot } from '../governance/transaction.js';
import { governanceStore } from '../routes/proposals.js';
import { db } from '../db/index.js';
import { getChainConfig, explorerTx } from '../chain/config.js';

/**
 * Owner 2026-11-18: a platform admin gives simulated mJDQ to a traveler (beta testing).
 * The grant is a normal balanced ledger move (issuance -> traveler) and is anchored on
 * Polygon Amoy: the chain outbox sends one 0-value transaction from the server issuer to
 * itself carrying the grant's fingerprint. Names, emails and reasons never go on-chain.
 */
export const GRANT_MAX_POINTS = 1000;
export const GRANT_DAILY_CAP = 5000;
/** "JDQG": the 4-byte tag in front of the 32-byte fingerprint in the anchor transaction's data. */
export const ANCHOR_TAG = '0x4a445147';

export class PointGrantError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface GrantInput {
  adminId: string;
  userId: string;
  points: number;
  reason: string;
  idempotencyKey: string;
  now?: Date;
}

/** keccak256 of the grant's canonical line; the same inputs always give the same fingerprint. */
export function grantFingerprint(g: {
  id: string;
  userId: string;
  points: number;
  ledgerGroupId: string;
  createdAt: string;
}): string {
  return keccak256(toUtf8Bytes(`JDQ-GRANT-v1|${g.id}|${g.userId}|${g.points}|${g.ledgerGroupId}|${g.createdAt}`));
}

export function anchorCalldata(fingerprint: string): string {
  return ANCHOR_TAG + fingerprint.slice(2);
}

function validate(input: GrantInput) {
  if (!Number.isSafeInteger(input.points) || input.points < 1 || input.points > GRANT_MAX_POINTS)
    throw new PointGrantError('INVALID_POINTS', 400, `Give between 1 and ${GRANT_MAX_POINTS} mJDQ at a time.`);
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 3 || reason.length > 200)
    throw new PointGrantError('INVALID_REASON', 400, 'Write a reason of 3 to 200 characters.');
  if (!/^[A-Za-z0-9:_-]{8,100}$/.test(input.idempotencyKey ?? ''))
    throw new PointGrantError('INVALID_IDEMPOTENCY_KEY', 400, 'A request key of 8 to 100 characters is required.');
  return reason;
}

function grantView(row: any) {
  const txHash = row.tx_hash ? String(row.tx_hash) : null;
  return {
    id: row.id,
    user: { id: row.user_id, display_name: row.display_name ?? null, handle: row.handle ?? null },
    admin: { id: row.admin_id, display_name: row.admin_name ?? null },
    points: Number(row.points),
    reason: row.reason,
    balance_after: Number(row.balance_after),
    is_test: Boolean(row.is_test),
    created_at: new Date(row.created_at).toISOString(),
    anchor: {
      fingerprint: row.anchor_hash,
      // queued | submitted | included | finalized | failed | not_anchored
      status: row.chain_command_id ? (row.command_status ?? 'queued') : 'not_anchored',
      tx_hash: txHash,
      explorer_url: txHash ? explorerTx(txHash) : null,
      last_error: row.last_error ?? null,
    },
  };
}

const GRANT_SELECT = `
  SELECT g.*, u.display_name, u.handle, a.display_name AS admin_name,
         c.status AS command_status, c.last_error,
         (SELECT t.tx_hash FROM chain_transaction_attempts t WHERE t.command_id = c.id
           ORDER BY t.created_at DESC LIMIT 1) AS tx_hash
    FROM admin_point_grants g
    JOIN users u ON u.id = g.user_id
    LEFT JOIN users a ON a.id = g.admin_id
    LEFT JOIN chain_commands c ON c.id = g.chain_command_id`;

export class PointGrantService {
  constructor(private readonly pool: Pool) {}

  /** Finds a traveler by exact email or handle for the dashboard form. */
  async lookup(query: string) {
    const q = query.trim().replace(/^@/, '');
    if (q.length < 3) return [];
    const rows = await this.pool.query(
      `SELECT id, display_name, handle, email, demo_points, is_test, role FROM users
        WHERE lower(email) = lower($1) OR lower(handle) = lower($1) LIMIT 5`,
      [q],
    );
    return rows.rows.map((u: any) => ({
      id: u.id,
      display_name: u.display_name,
      handle: u.handle,
      email: u.email,
      balance: Number(u.demo_points),
      is_test: Boolean(u.is_test),
      role: u.role,
    }));
  }

  async list(limit = 50) {
    const rows = await this.pool.query(`${GRANT_SELECT} ORDER BY g.created_at DESC, g.id LIMIT $1`, [
      Math.min(Math.max(limit, 1), 200),
    ]);
    return rows.rows.map(grantView);
  }

  async get(id: string) {
    const rows = await this.pool.query(`${GRANT_SELECT} WHERE g.id = $1`, [id]);
    return rows.rows[0] ? grantView(rows.rows[0]) : null;
  }

  async grant(input: GrantInput) {
    const reason = validate(input);
    const now = input.now ?? new Date();
    const client = (await this.pool.connect()) as PoolClient;
    let committed = false;
    try {
      await client.query('BEGIN');
      await lockGovernanceSnapshot(client as any);
      const replay = await client.query(
        'SELECT id, user_id, points FROM admin_point_grants WHERE admin_id=$1 AND idempotency_key=$2',
        [input.adminId, input.idempotencyKey],
      );
      if (replay.rows[0]) {
        await client.query('COMMIT');
        committed = true;
        const r = replay.rows[0];
        if (r.user_id !== input.userId || Number(r.points) !== input.points)
          throw new PointGrantError(
            'IDEMPOTENCY_CONFLICT',
            409,
            'This request key was already used for another grant.',
          );
        return { grant: await this.get(r.id), replayed: true };
      }

      const userRow = (
        await client.query('SELECT id, display_name, is_test, role FROM users WHERE id = $1 FOR UPDATE', [input.userId])
      ).rows[0];
      if (!userRow) throw new PointGrantError('USER_NOT_FOUND', 404, 'No traveler with that id.');

      // Per admin, per Manila day.
      const used = Number(
        (
          await client.query(
            `SELECT COALESCE(SUM(points),0)::int AS used FROM admin_point_grants
              WHERE admin_id = $1
                AND (created_at AT TIME ZONE 'Asia/Manila')::date = ($2::timestamptz AT TIME ZONE 'Asia/Manila')::date`,
            [input.adminId, now],
          )
        ).rows[0].used,
      );
      if (used + input.points > GRANT_DAILY_CAP)
        throw new PointGrantError(
          'DAILY_CAP_REACHED',
          429,
          `You can give ${GRANT_DAILY_CAP} mJDQ per day; ${Math.max(0, GRANT_DAILY_CAP - used)} left today.`,
          { remaining_today: Math.max(0, GRANT_DAILY_CAP - used) },
        );

      const isTest = Boolean(userRow.is_test);
      const issuance = isTest ? 'admin_grant_issuance:test' : 'admin_grant_issuance';
      await client.query(
        `INSERT INTO points_accounts (id, kind, is_test) VALUES ($1, 'issuance', $2) ON CONFLICT (id) DO NOTHING`,
        [issuance, isTest],
      );
      const id = `grant_${randomUUID()}`;
      const group = await movePoints(client, {
        from: { id: issuance, kind: 'issuance' },
        to: { id: userRow.id, kind: 'traveler', userId: userRow.id },
        points: input.points,
        type: 'admin_grant',
        referenceType: 'admin_point_grant',
        referenceId: id,
        actorId: input.adminId,
        idempotencyKey: `admin-grant:${input.adminId}:${input.idempotencyKey}`,
        reason,
        metadata: { simulated: true, beta: true },
      });
      const ledgerGroupId = group.entries[0].transaction_group_id;
      const createdAt = now.toISOString();
      const fingerprint = grantFingerprint({
        id,
        userId: userRow.id,
        points: input.points,
        ledgerGroupId,
        createdAt,
      });

      // Anchor through the chain outbox when an active issuer wallet is registered.
      const chainId = getChainConfig().chainId;
      const issuer = (
        await client.query(
          `SELECT address FROM chain_wallets WHERE chain_id = $1 AND role = 'badge_issuer' AND active = TRUE LIMIT 1`,
          [chainId],
        )
      ).rows[0]?.address as string | undefined;
      let commandId: string | null = null;
      if (issuer) {
        commandId = randomUUID();
        await client.query(
          `INSERT INTO chain_commands (id, chain_id, entitlement_id, operation, recipient_address, status)
           VALUES ($1, $2, $3, 'points_anchor', $4, 'queued')`,
          [commandId, chainId, fingerprint, issuer.toLowerCase()],
        );
      }
      await client.query(
        `INSERT INTO admin_point_grants
           (id, user_id, points, reason, admin_id, idempotency_key, ledger_group_id, balance_after,
            anchor_hash, chain_command_id, is_test, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          userRow.id,
          input.points,
          reason,
          input.adminId,
          input.idempotencyKey,
          ledgerGroupId,
          group.userBalanceUpdate?.demoPoints ?? 0,
          fingerprint,
          commandId,
          isTest,
          createdAt,
        ],
      );
      await client.query(
        `INSERT INTO admin_audit_log(id, actor_id, actor_role, area_id, action, subject_type, subject_id, before, after)
         VALUES ($1,$2,'admin',NULL,'points.grant','user',$3,$4::jsonb,$5::jsonb)`,
        [
          randomUUID(),
          input.adminId,
          userRow.id,
          JSON.stringify({ balance: group.userBalanceUpdate?.previousDemoPoints ?? null }),
          JSON.stringify({
            balance: group.userBalanceUpdate?.demoPoints ?? null,
            points: input.points,
            reason,
            grant_id: id,
            ledger_group_id: ledgerGroupId,
            anchor: fingerprint,
          }),
        ],
      );
      await commitGovernanceTransaction(client as any);
      committed = true;
      governanceStore.publishCommittedTransaction(group);
      const cached = db.findUserById(userRow.id);
      if (cached && group.userBalanceUpdate) cached.demo_points = group.userBalanceUpdate.demoPoints;
      return { grant: await this.get(id), replayed: false };
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
