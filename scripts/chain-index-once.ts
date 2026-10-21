import { pool } from '../src/db/pool.js';
import { getChainConfig } from '../src/chain/config.js';
import { JsonRpcChainSource } from '../src/chain/rpc-source.js';
import { ChainIndexer } from '../src/chain/indexer.js';

async function main() {
  const config = getChainConfig();
  console.log(`Starting one-shot chain indexer for ${config.name} (Chain ID: ${config.chainId})...`);
  console.log(`RPCs: ${config.rpcUrls.join(', ')}`);
  console.log(`Contracts: Token=${config.contracts.token}, Distributor=${config.contracts.distributor}, Badge=${config.contracts.badge}`);
  console.log(`Start block: ${config.startBlock}, Confirmations: ${config.confirmations}`);

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

  const result = await indexer.sync(500);
  console.log(`Indexed successfully: processed ${result.processed} blocks, safe head at ${result.safeHead}.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Chain indexing error:', err);
  process.exit(1);
});
