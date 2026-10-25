import { Interface, JsonRpcProvider } from 'ethers';
import type { ChainSource, ObservedBlock, ObservedLog } from './indexer.js';
import { parseRpcUrls } from './config.js';

const distributorAbi = new Interface([
  'event Claimed(bytes32 indexed entitlement,address indexed recipient,uint256 amount,uint256 epoch)',
  'event RoleGranted(bytes32 indexed role,address indexed account,address indexed sender)',
  'event RoleRevoked(bytes32 indexed role,address indexed account,address indexed sender)',
  'event Paused(address account)',
  'event Unpaused(address account)',
]);
const badgeAbi = new Interface([
  'event BadgeIssued(bytes32 indexed entitlement,address indexed recipient,uint256 indexed tokenId)',
  'event RoleGranted(bytes32 indexed role,address indexed account,address indexed sender)',
  'event RoleRevoked(bytes32 indexed role,address indexed account,address indexed sender)',
]);
const tokenAbi = new Interface([
  'event RoleGranted(bytes32 indexed role,address indexed account,address indexed sender)',
  'event RoleRevoked(bytes32 indexed role,address indexed account,address indexed sender)',
]);

export interface JsonRpcChainSourceOptions {
  rpcUrls: string[] | string;
  distributor: string;
  badge: string;
  token?: string;
  timeoutMs?: number;
}

/** Read-only JSON-RPC adapter with fallback across multiple RPC URLs. No signer, private key, sendTransaction or broadcast API. */
export class JsonRpcChainSource implements ChainSource {
  private readonly urls: string[];
  private readonly providers: JsonRpcProvider[];
  private readonly distributor: string;
  private readonly badge: string;
  private readonly token?: string;
  private readonly timeoutMs: number;

  constructor(optionsOrUrl: string | JsonRpcChainSourceOptions, distributor?: string, badge?: string) {
    if (typeof optionsOrUrl === 'string') {
      this.urls = parseRpcUrls(optionsOrUrl);
      this.distributor = (distributor || '').toLowerCase();
      this.badge = (badge || '').toLowerCase();
      this.timeoutMs = 5000;
    } else {
      this.urls = typeof optionsOrUrl.rpcUrls === 'string'
        ? parseRpcUrls(optionsOrUrl.rpcUrls)
        : optionsOrUrl.rpcUrls;
      if (this.urls.length === 0) {
        throw new Error('CHAIN_RPC_URLS must contain at least one valid RPC URL');
      }
      this.distributor = optionsOrUrl.distributor.toLowerCase();
      this.badge = optionsOrUrl.badge.toLowerCase();
      this.token = optionsOrUrl.token?.toLowerCase();
      this.timeoutMs = optionsOrUrl.timeoutMs ?? 5000;
    }

    this.providers = this.urls.map((u) => new JsonRpcProvider(u));
  }

  private async withFallback<T>(operation: (provider: JsonRpcProvider, index: number) => Promise<T>): Promise<T> {
    let lastError: unknown = null;
    const maxAttempts = Math.min(this.providers.length, 2);

    for (let i = 0; i < maxAttempts; i++) {
      const provider = this.providers[i];
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`RPC_TIMEOUT_${this.timeoutMs}MS`)), this.timeoutMs);
          timeout.unref?.();
        });
        return await Promise.race([operation(provider, i), timeoutPromise]);
      } catch (err) {
        lastError = err;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    throw lastError ?? new Error('ALL_CHAIN_RPCS_FAILED');
  }

  async getChainId(): Promise<number> {
    return this.withFallback(async (provider) => {
      const network = await provider.getNetwork();
      return Number(network.chainId);
    });
  }

  async getLatestBlockNumber(): Promise<number> {
    return this.withFallback((provider) => provider.getBlockNumber());
  }

  async getBlock(number: number): Promise<ObservedBlock> {
    return this.withFallback(async (provider) => {
      const block = await provider.getBlock(number);
      if (!block || !block.hash) throw new Error('CHAIN_BLOCK_UNAVAILABLE');

      const addresses = [this.distributor, this.badge];
      if (this.token) addresses.push(this.token);

      const logPromises = addresses.map((addr) =>
        provider.getLogs({ blockHash: block.hash ?? undefined, address: addr })
      );
      const logBatches = await Promise.all(logPromises);
      const rawLogs = logBatches.flat().sort((a, b) => a.index - b.index);

      const decoded: ObservedLog[] = [];

      for (const log of rawLogs) {
        if (!block.hash || log.blockHash.toLowerCase() !== block.hash.toLowerCase()) {
          throw new Error('CHAIN_REORG_DURING_FETCH');
        }
        const addr = log.address.toLowerCase();
        let parsed = null;

        if (addr === this.distributor) {
          parsed = distributorAbi.parseLog(log);
        } else if (addr === this.badge) {
          parsed = badgeAbi.parseLog(log);
        } else if (this.token && addr === this.token) {
          parsed = tokenAbi.parseLog(log);
        }

        if (!parsed) continue;

        if (parsed.name === 'Claimed') {
          decoded.push({
            txHash: log.transactionHash.toLowerCase(),
            logIndex: log.index,
            address: addr,
            eventName: 'Claimed',
            entitlement: String(parsed.args.entitlement).toLowerCase(),
            recipient: String(parsed.args.recipient).toLowerCase(),
            amountWei: String(parsed.args.amount),
          });
        } else if (parsed.name === 'BadgeIssued') {
          decoded.push({
            txHash: log.transactionHash.toLowerCase(),
            logIndex: log.index,
            address: addr,
            eventName: 'BadgeIssued',
            entitlement: String(parsed.args.entitlement).toLowerCase(),
            recipient: String(parsed.args.recipient).toLowerCase(),
            tokenId: String(parsed.args.tokenId),
          });
        } else if (parsed.name === 'RoleGranted' || parsed.name === 'RoleRevoked') {
          decoded.push({
            txHash: log.transactionHash.toLowerCase(),
            logIndex: log.index,
            address: addr,
            eventName: parsed.name as 'RoleGranted' | 'RoleRevoked',
            roleHash: String(parsed.args.role).toLowerCase(),
            account: String(parsed.args.account).toLowerCase(),
            sender: String(parsed.args.sender).toLowerCase(),
          });
        } else if (parsed.name === 'Paused' || parsed.name === 'Unpaused') {
          decoded.push({
            txHash: log.transactionHash.toLowerCase(),
            logIndex: log.index,
            address: addr,
            eventName: parsed.name as 'Paused' | 'Unpaused',
            account: String(parsed.args.account).toLowerCase(),
          });
        }
      }

      return {
        number,
        hash: block.hash.toLowerCase(),
        parentHash: block.parentHash.toLowerCase(),
        logs: decoded,
      };
    });
  }
}

/** Deprecated compatibility re-export for existing test harness suites */
export class BaseSepoliaRpcSource extends JsonRpcChainSource {}
