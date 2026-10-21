import { env } from '../config/env.js';

export const SUPPORTED_CHAIN_IDS = [80002, 84532] as const;
export type SupportedChainId = typeof SUPPORTED_CHAIN_IDS[number];

export interface ChainConfig {
  chainId: SupportedChainId;
  name: string;
  currency: string;
  explorer: string;
  rpcUrls: string[];
  contracts: {
    token: string;
    distributor: string;
    badge: string;
  };
  confirmations: number;
  startBlock: number;
  overviewCacheSeconds: number;
  lowBalanceCheckMinutes: number;
  alertsEnabled: boolean;
}

export function parseRpcUrls(raw: string): string[] {
  const urls = raw
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  if (urls.length === 0) {
    throw new Error('CHAIN_RPC_URLS must contain at least one valid RPC URL');
  }
  for (const rpc of urls) {
    const parsed = new URL(rpc);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error(`INVALID_CHAIN_RPC_URL: ${rpc}`);
    }
  }
  return urls;
}

export function getChainConfig(): ChainConfig {
  const chainId = env.CHAIN_ID as SupportedChainId;
  const isAmoy = chainId === 80002;
  const name = isAmoy ? 'Polygon Amoy' : 'Base Sepolia';
  const currency = isAmoy ? 'POL' : 'ETH';
  const explorer = isAmoy ? 'https://amoy.polygonscan.com' : 'https://sepolia-explorer.base.org';

  return {
    chainId,
    name,
    currency,
    explorer,
    rpcUrls: parseRpcUrls(env.CHAIN_RPC_URLS),
    contracts: {
      token: env.CHAIN_TOKEN_ADDRESS.toLowerCase(),
      distributor: env.CHAIN_DISTRIBUTOR_ADDRESS.toLowerCase(),
      badge: env.CHAIN_BADGE_ADDRESS.toLowerCase(),
    },
    confirmations: env.CHAIN_CONFIRMATIONS,
    startBlock: env.CHAIN_START_BLOCK,
    overviewCacheSeconds: env.CHAIN_OVERVIEW_CACHE_SECONDS,
    lowBalanceCheckMinutes: env.CHAIN_LOW_BALANCE_CHECK_MINUTES,
    alertsEnabled: env.CHAIN_ALERTS_ENABLED,
  };
}

export function explorerTx(hash: string, customExplorer?: string): string {
  const base = (customExplorer || getChainConfig().explorer).replace(/\/+$/, '');
  return `${base}/tx/${hash}`;
}

export function explorerAddress(addr: string, customExplorer?: string): string {
  const base = (customExplorer || getChainConfig().explorer).replace(/\/+$/, '');
  return `${base}/address/${addr}`;
}
