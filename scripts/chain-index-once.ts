import pg from 'pg';
import { env } from '../src/config/env.js';
import { getChainConfig } from '../src/chain/config.js';
import { JsonRpcChainSource } from '../src/chain/rpc-source.js';
import { ChainIndexer } from '../src/chain/indexer.js';

/**
 * Preview/operator tool (Plan 49): index confirmed blocks into DATABASE_URL.
 * Not started by the server. Read-only toward the chain.
 *
 *   npm run chain:index -- [--blocks 500] [--until-head]
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const config = getChainConfig();
  const blocks = Number.parseInt(arg('--blocks') ?? '500', 10);
  const untilHead = process.argv.includes('--until-head');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  console.log(`Chain indexer for ${config.name} (${config.chainId}); start block ${config.startBlock}, confirmations ${config.confirmations}`);
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
  try {
    const source = new JsonRpcChainSource({
      rpcUrls: config.rpcUrls,
      distributor: config.contracts.distributor,
      badge: config.contracts.badge,
      token: config.contracts.token,
    });
    const indexer = new ChainIndexer(pool, source, {
      chainId: config.chainId,
      tokenDistributor: config.contracts.distributor,
      badge: config.contracts.badge,
      token: config.contracts.token,
      confirmations: config.confirmations,
      startBlock: config.startBlock,
    });
    let total = 0;
    for (;;) {
      const result = await indexer.sync(blocks);
      total += result.processed;
      console.log(`processed ${result.processed} block(s) (total ${total}); safe head ${result.safeHead}`);
      if (!untilHead || result.processed === 0) break;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Chain indexing error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
