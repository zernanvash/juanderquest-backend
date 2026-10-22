import { randomUUID } from 'crypto';
import { readFileSync, statSync } from 'fs';
import type { Pool } from 'pg';
import { Contract, Interface, JsonRpcProvider, Transaction, Wallet, parseUnits } from 'ethers';
import { env } from '../config/env.js';
import { getPool } from '../db/pool.js';
import { getChainConfig } from './config.js';
import { badgeEntitlement, badgeTokenId, badgeTokenUri } from './badgeIdentity.js';

/**
 * Plan 50: mint earned achievements as soulbound badges.
 *
 * One process at a time (advisory lock) walks the outbox:
 *   enqueue  — eligible awards of travelers with a linked wallet become `queued` commands;
 *   reconcile — `submitted` → `included` once a receipt exists, → `finalized` after
 *               CHAIN_CONFIRMATIONS blocks on the same block hash; reverts back off and retry;
 *   send     — at most one transaction in flight, signed by the server issuer key.
 * The server pays gas; the traveler never signs anything.
 */

/** "JDBM" — only one process sends badge transactions. */
const BADGE_MINTER_LOCK_KEY = 0x4a44424d;
/** Stop sending below this balance; the low-balance watch alerts admins well before. */
const MIN_ISSUER_BALANCE_WEI = parseUnits('0.05', 'ether');
const STUCK_AFTER_MS = 15 * 60_000;
const ENQUEUE_BATCH = 50;

export interface BadgeReceipt { success: boolean; blockNumber: number; blockHash: string }

/** The chain operations the minter needs. Tests use an in-memory fake. */
export interface BadgeChain {
  readonly issuer: string;
  latestBlock(): Promise<number>;
  balanceWei(): Promise<bigint>;
  /** Nonce of the next transaction from the issuer, including pending ones. */
  pendingNonce(): Promise<number>;
  /** Number of issuer transactions already mined. */
  minedNonce(): Promise<number>;
  isEntitlementUsed(entitlement: string): Promise<boolean>;
  sendIssue(args: { recipient: string; tokenId: string; entitlement: string; uri: string; nonce: number }): Promise<string>;
  receipt(txHash: string): Promise<BadgeReceipt | null>;
}

export interface BadgeMinterOptions {
  chainId: number;
  confirmations: number;
  maxAttempts: number;
  now?: Date;
}

export interface BadgeTickResult {
  enqueued: number;
  included: number;
  finalized: number;
  retried: number;
  failed: number;
  sent: string | null;
  skipped?: string;
}

const shortError = (err: unknown): string => {
  const raw = err instanceof Error ? ((err as { shortMessage?: string }).shortMessage ?? err.message) : String(err);
  return raw.replace(/0x[0-9a-fA-F]{64,}/g, '0x…').slice(0, 300);
};

const backoffMs = (attempt: number) => Math.min(60, 2 ** Math.max(0, attempt - 1)) * 60_000;

/** Awards of non-test travelers with a hex wallet and no command yet become queued commands. */
export async function enqueueEligibleBadges(pool: Pool, chainId: number, limit = ENQUEUE_BATCH): Promise<number> {
  const candidates = await pool.query(
    `SELECT a.id, lower(u.wallet_address) AS wallet
       FROM achievement_awards a
       JOIN users u ON u.id = a.user_id
      WHERE a.revoked_at IS NULL AND a.is_test = FALSE AND COALESCE(u.is_test, FALSE) = FALSE
        AND u.wallet_address ~* '^0x[0-9a-f]{40}$'
        AND NOT EXISTS (SELECT 1 FROM chain_commands c WHERE c.chain_id = $1 AND c.source_award_id = a.id)
      ORDER BY a.awarded_at, a.id
      LIMIT $2`, [chainId, limit]);
  let enqueued = 0;
  for (const row of candidates.rows) {
    const tokenId = badgeTokenId(row.id);
    const inserted = await pool.query(
      `INSERT INTO chain_commands (id, chain_id, entitlement_id, operation, recipient_address, status,
          expected_token_id, source_award_id, token_uri)
       VALUES ($1, $2, $3, 'badge_claim', $4, 'queued', $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [randomUUID(), chainId, badgeEntitlement(row.id), row.wallet, tokenId, row.id, badgeTokenUri(tokenId)]);
    enqueued += inserted.rowCount ?? 0;
  }
  return enqueued;
}

async function requeueOrFail(pool: Pool, commandId: string, attemptCount: number, maxAttempts: number,
  reason: string, now: Date): Promise<'retried' | 'failed'> {
  if (attemptCount >= maxAttempts) {
    await pool.query(`UPDATE chain_commands SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
      [commandId, reason]);
    return 'failed';
  }
  await pool.query(
    `UPDATE chain_commands SET status = 'queued', last_error = $2, next_attempt_at = $3, updated_at = now() WHERE id = $1`,
    [commandId, reason, new Date(now.getTime() + backoffMs(attemptCount))]);
  return 'retried';
}

/** Moves in-flight badge commands forward from what the chain reports. */
export async function reconcileBadgeCommands(pool: Pool, chain: BadgeChain, options: BadgeMinterOptions,
  result: BadgeTickResult): Promise<void> {
  const now = options.now ?? new Date();
  const rows = await pool.query(
    `SELECT c.id, c.status, c.entitlement_id, c.attempt_count,
            t.id AS attempt_id, t.tx_hash, t.nonce, t.block_number, t.block_hash, t.created_at AS sent_at
       FROM chain_commands c
       JOIN LATERAL (SELECT * FROM chain_transaction_attempts x WHERE x.command_id = c.id
                      ORDER BY x.created_at DESC LIMIT 1) t ON TRUE
      WHERE c.chain_id = $1 AND c.operation = 'badge_claim' AND c.status IN ('submitted', 'included')`,
    [options.chainId]);
  if (rows.rows.length === 0) return;
  const head = await chain.latestBlock();
  for (const row of rows.rows) {
    const receipt = await chain.receipt(row.tx_hash);
    if (!receipt) {
      if (row.status === 'included') {
        // The block that held it was reorganised away; wait for re-inclusion.
        await pool.query(`UPDATE chain_commands SET status = 'submitted', updated_at = now() WHERE id = $1`, [row.id]);
        await pool.query(`UPDATE chain_transaction_attempts SET status = 'submitted', block_number = NULL,
          block_hash = NULL, updated_at = now() WHERE id = $1`, [row.attempt_id]);
        continue;
      }
      if (now.getTime() - new Date(row.sent_at).getTime() < STUCK_AFTER_MS) continue;
      // Nonce consumed by something else (dropped/replaced): mint again only if the badge is still missing.
      if ((await chain.minedNonce()) > Number(row.nonce)) {
        await pool.query(`UPDATE chain_transaction_attempts SET status = 'replaced', updated_at = now() WHERE id = $1`,
          [row.attempt_id]);
        if (await chain.isEntitlementUsed(row.entitlement_id)) {
          await pool.query(`UPDATE chain_commands SET status = 'finalized', last_error = NULL, updated_at = now() WHERE id = $1`, [row.id]);
          result.finalized += 1;
        } else {
          const outcome = await requeueOrFail(pool, row.id, Number(row.attempt_count), options.maxAttempts,
            'The transaction was dropped by the network.', now);
          result[outcome] += 1;
        }
      } else {
        await pool.query(`UPDATE chain_commands SET last_error = $2, updated_at = now() WHERE id = $1`,
          [row.id, 'Waiting for the network to include the transaction.']);
      }
      continue;
    }
    if (!receipt.success) {
      await pool.query(`UPDATE chain_transaction_attempts SET status = 'reverted', block_number = $2, block_hash = $3,
        updated_at = now() WHERE id = $1`, [row.attempt_id, receipt.blockNumber, receipt.blockHash]);
      if (await chain.isEntitlementUsed(row.entitlement_id)) {
        // Another transaction already minted this exact badge.
        await pool.query(`UPDATE chain_commands SET status = 'finalized', last_error = NULL, updated_at = now() WHERE id = $1`, [row.id]);
        result.finalized += 1;
      } else {
        const outcome = await requeueOrFail(pool, row.id, Number(row.attempt_count), options.maxAttempts,
          'The mint transaction reverted on-chain.', now);
        result[outcome] += 1;
      }
      continue;
    }
    if (row.status === 'submitted' || row.block_hash !== receipt.blockHash) {
      await pool.query(`UPDATE chain_transaction_attempts SET status = 'included', block_number = $2, block_hash = $3,
        updated_at = now() WHERE id = $1`, [row.attempt_id, receipt.blockNumber, receipt.blockHash]);
      if (row.status === 'submitted') {
        await pool.query(`UPDATE chain_commands SET status = 'included', last_error = NULL, updated_at = now() WHERE id = $1`, [row.id]);
        result.included += 1;
      }
    }
    if (head - receipt.blockNumber >= options.confirmations) {
      await pool.query(`UPDATE chain_commands SET status = 'finalized', updated_at = now() WHERE id = $1`, [row.id]);
      result.finalized += 1;
    }
  }
}

/** Sends at most one queued mint, and only when nothing is in flight. */
export async function sendNextBadge(pool: Pool, chain: BadgeChain, options: BadgeMinterOptions,
  result: BadgeTickResult): Promise<void> {
  const now = options.now ?? new Date();
  const inFlight = await pool.query(
    `SELECT 1 FROM chain_commands WHERE chain_id = $1 AND operation = 'badge_claim' AND status = 'submitted' LIMIT 1`,
    [options.chainId]);
  if (inFlight.rowCount) { result.skipped = 'in_flight'; return; }

  const next = await pool.query(
    `SELECT c.id, c.entitlement_id, c.recipient_address, c.expected_token_id::text AS token_id, c.token_uri,
            c.attempt_count, a.revoked_at
       FROM chain_commands c LEFT JOIN achievement_awards a ON a.id = c.source_award_id
      WHERE c.chain_id = $1 AND c.operation = 'badge_claim' AND c.status = 'queued' AND c.next_attempt_at <= $2
      ORDER BY c.created_at, c.id LIMIT 1`, [options.chainId, now]);
  const cmd = next.rows[0];
  if (!cmd) { result.skipped = 'idle'; return; }

  if (cmd.revoked_at) {
    await pool.query(`UPDATE chain_commands SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
      [cmd.id, 'The achievement was revoked before it was minted.']);
    result.failed += 1;
    return;
  }
  if ((await chain.balanceWei()) < MIN_ISSUER_BALANCE_WEI) { result.skipped = 'low_balance'; return; }
  if (await chain.isEntitlementUsed(cmd.entitlement_id)) {
    await pool.query(`UPDATE chain_commands SET status = 'finalized', last_error = NULL, updated_at = now() WHERE id = $1`, [cmd.id]);
    result.finalized += 1;
    return;
  }

  const attempt = Number(cmd.attempt_count) + 1;
  await pool.query(`UPDATE chain_commands SET attempt_count = $2, updated_at = now() WHERE id = $1`, [cmd.id, attempt]);
  try {
    const nonce = await chain.pendingNonce();
    const txHash = await chain.sendIssue({
      recipient: cmd.recipient_address, tokenId: cmd.token_id, entitlement: cmd.entitlement_id,
      uri: cmd.token_uri ?? badgeTokenUri(cmd.token_id), nonce,
    });
    await pool.query(
      `INSERT INTO chain_transaction_attempts (id, command_id, chain_id, tx_hash, status, nonce)
       VALUES ($1, $2, $3, $4, 'submitted', $5)`, [randomUUID(), cmd.id, options.chainId, txHash.toLowerCase(), nonce]);
    await pool.query(`UPDATE chain_commands SET status = 'submitted', last_error = NULL, updated_at = now() WHERE id = $1`, [cmd.id]);
    result.sent = txHash;
  } catch (err) {
    const outcome = await requeueOrFail(pool, cmd.id, attempt, options.maxAttempts, `Send failed: ${shortError(err)}`, now);
    result[outcome] += 1;
  }
}

export async function runBadgeMintTick(pool: Pool, chain: BadgeChain, options: BadgeMinterOptions): Promise<BadgeTickResult> {
  const result: BadgeTickResult = { enqueued: 0, included: 0, finalized: 0, retried: 0, failed: 0, sent: null };
  result.enqueued = await enqueueEligibleBadges(pool, options.chainId);
  await reconcileBadgeCommands(pool, chain, options, result);
  await sendNextBadge(pool, chain, options, result);
  return result;
}

// ---------------------------------------------------------------------------
// Real chain (ethers) — the issuer key is read from a file, never from env.

const BADGE_ABI = [
  'function issue(address recipient, uint256 tokenId, bytes32 entitlement, string uri)',
  'function usedEntitlement(bytes32) view returns (bool)',
];
const PRIORITY_FEE = parseUnits('30', 'gwei');
const MIN_MAX_FEE = parseUnits('60', 'gwei');

/** Reads a 32-byte hex key from a file. The error never contains file content. */
export function loadIssuerKey(path: string): string {
  if (!path) throw new Error('CHAIN_ISSUER_KEY_FILE is not set');
  const stat = statSync(path);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('CHAIN_ISSUER_KEY_FILE must not be readable by group or others (chmod 600)');
  }
  const raw = readFileSync(path, 'utf8').trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) throw new Error('CHAIN_ISSUER_KEY_FILE does not contain a valid key');
  return raw.startsWith('0x') ? raw : `0x${raw}`;
}

export class EthersBadgeChain implements BadgeChain {
  readonly issuer: string;
  private readonly providers: JsonRpcProvider[];
  private readonly wallet: Wallet;
  private readonly iface = new Interface(BADGE_ABI);

  constructor(rpcUrls: string[], private readonly chainId: number, private readonly badge: string, privateKey: string) {
    this.providers = rpcUrls.map((url) => new JsonRpcProvider(url, chainId, { staticNetwork: true }));
    this.wallet = new Wallet(privateKey);
    this.issuer = this.wallet.address.toLowerCase();
  }

  private async read<T>(fn: (p: JsonRpcProvider) => Promise<T>): Promise<T> {
    let last: unknown;
    for (const provider of this.providers) {
      try { return await fn(provider); } catch (err) { last = err; }
    }
    throw last instanceof Error ? last : new Error('CHAIN_RPC_UNAVAILABLE');
  }

  latestBlock() { return this.read((p) => p.getBlockNumber()); }
  balanceWei() { return this.read((p) => p.getBalance(this.issuer)); }
  pendingNonce() { return this.read((p) => p.getTransactionCount(this.issuer, 'pending')); }
  minedNonce() { return this.read((p) => p.getTransactionCount(this.issuer, 'latest')); }

  isEntitlementUsed(entitlement: string) {
    return this.read((p) => new Contract(this.badge, BADGE_ABI, p).usedEntitlement(entitlement) as Promise<boolean>);
  }

  async receipt(txHash: string): Promise<BadgeReceipt | null> {
    const r = await this.read((p) => p.getTransactionReceipt(txHash));
    return r ? { success: r.status === 1, blockNumber: r.blockNumber, blockHash: r.blockHash.toLowerCase() } : null;
  }

  async sendIssue(args: { recipient: string; tokenId: string; entitlement: string; uri: string; nonce: number }): Promise<string> {
    const data = this.iface.encodeFunctionData('issue', [args.recipient, BigInt(args.tokenId), args.entitlement, args.uri]);
    const [gas, block] = await Promise.all([
      this.read((p) => p.estimateGas({ from: this.issuer, to: this.badge, data })),
      this.read((p) => p.getBlock('latest')),
    ]);
    const baseFee = block?.baseFeePerGas ?? 0n;
    const maxFee = baseFee * 2n + PRIORITY_FEE > MIN_MAX_FEE ? baseFee * 2n + PRIORITY_FEE : MIN_MAX_FEE;
    const signed = await this.wallet.signTransaction({
      type: 2, chainId: this.chainId, to: this.badge, data, nonce: args.nonce,
      gasLimit: (gas * 12n) / 10n, maxPriorityFeePerGas: PRIORITY_FEE, maxFeePerGas: maxFee, value: 0n,
    });
    const hash = Transaction.from(signed).hash!;
    // Broadcasting the same signed bytes to a second RPC is harmless (same hash).
    await this.read((p) => p.broadcastTransaction(signed));
    return hash;
  }
}

// ---------------------------------------------------------------------------
// Background loop (off unless CHAIN_BADGE_MINTING_ENABLED).

let timer: NodeJS.Timeout | null = null;
let running = false;
let chainInstance: BadgeChain | null = null;
let chainError: string | null = null;

export function setBadgeChainForTests(chain: BadgeChain | null): void { chainInstance = chain; chainError = null; }

async function getBadgeChain(pool: Pool): Promise<BadgeChain | null> {
  if (chainInstance) return chainInstance;
  if (chainError) return null;
  const config = getChainConfig();
  try {
    const chain = new EthersBadgeChain(config.rpcUrls, config.chainId, config.contracts.badge, loadIssuerKey(env.CHAIN_ISSUER_KEY_FILE));
    // The key must belong to the registered, active badge issuer.
    const registered = await pool.query(
      `SELECT 1 FROM chain_wallets WHERE chain_id = $1 AND role = 'badge_issuer' AND active = TRUE AND address = $2`,
      [config.chainId, chain.issuer]);
    if (!registered.rowCount) throw new Error('the issuer key does not match an active badge_issuer wallet in the registry');
    chainInstance = chain;
    return chain;
  } catch (err) {
    chainError = shortError(err);
    console.error(`[badge-minter] disabled: ${chainError}`);
    return null;
  }
}

export function badgeMinterStatus(): { enabled: boolean; ready: boolean; error: string | null } {
  return { enabled: env.CHAIN_BADGE_MINTING_ENABLED, ready: chainInstance !== null, error: chainError };
}

async function tick(): Promise<void> {
  if (running) return;
  const pool = getPool();
  if (!pool) return;
  running = true;
  const client = await pool.connect();
  let locked = false;
  try {
    locked = Boolean((await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [BADGE_MINTER_LOCK_KEY])).rows[0]?.acquired);
    if (!locked) return;
    const chain = await getBadgeChain(pool);
    if (!chain) return;
    const config = getChainConfig();
    const r = await runBadgeMintTick(pool, chain, {
      chainId: config.chainId, confirmations: config.confirmations, maxAttempts: env.CHAIN_BADGE_MAX_ATTEMPTS,
    });
    if (r.enqueued || r.sent || r.included || r.finalized || r.retried || r.failed) {
      console.log(`[badge-minter] enqueued ${r.enqueued}, sent ${r.sent ?? 'none'}, included ${r.included}, finalized ${r.finalized}, retried ${r.retried}, failed ${r.failed}`);
    }
  } catch (err) {
    console.error('[badge-minter] tick failed:', shortError(err));
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [BADGE_MINTER_LOCK_KEY]).catch(() => {});
    client.release();
    running = false;
  }
}

/** Off unless CHAIN_BADGE_MINTING_ENABLED. Never keeps the process alive. */
export function startBadgeMinter(): void {
  if (!env.CHAIN_BADGE_MINTING_ENABLED || timer) return;
  const seconds = Math.max(10, env.CHAIN_BADGE_MINT_INTERVAL_SECONDS);
  timer = setInterval(() => { void tick(); }, seconds * 1000);
  timer.unref?.();
  const first = setTimeout(() => { void tick(); }, 5_000);
  first.unref?.();
  console.log(`[badge-minter] started (every ${seconds}s)`);
}

export function stopBadgeMinter(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[badge-minter] stopped');
  }
}
