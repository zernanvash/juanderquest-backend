import { Router, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { authenticateToken, requireAdmin, type AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { env } from '../config/env.js';
import { getChainConfig, explorerTx } from '../chain/config.js';
import { isBadgeTokenId } from '../chain/badgeIdentity.js';
import { badgeMinterStatus } from '../chain/badgeMinter.js';

/**
 * Plan 50: on-chain badge status for travelers, public ERC-721 metadata for
 * wallets and explorers, and the admin minting queue.
 */
export const chainBadgesRouter = Router();

export type BadgeState = 'test_only' | 'revoked' | 'pending_wallet' | 'queued' | 'minting' | 'on_chain' | 'failed';

export function badgeState(row: { is_test: boolean; revoked_at: unknown; wallet: string | null; status: string | null }): BadgeState {
  if (row.is_test) return 'test_only';
  if (row.status === 'finalized') return row.revoked_at ? 'revoked' : 'on_chain';
  if (row.revoked_at) return 'revoked';
  if (!row.status) return row.wallet && /^0x[0-9a-f]{40}$/i.test(row.wallet) ? 'queued' : 'pending_wallet';
  if (row.status === 'queued') return 'queued';
  if (row.status === 'failed') return 'failed';
  return 'minting';
}

const nftUrl = (explorer: string, contract: string, tokenId: string) => `${explorer}/nft/${contract}/${tokenId}`;

const unavailable = (res: Response) =>
  res.status(503).json({ success: false, error: { code: 'STORAGE_UNAVAILABLE', message: 'Badge storage is unavailable.' } });
const failed = (res: Response) =>
  res.status(500).json({ success: false, error: { code: 'BADGES_UNAVAILABLE', message: 'Badges could not be loaded.' } });

chainBadgesRouter.get('/me/chain/badges', authenticateToken,
  rateLimit({ policyId: 'me:chain-badges', windowMs: 60_000, max: 60, keyStrategy: 'actor_or_ip' }),
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) return unavailable(res);
    try {
      const config = getChainConfig();
      const rows = await pool.query(
        `SELECT a.id, a.achievement_id, a.awarded_at, a.revoked_at, (a.is_test OR COALESCE(u.is_test, FALSE)) AS is_test,
                d.title, d.description, d.badge_icon, d.track, d.category, u.wallet_address AS wallet,
                c.status, c.expected_token_id::text AS token_id, c.recipient_address, c.last_error,
                (SELECT t.tx_hash FROM chain_transaction_attempts t WHERE t.command_id = c.id
                  ORDER BY t.created_at DESC LIMIT 1) AS tx_hash
           FROM achievement_awards a
           JOIN users u ON u.id = a.user_id
           JOIN achievement_definitions d ON d.id = a.achievement_id
           LEFT JOIN chain_commands c ON c.chain_id = $2 AND c.source_award_id = a.id
          WHERE a.user_id = $1
          ORDER BY a.awarded_at DESC`, [req.user!.id, config.chainId]);
      const wallet = rows.rows[0]?.wallet ?? (await pool.query('SELECT wallet_address FROM users WHERE id = $1', [req.user!.id])).rows[0]?.wallet_address ?? null;
      return res.json({
        success: true,
        data: {
          walletAddress: wallet,
          mintingEnabled: env.CHAIN_BADGE_MINTING_ENABLED,
          chain: { id: config.chainId, name: config.name, explorer: config.explorer, badgeContract: config.contracts.badge },
          badges: rows.rows.map((r) => {
            const state = badgeState(r);
            return {
              awardId: r.id, achievementId: r.achievement_id, title: r.title, description: r.description,
              icon: r.badge_icon, track: r.track, category: r.category, awardedAt: r.awarded_at, state,
              tokenId: r.token_id ?? null,
              recipient: r.recipient_address ?? null,
              txHash: r.tx_hash ?? null,
              txUrl: r.tx_hash ? explorerTx(r.tx_hash, config.explorer) : null,
              tokenUrl: r.token_id && (state === 'on_chain' || state === 'revoked') ? nftUrl(config.explorer, config.contracts.badge, r.token_id) : null,
            };
          }),
        },
      });
    } catch (err) {
      console.error('[chain-badges] me failed:', err instanceof Error ? err.message : err);
      return failed(res);
    }
  });

const TRACK_COLORS: Record<string, [string, string]> = {
  explorer: ['#2d6a4f', '#beead1'],
  civic: ['#7d5800', '#ffe3a3'],
  scout: ['#1d4ed8', '#c7d7fe'],
};
const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));

async function loadBadge(tokenId: string) {
  const pool = getPool();
  if (!pool) return { pool: null, row: null };
  const config = getChainConfig();
  const result = await pool.query(
    `SELECT d.title, d.description, d.track, d.category, a.awarded_at, a.revoked_at
       FROM chain_commands c
       JOIN achievement_awards a ON a.id = c.source_award_id
       JOIN achievement_definitions d ON d.id = a.achievement_id
      WHERE c.chain_id = $1 AND c.operation = 'badge_claim' AND c.expected_token_id = $2::numeric`,
    [config.chainId, tokenId]);
  return { pool, row: result.rows[0] ?? null };
}

const publicLimit = rateLimit({ policyId: 'chain:badge-metadata', windowMs: 60_000, max: 120 });

/** ERC-721 metadata (tokenURI). Public: wallets and explorers fetch it. No traveler data. */
chainBadgesRouter.get('/chain/badges/:tokenId', publicLimit, async (req, res) => {
  const tokenId = String(req.params.tokenId);
  if (!isBadgeTokenId(tokenId)) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
  try {
    const { pool, row } = await loadBadge(tokenId);
    if (!pool) return unavailable(res);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
    const base = env.PUBLIC_API_BASE.replace(/\/+$/, '');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json({
      name: `JuanDerQuest · ${row.title}`,
      description: `${row.description} Soulbound test badge on Polygon Amoy; it cannot be transferred and has no monetary value.${row.revoked_at ? ' This award was later revoked.' : ''}`,
      image: `${base}/api/v1/chain/badges/${tokenId}/image.svg`,
      external_url: 'https://juanderquest.app',
      attributes: [
        { trait_type: 'Track', value: row.track },
        { trait_type: 'Category', value: row.category },
        { trait_type: 'Awarded', display_type: 'date', value: Math.floor(new Date(row.awarded_at).getTime() / 1000) },
        { trait_type: 'Status', value: row.revoked_at ? 'Revoked' : 'Active' },
      ],
    });
  } catch (err) {
    console.error('[chain-badges] metadata failed:', err instanceof Error ? err.message : err);
    return failed(res);
  }
});

chainBadgesRouter.get('/chain/badges/:tokenId/image.svg', publicLimit, async (req, res) => {
  const tokenId = String(req.params.tokenId);
  if (!isBadgeTokenId(tokenId)) return res.status(404).end();
  try {
    const { pool, row } = await loadBadge(tokenId);
    if (!pool) return res.status(503).end();
    if (!row) return res.status(404).end();
    const [dark, light] = TRACK_COLORS[row.track] ?? ['#582f0e', '#f1e4cf'];
    const title = xml(String(row.title).slice(0, 28));
    const track = xml(String(row.track).toUpperCase());
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    return res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="64" fill="${light}"/>
  <circle cx="256" cy="210" r="120" fill="${dark}"/>
  <circle cx="256" cy="210" r="96" fill="none" stroke="${light}" stroke-width="6" stroke-dasharray="10 8"/>
  <text x="256" y="232" text-anchor="middle" font-family="Georgia, serif" font-size="72" font-weight="700" fill="${light}">JDQ</text>
  <text x="256" y="390" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="700" fill="${dark}">${title}</text>
  <text x="256" y="438" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="20" letter-spacing="4" fill="${dark}" opacity="0.75">${track} · SOULBOUND</text>${row.revoked_at ? `
  <text x="256" y="480" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="18" fill="#bc4749">REVOKED</text>` : ''}
</svg>`);
  } catch {
    return res.status(500).end();
  }
});

// --- Admin ------------------------------------------------------------------

const adminGuard = [authenticateToken, requireAdmin,
  rateLimit({ policyId: 'admin:chain-badges', windowMs: 60_000, max: 30, keyStrategy: 'actor_or_ip' })] as const;

chainBadgesRouter.get('/admin/chain/badges', ...adminGuard, async (_req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return unavailable(res);
  try {
    const config = getChainConfig();
    const [counts, waiting, recent] = await Promise.all([
      pool.query(`SELECT status, count(*)::int AS n FROM chain_commands
                   WHERE chain_id = $1 AND operation = 'badge_claim' GROUP BY status`, [config.chainId]),
      pool.query(`SELECT count(*)::int AS n FROM achievement_awards a JOIN users u ON u.id = a.user_id
                   WHERE a.revoked_at IS NULL AND a.is_test = FALSE AND COALESCE(u.is_test, FALSE) = FALSE
                     AND (u.wallet_address IS NULL OR u.wallet_address !~* '^0x[0-9a-f]{40}$')`),
      pool.query(`SELECT c.id, c.status, c.recipient_address, c.expected_token_id::text AS token_id, c.attempt_count,
                         c.last_error, c.updated_at, d.title, u.display_name,
                         (SELECT t.tx_hash FROM chain_transaction_attempts t WHERE t.command_id = c.id
                           ORDER BY t.created_at DESC LIMIT 1) AS tx_hash
                    FROM chain_commands c
                    JOIN achievement_awards a ON a.id = c.source_award_id
                    JOIN achievement_definitions d ON d.id = a.achievement_id
                    JOIN users u ON u.id = a.user_id
                   WHERE c.chain_id = $1 AND c.operation = 'badge_claim'
                   ORDER BY (c.status = 'failed') DESC, c.updated_at DESC LIMIT 25`, [config.chainId]),
    ]);
    const byStatus: Record<string, number> = {};
    counts.rows.forEach((r) => { byStatus[r.status] = r.n; });
    return res.json({
      success: true,
      data: {
        minter: badgeMinterStatus(),
        counts: {
          waitingForWallet: waiting.rows[0]?.n ?? 0,
          queued: byStatus.queued ?? 0,
          minting: (byStatus.submitted ?? 0) + (byStatus.included ?? 0) + (byStatus.unknown ?? 0),
          onChain: byStatus.finalized ?? 0,
          failed: byStatus.failed ?? 0,
        },
        recent: recent.rows.map((r) => ({
          id: r.id, status: r.status, title: r.title, traveler: r.display_name, recipient: r.recipient_address,
          tokenId: r.token_id, attempts: r.attempt_count, lastError: r.last_error, updatedAt: r.updated_at,
          txUrl: r.tx_hash ? explorerTx(r.tx_hash, config.explorer) : null,
          tokenUrl: r.status === 'finalized' ? nftUrl(config.explorer, config.contracts.badge, r.token_id) : null,
        })),
      },
    });
  } catch (err) {
    console.error('[chain-badges] admin list failed:', err instanceof Error ? err.message : err);
    return failed(res);
  }
});

const LEDGER_STATES = ['pending_wallet', 'queued', 'minting', 'on_chain', 'failed', 'revoked'] as const;

/** Every earned (non-test) badge with its traveler and on-chain state — the admin ledger. */
chainBadgesRouter.get('/admin/chain/badges/ledger', ...adminGuard, async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return unavailable(res);
  const stateFilter = typeof req.query.state === 'string' && (LEDGER_STATES as readonly string[]).includes(req.query.state)
    ? req.query.state : null;
  const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80).toLowerCase() : '';
  try {
    const config = getChainConfig();
    const rows = await pool.query(
      `SELECT a.id AS award_id, a.awarded_at, a.revoked_at, FALSE AS is_test,
              d.title, d.track, u.id AS user_id, u.display_name, u.handle, u.wallet_address AS wallet,
              c.id AS command_id, c.status, c.recipient_address, c.expected_token_id::text AS token_id,
              c.attempt_count, c.last_error, c.updated_at,
              (SELECT t.tx_hash FROM chain_transaction_attempts t WHERE t.command_id = c.id
                ORDER BY t.created_at DESC LIMIT 1) AS tx_hash
         FROM achievement_awards a
         JOIN users u ON u.id = a.user_id
         JOIN achievement_definitions d ON d.id = a.achievement_id
         LEFT JOIN chain_commands c ON c.chain_id = $1 AND c.source_award_id = a.id
        WHERE a.is_test = FALSE AND COALESCE(u.is_test, FALSE) = FALSE
          AND ($2 = '' OR lower(u.display_name) LIKE '%' || $2 || '%' OR lower(COALESCE(u.handle, '')) LIKE '%' || $2 || '%'
               OR lower(d.title) LIKE '%' || $2 || '%' OR lower(COALESCE(u.wallet_address, '')) LIKE '%' || $2 || '%')
        ORDER BY (c.status = 'failed') DESC NULLS LAST, a.awarded_at DESC
        LIMIT 500`, [config.chainId, search]);
    const entries = rows.rows.map((r) => {
      const state = badgeState(r);
      return {
        awardId: r.award_id, title: r.title, track: r.track, awardedAt: r.awarded_at,
        traveler: { id: r.user_id, name: r.display_name, handle: r.handle ?? null },
        wallet: r.recipient_address ?? (r.wallet && /^0x[0-9a-f]{40}$/i.test(r.wallet) ? String(r.wallet).toLowerCase() : null),
        state, commandId: r.command_id ?? null, attempts: r.attempt_count ?? 0, lastError: r.last_error ?? null,
        updatedAt: r.updated_at ?? r.awarded_at, tokenId: r.token_id ?? null,
        txUrl: r.tx_hash ? explorerTx(r.tx_hash, config.explorer) : null,
        tokenUrl: r.token_id && (state === 'on_chain' || state === 'revoked') ? nftUrl(config.explorer, config.contracts.badge, r.token_id) : null,
      };
    });
    const totals: Record<string, number> = Object.fromEntries(LEDGER_STATES.map((s) => [s, 0]));
    entries.forEach((e) => { totals[e.state] = (totals[e.state] ?? 0) + 1; });
    return res.json({
      success: true,
      data: { totals, total: entries.length, entries: stateFilter ? entries.filter((e) => e.state === stateFilter) : entries },
    });
  } catch (err) {
    console.error('[chain-badges] ledger failed:', err instanceof Error ? err.message : err);
    return failed(res);
  }
});

chainBadgesRouter.post('/admin/chain/badges/:commandId/retry', ...adminGuard, async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return unavailable(res);
  try {
    const updated = await pool.query(
      `UPDATE chain_commands SET status = 'queued', attempt_count = 0, last_error = NULL, next_attempt_at = now(), updated_at = now()
        WHERE id = $1 AND operation = 'badge_claim' AND status = 'failed' RETURNING id`, [String(req.params.commandId)]);
    if (!updated.rowCount) {
      return res.status(409).json({ success: false, error: { code: 'NOT_RETRYABLE', message: 'Only failed mints can be retried.' } });
    }
    console.log(`[chain-badges] admin ${req.user!.id} requeued ${req.params.commandId}`);
    return res.json({ success: true, data: { id: updated.rows[0].id, status: 'queued' } });
  } catch (err) {
    console.error('[chain-badges] retry failed:', err instanceof Error ? err.message : err);
    return failed(res);
  }
});
