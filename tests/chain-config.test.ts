import { getChainConfig, parseRpcUrls, explorerAddress, explorerTx } from '../src/chain/config.js';
import { env } from '../src/config/env.js';
import { JsonRpcChainSource } from '../src/chain/rpc-source.js';

describe('Chain Config (WP1)', () => {
  it('parses valid comma-separated RPC URLs', () => {
    const urls = parseRpcUrls('https://rpc1.example.com, https://rpc2.example.com');
    expect(urls).toEqual(['https://rpc1.example.com', 'https://rpc2.example.com']);
  });

  it('rejects invalid or credentialed RPC URLs', () => {
    expect(() => parseRpcUrls('')).toThrow();
    expect(() => parseRpcUrls('ftp://invalid.com')).toThrow();
    expect(() => parseRpcUrls('https://user:pass@rpc.example.com')).toThrow();
  });

  it('constructs typed ChainConfig for Polygon Amoy default', () => {
    const config = getChainConfig();
    expect([80002, 84532]).toContain(config.chainId);
    expect(config.rpcUrls.length).toBeGreaterThan(0);
    expect(config.contracts.token).toMatch(/^0x[0-9a-f]{40}$/);
    expect(config.contracts.distributor).toMatch(/^0x[0-9a-f]{40}$/);
    expect(config.contracts.badge).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('formats explorer tx and address URLs', () => {
    const tx = explorerTx('0x1234');
    expect(tx).toContain('/tx/0x1234');
    const addr = explorerAddress('0xabcd');
    expect(addr).toContain('/address/0xabcd');
  });

  it('implements RPC fallback when primary RPC fails', async () => {
    const source = new JsonRpcChainSource({
      rpcUrls: ['https://invalid-non-existent-rpc-url-123.org', 'https://polygon-amoy-bor-rpc.publicnode.com'],
      distributor: '0x3542402bcB93e142437779EEEa9e16D7163854ce',
      badge: '0xC9b1Cc4f980edf71daCa182944ECb67E494B3E9b',
      timeoutMs: 1500,
    });

    const chainId = await source.getChainId();
    expect(chainId).toBe(80002);
  });
});
