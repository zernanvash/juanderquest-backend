import { Interface, JsonRpcProvider } from 'ethers';
import type { ChainSource, ObservedBlock, ObservedLog } from './indexer.js';

const distributorAbi = new Interface([
  'event Claimed(bytes32 indexed entitlement,address indexed recipient,uint256 amount,uint256 epoch)',
]);
const badgeAbi = new Interface([
  'event BadgeIssued(bytes32 indexed entitlement,address indexed recipient,uint256 indexed tokenId)',
]);

/** Read-only JSON-RPC adapter. No signer, private key, sendTransaction or broadcast API. */
export class BaseSepoliaRpcSource implements ChainSource {
  private readonly provider: JsonRpcProvider;
  constructor(rpcUrl: string, private readonly distributor: string, private readonly badge: string) {
    const url = new URL(rpcUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('INVALID_CHAIN_RPC_URL');
    }
    this.provider = new JsonRpcProvider(rpcUrl);
  }

  async getChainId(): Promise<number> {
    return Number((await this.provider.getNetwork()).chainId);
  }

  getLatestBlockNumber(): Promise<number> { return this.provider.getBlockNumber(); }

  async getBlock(number: number): Promise<ObservedBlock> {
    const block = await this.provider.getBlock(number);
    if (!block || !block.hash) throw new Error('CHAIN_BLOCK_UNAVAILABLE');
    const [claims, badges] = await Promise.all([
      this.provider.getLogs({ blockHash: block.hash, address: this.distributor,
        topics: [distributorAbi.getEvent('Claimed')!.topicHash] }),
      this.provider.getLogs({ blockHash: block.hash, address: this.badge,
        topics: [badgeAbi.getEvent('BadgeIssued')!.topicHash] }),
    ]);
    const logs = [...claims, ...badges].sort((left, right) => left.index - right.index);
    const decoded: ObservedLog[] = logs.map((log) => {
      const isClaim = log.address.toLowerCase() === this.distributor.toLowerCase();
      const parsed = (isClaim ? distributorAbi : badgeAbi).parseLog(log);
      if (!parsed || parsed.name !== (isClaim ? 'Claimed' : 'BadgeIssued')) {
        throw new Error('UNRECOGNIZED_CHAIN_EVENT');
      }
      if (log.blockHash.toLowerCase() !== block.hash!.toLowerCase()) throw new Error('CHAIN_REORG_DURING_FETCH');
      return {
        txHash: log.transactionHash.toLowerCase(), logIndex: log.index,
        address: log.address.toLowerCase(),
        eventName: isClaim ? 'Claimed' : 'BadgeIssued',
        entitlement: String(parsed.args.entitlement).toLowerCase(),
        recipient: String(parsed.args.recipient).toLowerCase(),
        ...(isClaim ? { amountWei: String(parsed.args.amount) } : { tokenId: String(parsed.args.tokenId) }),
      };
    });
    return { number, hash: block.hash.toLowerCase(), parentHash: block.parentHash.toLowerCase(), logs: decoded };
  }
}
