import { Router, type Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getPool } from '../db/pool.js';
import { authenticateToken, requireAdmin, type AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { getChainConfig, explorerAddress, explorerTx, type ChainConfig } from '../chain/config.js';
import { getChainStateReader, isLowBalance, ROLE_HASHES, type ChainStateReader, type RoleName } from '../chain/stateReader.js';

/**
 * Plan 49 §4b — admin view of the project's chain wallets and contracts.
 * Read-only toward the chain; registry edits are audited. Private keys are never
 * accepted, stored or returned.
 */
export const chainAdminRouter = Router();

chainAdminRouter.use(authenticateToken, requireAdmin, rateLimit({
  policyId: 'admin:chain',
  windowMs: 60_000,
  max: 30,
  keyStrategy: 'actor_or_ip',
}));

export interface WalletRow {
  id: string; chain_id: string | number; address: string; label: string; role: string; custody: string;
  owner_name: string | null; low_balance_pol: string | null; needs_gas: boolean; active: boolean; notes: string | null;
}
export interface ContractRow { name: 'token' | 'distributor' | 'badge'; address: string }

export interface ExpectedRole { contract: ContractRow; role: RoleName; account: string; label: string; expected: boolean }

/**
 * What must (or must not) be true on-chain, derived from the registry:
 * - every contract: DEFAULT_ADMIN_ROLE for the server admin and each recovery admin;
 * - token: MINTER_ROLE for the distributor contract, and NOT for the server admin;
 * - distributor: SIGNER_ROLE for the signer; badge: ISSUER_ROLE for the badge issuer.
 */
export function expectedRoles(wallets: WalletRow[], contracts: ContractRow[]): ExpectedRole[] {
  const out: ExpectedRole[] = [];
  const distributor = contracts.find((c) => c.name === 'distributor');
  for (const contract of contracts) {
    for (const w of wallets) {
      if (w.role === 'admin' || w.role === 'recovery_admin') {
        out.push({ contract, role: 'DEFAULT_ADMIN_ROLE', account: w.address, label: w.label, expected: true });
      }
      if (contract.name === 'token' && w.role === 'admin') {
        out.push({ contract, role: 'MINTER_ROLE', account: w.address, label: w.label, expected: false });
      }
      if (contract.name === 'distributor' && w.role === 'signer') {
        out.push({ contract, role: 'SIGNER_ROLE', account: w.address, label: w.label, expected: true });
      }
      if (contract.name === 'badge' && w.role === 'badge_issuer') {
        out.push({ contract, role: 'ISSUER_ROLE', account: w.address, label: w.label, expected: true });
      }
    }
    if (contract.name === 'token' && distributor) {
      out.push({ contract, role: 'MINTER_ROLE', account: distributor.address, label: 'Distributor contract', expected: true });
    }
  }
  return out;
}

export async function buildOverview(config: ChainConfig, reader: ChainStateReader,
  wallets: WalletRow[], contracts: ContractRow[]) {
  const latestBlock = await reader.latestBlock();
  const rpcHealthy = latestBlock !== null;
  const uniqueAddresses = [...new Set(wallets.map((w) => w.address))];
  const live = new Map(await Promise.all(uniqueAddresses.map(async (a) =>
    [a, rpcHealthy ? await reader.wallet(a) : { balancePol: null, nonce: null }] as const)));

  const expectations = expectedRoles(wallets, contracts);
  const onChain = await Promise.all(expectations.map((e) =>
    rpcHealthy ? reader.hasRole(e.contract.address, ROLE_HASHES[e.role], e.account) : Promise.resolve(null)));
  const paused = new Map(await Promise.all(contracts.map(async (c) =>
    [c.address, c.name === 'distributor' && rpcHealthy ? await reader.paused(c.address) : null] as const)));

  return {
    chain: { id: config.chainId, name: config.name, currency: config.currency, explorer: config.explorer, rpcHealthy, latestBlock },
    wallets: wallets.map((w) => {
      const l = live.get(w.address) ?? { balancePol: null, nonce: null };
      return {
        id: w.id, address: w.address, label: w.label, role: w.role, custody: w.custody, ownerName: w.owner_name,
        balancePol: l.balancePol, nonce: l.nonce, lowBalancePol: w.low_balance_pol, needsGas: w.needs_gas,
        low: isLowBalance(l.balancePol, w.low_balance_pol, w.needs_gas), active: w.active, notes: w.notes,
        explorerUrl: explorerAddress(w.address, config.explorer),
      };
    }),
    contracts: contracts.map((c) => ({
      name: c.name,
      address: c.address,
      explorerUrl: explorerAddress(c.address, config.explorer),
      paused: paused.get(c.address) ?? null,
      roles: expectations.map((e, i) => ({ e, onChain: onChain[i] }))
        .filter(({ e }) => e.contract.address === c.address)
        .map(({ e, onChain: has }) => ({
          role: e.role, roleHash: ROLE_HASHES[e.role], account: e.account, label: e.label,
          expected: e.expected, onChain: has,
          // Unknown (RPC failure) is not drift.
          drift: has !== null && has !== e.expected,
        })),
    })),
    fetchedAt: new Date().toISOString(),
    cacheSeconds: config.overviewCacheSeconds,
  };
}

export async function loadRegistry(chainId: number) {
  const pool = getPool();
  if (!pool) return null;
  const [w, c] = await Promise.all([
    pool.query<WalletRow>(
      'SELECT * FROM chain_wallets WHERE chain_id = $1 AND active = TRUE ORDER BY created_at, label', [chainId]),
    pool.query<ContractRow>(
      'SELECT name, address FROM chain_contracts WHERE chain_id = $1 AND active = TRUE ORDER BY name', [chainId]),
  ]);
  return { wallets: w.rows, contracts: c.rows };
}

let cachedOverview: { at: number; chainId: number; data: unknown } | null = null;
export function clearChainOverviewCache() { cachedOverview = null; }

const noStorage = (res: Response) => res.status(503).json({
  success: false, error: { code: 'STORAGE_UNAVAILABLE', message: 'Chain registry needs the database.' },
});
const failure = (res: Response, code: string, err: unknown) => {
  console.error(`[chain-admin] ${code}:`, err instanceof Error ? err.message : err);
  return res.status(500).json({ success: false, error: { code, message: 'Something went wrong. Try again.' } });
};

// GET /api/v1/admin/chain/overview[?refresh=1]
chainAdminRouter.get('/overview', async (req: AuthRequest, res: Response) => {
  try {
    const config = getChainConfig();
    const now = Date.now();
    if (req.query.refresh !== '1' && cachedOverview && cachedOverview.chainId === config.chainId
        && now - cachedOverview.at < config.overviewCacheSeconds * 1000) {
      return res.json({ success: true, data: cachedOverview.data });
    }
    const registry = await loadRegistry(config.chainId);
    if (!registry) return noStorage(res);
    const data = await buildOverview(config, getChainStateReader(config.rpcUrls, config.chainId),
      registry.wallets, registry.contracts);
    cachedOverview = { at: now, chainId: config.chainId, data };
    return res.json({ success: true, data });
  } catch (err) {
    return failure(res, 'CHAIN_OVERVIEW_ERROR', err);
  }
});

/** Defence in depth: a key-like field name is always refused, before validation. */
const KEY_LIKE = /key|secret|mnemonic|seed|private/i;
function refuseKeyLikeFields(req: AuthRequest, res: Response, next: () => void) {
  const bad = Object.keys(req.body ?? {}).find((k) => KEY_LIKE.test(k));
  if (bad) {
    return res.status(400).json({
      success: false, error: { code: 'INVALID_FIELD', message: `Field "${bad}" is not accepted. Private keys never go in the registry.` },
    });
  }
  return next();
}

const createWalletSchema = z.object({
  chain_id: z.union([z.literal(80002), z.literal(84532)]),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  label: z.string().trim().min(1).max(80),
  role: z.enum(['admin', 'signer', 'badge_issuer', 'recovery_admin', 'treasury']),
  custody: z.enum(['server', 'personal']),
  owner_name: z.string().trim().max(80).optional(),
  low_balance_pol: z.number().nonnegative().max(1_000_000).optional(),
  needs_gas: z.boolean().optional(),
  notes: z.string().trim().max(500).optional(),
}).strict();

const patchWalletSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  owner_name: z.string().trim().max(80).nullable().optional(),
  low_balance_pol: z.number().nonnegative().max(1_000_000).nullable().optional(),
  needs_gas: z.boolean().optional(),
  active: z.boolean().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
}).strict();

// POST /api/v1/admin/chain/wallets
chainAdminRouter.post('/wallets', refuseKeyLikeFields, async (req: AuthRequest, res: Response) => {
  const parsed = createWalletSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten() } });
  }
  const pool = getPool();
  if (!pool) return noStorage(res);
  const d = parsed.data;
  const id = `chain-wallet-${randomUUID()}`;
  const address = d.address.toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO chain_wallets (id, chain_id, address, label, role, custody, owner_name, low_balance_pol, needs_gas, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, d.chain_id, address, d.label, d.role, d.custody, d.owner_name ?? null, d.low_balance_pol ?? null,
        d.needs_gas ?? (d.custody === 'server' && d.role !== 'signer'), d.notes ?? null]);
    await client.query(
      `INSERT INTO chain_wallet_audit (id, chain_id, source, action, actor_user_id, wallet_address, details)
       VALUES ($1, $2, 'registry', 'wallet_created', $3, $4, $5::jsonb)`,
      [randomUUID(), d.chain_id, req.user?.id ?? null, address, JSON.stringify({ ...d, address })]);
    await client.query('COMMIT');
    clearChainOverviewCache();
    return res.status(201).json({ success: true, data: { id, address } });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    if (err?.code === '23505') {
      return res.status(409).json({ success: false, error: { code: 'WALLET_EXISTS', message: 'This address already has that role in the registry.' } });
    }
    return failure(res, 'WALLET_CREATE_ERROR', err);
  } finally {
    client.release();
  }
});

// PATCH /api/v1/admin/chain/wallets/:id — address, role and custody are immutable (deactivate + create instead).
chainAdminRouter.patch('/wallets/:id', refuseKeyLikeFields, async (req: AuthRequest, res: Response) => {
  const parsed = patchWalletSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten() } });
  }
  const pool = getPool();
  if (!pool) return noStorage(res);
  const fields = Object.entries(parsed.data).filter(([, v]) => v !== undefined);
  if (fields.length === 0) {
    return res.status(400).json({ success: false, error: { code: 'NOTHING_TO_UPDATE', message: 'No editable field given.' } });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT chain_id, address FROM chain_wallets WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (existing.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Wallet not found.' } });
    }
    const sets = fields.map(([k], i) => `${k} = $${i + 2}`);
    await client.query(`UPDATE chain_wallets SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
      [req.params.id, ...fields.map(([, v]) => v)]);
    await client.query(
      `INSERT INTO chain_wallet_audit (id, chain_id, source, action, actor_user_id, wallet_address, details)
       VALUES ($1, $2, 'registry', 'wallet_updated', $3, $4, $5::jsonb)`,
      [randomUUID(), existing.rows[0].chain_id, req.user?.id ?? null, existing.rows[0].address, JSON.stringify(parsed.data)]);
    await client.query('COMMIT');
    clearChainOverviewCache();
    return res.json({ success: true, data: { id: req.params.id } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return failure(res, 'WALLET_UPDATE_ERROR', err);
  } finally {
    client.release();
  }
});

// GET /api/v1/admin/chain/audit?limit=50&before=<iso>
chainAdminRouter.get('/audit', async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return noStorage(res);
  try {
    const config = getChainConfig();
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? ''), 10) || 50, 1), 100);
    const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before))
      ? new Date(req.query.before).toISOString() : null;
    const params: unknown[] = [config.chainId];
    let sql = `SELECT a.*, u.display_name AS actor_name FROM chain_wallet_audit a
               LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.chain_id = $1`;
    if (before) { params.push(before); sql += ` AND a.created_at < $${params.length}`; }
    params.push(limit);
    sql += ` ORDER BY a.created_at DESC, a.block_number DESC NULLS LAST LIMIT $${params.length}`;
    const result = await pool.query(sql, params);
    return res.json({
      success: true,
      data: result.rows.map((r) => ({
        id: r.id, source: r.source, action: r.action, actorName: r.actor_name ?? null, actorAddress: r.actor_address,
        walletAddress: r.wallet_address, contractAddress: r.contract_address, roleHash: r.role_hash,
        txHash: r.tx_hash, blockNumber: r.block_number === null ? null : Number(r.block_number),
        details: r.details, createdAt: r.created_at,
        txExplorerUrl: r.tx_hash ? explorerTx(r.tx_hash, config.explorer) : null,
      })),
    });
  } catch (err) {
    return failure(res, 'AUDIT_FETCH_ERROR', err);
  }
});
