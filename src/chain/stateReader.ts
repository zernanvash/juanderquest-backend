import { Contract, formatEther, id, JsonRpcProvider } from 'ethers';

/** AccessControl role identifiers (computed, never hard-coded). */
export const ROLE_HASHES = {
  DEFAULT_ADMIN_ROLE: '0x' + '0'.repeat(64),
  MINTER_ROLE: id('MINTER_ROLE'),
  SIGNER_ROLE: id('SIGNER_ROLE'),
  ISSUER_ROLE: id('ISSUER_ROLE'),
} as const;
export type RoleName = keyof typeof ROLE_HASHES;

export interface WalletLive {
  /** POL as a decimal string, or null when it could not be read. */
  balancePol: string | null;
  nonce: number | null;
}

/**
 * Read-only view of the chain used by the admin overview and the low-balance
 * watch. No signer, no sendTransaction. Every method resolves; failures come
 * back as `null` (unknown), never as a guessed value.
 */
export interface ChainStateReader {
  latestBlock(): Promise<number | null>;
  wallet(address: string): Promise<WalletLive>;
  hasRole(contract: string, role: string, account: string): Promise<boolean | null>;
  paused(contract: string): Promise<boolean | null>;
}

const ABI = [
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function paused() view returns (bool)',
];
const CALL_TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('CHAIN_RPC_TIMEOUT')), CALL_TIMEOUT_MS);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** ethers-backed reader; tries each RPC in order (at most two) per call. */
export class JsonRpcChainStateReader implements ChainStateReader {
  private readonly providers: JsonRpcProvider[];

  constructor(rpcUrls: string[], chainId: number) {
    if (rpcUrls.length === 0) throw new Error('CHAIN_RPC_URLS_EMPTY');
    this.providers = rpcUrls.slice(0, 2).map((url) =>
      new JsonRpcProvider(url, chainId, { staticNetwork: true }));
  }

  private async attempt<T>(fn: (p: JsonRpcProvider) => Promise<T>): Promise<T | null> {
    for (const provider of this.providers) {
      try {
        return await withTimeout(fn(provider));
      } catch {
        // try the next RPC
      }
    }
    return null;
  }

  latestBlock() {
    return this.attempt((p) => p.getBlockNumber());
  }

  async wallet(address: string): Promise<WalletLive> {
    const [balance, nonce] = await Promise.all([
      this.attempt((p) => p.getBalance(address)),
      this.attempt((p) => p.getTransactionCount(address)),
    ]);
    return { balancePol: balance === null ? null : formatEther(balance), nonce };
  }

  hasRole(contract: string, role: string, account: string) {
    return this.attempt((p) => new Contract(contract, ABI, p).hasRole(role, account) as Promise<boolean>);
  }

  paused(contract: string) {
    return this.attempt((p) => new Contract(contract, ABI, p).paused() as Promise<boolean>);
  }
}

/** A gas-paying wallet below its alert threshold. Unknown balance is never "low". */
export function isLowBalance(balancePol: string | null, threshold: string | null, needsGas: boolean): boolean {
  if (!needsGas || balancePol === null || threshold === null) return false;
  return Number(balancePol) < Number(threshold);
}

let override: ChainStateReader | null = null;
let cached: { key: string; reader: ChainStateReader } | null = null;

/** Tests inject a stub; pass null to restore the real reader. */
export function setChainStateReaderForTests(reader: ChainStateReader | null): void {
  override = reader;
}

export function getChainStateReader(rpcUrls: string[], chainId: number): ChainStateReader {
  if (override) return override;
  const key = `${chainId}|${rpcUrls.join(',')}`;
  if (!cached || cached.key !== key) cached = { key, reader: new JsonRpcChainStateReader(rpcUrls, chainId) };
  return cached.reader;
}
