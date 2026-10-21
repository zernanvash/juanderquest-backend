import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { getChainConfig } from './config.js';

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const POLYGON_AMOY_CHAIN_ID = 80002;
const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

export type ChainEventName = 'Claimed' | 'BadgeIssued' | 'RoleGranted' | 'RoleRevoked' | 'Paused' | 'Unpaused';

export interface ObservedLog {
  txHash: string;
  logIndex: number;
  address: string;
  eventName: ChainEventName;
  entitlement?: string;
  recipient?: string;
  amountWei?: string;
  tokenId?: string;
  roleHash?: string;
  account?: string;
  sender?: string;
}

export interface ObservedBlock {
  number: number;
  hash: string;
  parentHash: string;
  logs: ObservedLog[];
}

export interface ChainSource {
  getChainId(): Promise<number>;
  getLatestBlockNumber(): Promise<number>;
  getBlock(number: number): Promise<ObservedBlock>;
}

export interface ChainIndexerOptions {
  chainId?: number;
  tokenDistributor: string;
  badge: string;
  token?: string;
  confirmations: number;
  startBlock: number;
}

function checkedBlock(block: ObservedBlock, expected: number, options: ChainIndexerOptions): void {
  if (!Number.isSafeInteger(block.number) || block.number !== expected || !HASH.test(block.hash)
      || !HASH.test(block.parentHash) || !Array.isArray(block.logs)) throw new Error('INVALID_CHAIN_BLOCK');
  const seen = new Set<string>();
  for (const log of block.logs) {
    if (!HASH.test(log.txHash) || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || !ADDRESS.test(log.address)) {
      throw new Error('INVALID_CHAIN_LOG');
    }
    if (log.eventName === 'Claimed') {
      if (log.address !== options.tokenDistributor || !log.entitlement || !HASH.test(log.entitlement) || !log.recipient || !ADDRESS.test(log.recipient)) {
        throw new Error('INVALID_CHAIN_LOG');
      }
      if (!log.amountWei || !/^[1-9][0-9]*$/.test(log.amountWei)) {
        throw new Error('INVALID_CHAIN_LOG_AMOUNT');
      }
    } else if (log.eventName === 'BadgeIssued') {
      if (log.address !== options.badge || !log.entitlement || !HASH.test(log.entitlement) || !log.recipient || !ADDRESS.test(log.recipient)) {
        throw new Error('INVALID_CHAIN_LOG');
      }
      if (log.tokenId === undefined || !/^(0|[1-9][0-9]*)$/.test(log.tokenId)) {
        throw new Error('INVALID_CHAIN_LOG_TOKEN_ID');
      }
    } else if (log.eventName === 'RoleGranted' || log.eventName === 'RoleRevoked') {
      if (!log.roleHash || !HASH.test(log.roleHash) || !log.account || !ADDRESS.test(log.account) || !log.sender || !ADDRESS.test(log.sender)) {
        throw new Error('INVALID_CHAIN_LOG_ROLE');
      }
    } else if (log.eventName === 'Paused' || log.eventName === 'Unpaused') {
      if (!log.account || !ADDRESS.test(log.account)) {
        throw new Error('INVALID_CHAIN_LOG_PAUSE');
      }
    } else {
      throw new Error('INVALID_CHAIN_LOG');
    }
    const key = `${log.txHash}:${log.logIndex}`;
    if (seen.has(key)) throw new Error('DUPLICATE_CHAIN_LOG_IN_BLOCK');
    seen.add(key);
  }
}

async function checkpoint(client: PoolClient, chainId: number): Promise<{ block_number: string; block_hash: string } | null> {
  const result = await client.query(
    'SELECT block_number, block_hash FROM chain_checkpoints WHERE chain_id = $1 FOR UPDATE',
    [chainId]
  );
  return result.rows[0] ?? null;
}

async function projectCommands(client: PoolClient, options: ChainIndexerOptions, chainId: number): Promise<void> {
  await client.query(`
    UPDATE chain_commands c SET status = CASE WHEN EXISTS (
      SELECT 1 FROM chain_events e WHERE e.chain_id = c.chain_id
        AND e.canonical = TRUE AND e.payload ->> 'entitlement' = c.entitlement_id
        AND EXISTS (SELECT 1 FROM chain_block_headers h
          WHERE h.chain_id = e.chain_id AND h.block_number = e.block_number
            AND h.block_hash = e.block_hash AND h.canonical = TRUE)
        AND lower(e.payload ->> 'recipient') = lower(c.recipient_address)
        AND ((c.operation = 'test_token_claim' AND e.event_name = 'Claimed'
              AND e.contract_address = $2
              AND c.expected_amount_wei IS NOT NULL
              AND e.payload ->> 'amountWei' = c.expected_amount_wei::text)
          OR (c.operation = 'badge_claim' AND e.event_name = 'BadgeIssued'
              AND e.contract_address = $3
              AND c.expected_token_id IS NOT NULL
              AND e.payload ->> 'tokenId' = c.expected_token_id::text))
    ) THEN 'finalized' WHEN c.status = 'finalized' THEN 'unknown' ELSE c.status END,
    updated_at = now()
    WHERE c.chain_id = $1 AND c.status IN ('queued', 'submitted', 'included', 'finalized', 'unknown')
  `, [chainId, options.tokenDistributor, options.badge]);
}

/** Project canonical on-chain role and pause events into chain_wallet_audit */
async function projectRoleAndPauseEvents(client: PoolClient, chainId: number): Promise<void> {
  const events = await client.query(`
    SELECT e.id, e.chain_id, e.tx_hash, e.log_index, e.block_number, e.event_name,
           e.contract_address, e.payload
    FROM chain_events e
    JOIN chain_block_headers h
      ON h.chain_id = e.chain_id AND h.block_number = e.block_number AND h.block_hash = e.block_hash AND h.canonical = TRUE
    WHERE e.chain_id = $1 AND e.canonical = TRUE
      AND e.event_name IN ('RoleGranted', 'RoleRevoked', 'Paused', 'Unpaused')
      AND NOT EXISTS (
        SELECT 1 FROM chain_wallet_audit a
        WHERE a.chain_id = e.chain_id
          AND a.tx_hash = e.tx_hash
          AND a.action = e.event_name
          AND COALESCE(a.wallet_address, '') = COALESCE(lower(e.payload ->> 'account'), '')
          AND COALESCE(a.role_hash, '') = COALESCE(lower(e.payload ->> 'roleHash'), '')
      )
    ORDER BY e.block_number ASC, e.log_index ASC
  `, [chainId]);

  for (const row of events.rows) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const actorAddress = payload.sender ? payload.sender.toLowerCase() : (payload.account ? payload.account.toLowerCase() : null);
    const walletAddress = payload.account ? payload.account.toLowerCase() : null;
    const roleHash = payload.roleHash ? payload.roleHash.toLowerCase() : null;
    const contractAddress = row.contract_address ? row.contract_address.toLowerCase() : null;

    await client.query(`
      INSERT INTO chain_wallet_audit (
        id, chain_id, source, action, actor_address, wallet_address,
        contract_address, role_hash, tx_hash, block_number, details
      )
      VALUES ($1, $2, 'onchain', $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT (chain_id, tx_hash, action, wallet_address, role_hash) DO NOTHING
    `, [
      randomUUID(),
      chainId,
      row.event_name,
      actorAddress,
      walletAddress,
      contractAddress,
      roleHash,
      row.tx_hash,
      row.block_number,
      JSON.stringify(payload),
    ]);
  }
}

/** Read-only toward RPC; only locally confirmed logs can change SQL projections. */
export class ChainIndexer {
  private readonly chainId: number;

  constructor(private readonly pool: Pool, private readonly source: ChainSource,
    private readonly options: ChainIndexerOptions) {
    this.chainId = options.chainId ?? getChainConfig().chainId;
    if (!ADDRESS.test(options.tokenDistributor) || !ADDRESS.test(options.badge)
        || options.tokenDistributor === options.badge
        || !Number.isSafeInteger(options.confirmations) || options.confirmations < 1
        || !Number.isSafeInteger(options.startBlock) || options.startBlock < 0) {
      throw new Error('INVALID_CHAIN_INDEXER_CONFIG');
    }
  }

  private async current(): Promise<{ number: number; hash: string } | null> {
    const result = await this.pool.query(
      'SELECT block_number, block_hash FROM chain_checkpoints WHERE chain_id = $1', [this.chainId]
    );
    const row = result.rows[0];
    return row ? { number: Number(row.block_number), hash: row.block_hash } : null;
  }

  private async rewindTo(number: number, hash: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const old = await checkpoint(client, this.chainId);
      if (!old || Number(old.block_number) <= number) throw new Error('CHAIN_CHECKPOINT_CHANGED');
      await client.query(`UPDATE chain_events SET canonical = FALSE
        WHERE chain_id = $1 AND block_number > $2 AND canonical`, [this.chainId, number]);
      await client.query(`UPDATE chain_block_headers SET canonical = FALSE
        WHERE chain_id = $1 AND block_number > $2 AND canonical`, [this.chainId, number]);
      await client.query(`UPDATE chain_checkpoints SET block_number = $2, block_hash = $3, updated_at = now()
        WHERE chain_id = $1`, [this.chainId, number, hash]);
      // Remove any audit projections from reorged blocks
      await client.query(`DELETE FROM chain_wallet_audit
        WHERE chain_id = $1 AND source = 'onchain' AND block_number > $2`, [this.chainId, number]);
      await projectCommands(client, this.options, this.chainId);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  private async reconcileHead(): Promise<void> {
    const current = await this.current();
    if (!current) return;
    const networkHead = await this.source.getBlock(current.number);
    checkedBlock(networkHead, current.number, this.options);
    if (networkHead.hash === current.hash) return;
    let ancestor = current.number - 1;
    while (ancestor >= this.options.startBlock) {
      const observed = await this.pool.query(`SELECT block_hash FROM chain_block_headers
        WHERE chain_id = $1 AND block_number = $2 AND canonical = TRUE`, [this.chainId, ancestor]);
      const network = await this.source.getBlock(ancestor);
      checkedBlock(network, ancestor, this.options);
      if (observed.rows[0]?.block_hash === network.hash) {
        await this.rewindTo(ancestor, network.hash);
        return;
      }
      ancestor--;
    }
    throw new Error('CHAIN_REORG_BEYOND_START_BLOCK');
  }

  private async storeBlock(block: ObservedBlock): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const old = await checkpoint(client, this.chainId);
      if (old && (Number(old.block_number) !== block.number - 1 || old.block_hash !== block.parentHash)) {
        throw new Error('CHAIN_CHECKPOINT_CHANGED');
      }
      if (!old && block.number !== this.options.startBlock) throw new Error('CHAIN_START_BLOCK_MISMATCH');
      const header = await client.query(`INSERT INTO chain_block_headers
        (chain_id,block_number,block_hash,parent_hash,canonical) VALUES($1,$2,$3,$4,TRUE)
        ON CONFLICT(chain_id,block_number,block_hash) DO UPDATE SET canonical=TRUE
        WHERE chain_block_headers.parent_hash = EXCLUDED.parent_hash RETURNING block_hash`,
      [this.chainId, block.number, block.hash, block.parentHash]);
      if (header.rowCount !== 1) throw new Error('CHAIN_HEADER_EQUIVOCATION');
      for (const log of block.logs) {
        const payloadObj: Record<string, unknown> = {};
        if (log.entitlement) payloadObj.entitlement = log.entitlement;
        if (log.recipient) payloadObj.recipient = log.recipient;
        if (log.amountWei) payloadObj.amountWei = log.amountWei;
        if (log.tokenId !== undefined) payloadObj.tokenId = log.tokenId;
        if (log.roleHash) payloadObj.roleHash = log.roleHash;
        if (log.account) payloadObj.account = log.account;
        if (log.sender) payloadObj.sender = log.sender;

        const event = await client.query(`INSERT INTO chain_events
          (id,chain_id,tx_hash,log_index,block_number,block_hash,event_name,payload,canonical,contract_address)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,TRUE,$9)
          ON CONFLICT(chain_id,block_hash,tx_hash,log_index) DO UPDATE SET canonical=TRUE
          WHERE chain_events.block_number = EXCLUDED.block_number
            AND chain_events.event_name = EXCLUDED.event_name
            AND chain_events.payload = EXCLUDED.payload
            AND chain_events.contract_address = EXCLUDED.contract_address
          RETURNING id`,
        [randomUUID(), this.chainId, log.txHash, log.logIndex, block.number,
          block.hash, log.eventName, JSON.stringify(payloadObj), log.address]);
        if (event.rowCount !== 1) throw new Error('CHAIN_LOG_EQUIVOCATION');
      }
      await client.query(`INSERT INTO chain_checkpoints(chain_id,block_number,block_hash)
        VALUES($1,$2,$3) ON CONFLICT(chain_id) DO UPDATE
        SET block_number=EXCLUDED.block_number, block_hash=EXCLUDED.block_hash, updated_at=now()`,
      [this.chainId, block.number, block.hash]);
      await projectCommands(client, this.options, this.chainId);
      await projectRoleAndPauseEvents(client, this.chainId);
      await client.query('COMMIT');
      return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async sync(maxBlocks = 100): Promise<{ processed: number; safeHead: number }> {
    if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 1000) throw new Error('INVALID_SYNC_LIMIT');
    if (await this.source.getChainId() !== this.chainId) throw new Error('WRONG_CHAIN_ID');
    const latest = await this.source.getLatestBlockNumber();
    if (!Number.isSafeInteger(latest) || latest < 0) throw new Error('INVALID_CHAIN_HEAD');
    const safeHead = latest - this.options.confirmations;
    await this.reconcileHead();
    let current = await this.current();
    let processed = 0;
    while (processed < maxBlocks && (current?.number ?? this.options.startBlock - 1) < safeHead) {
      const next = (current?.number ?? this.options.startBlock - 1) + 1;
      const block = await this.source.getBlock(next);
      checkedBlock(block, next, this.options);
      if (current && block.parentHash !== current.hash) {
        await this.reconcileHead();
        current = await this.current();
        continue;
      }
      await this.storeBlock(block);
      current = { number: next, hash: block.hash };
      processed++;
    }
    return { processed, safeHead };
  }
}

/** Backward compatibility alias */
export class BaseSepoliaIndexer extends ChainIndexer {
  constructor(pool: Pool, source: ChainSource, options: ChainIndexerOptions) {
    super(pool, source, { ...options, chainId: options.chainId ?? BASE_SEPOLIA_CHAIN_ID });
  }
}
