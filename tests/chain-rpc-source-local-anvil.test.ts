import { BaseSepoliaRpcSource } from '../src/chain/rpc-source';

const localAnvil = process.env.JDQ_LOCAL_ANVIL_RPC && process.env.JDQ_LOCAL_BADGE
  && process.env.JDQ_LOCAL_DISTRIBUTOR && process.env.JDQ_LOCAL_EVENT_BLOCK
  ? describe : describe.skip;

localAnvil('read-only JSON-RPC adapter against local Anvil 84532', () => {
  it('decodes the actual badge event by exact block hash and ignores unrelated ERC-721 logs', async () => {
    const source = new BaseSepoliaRpcSource(process.env.JDQ_LOCAL_ANVIL_RPC!,
      process.env.JDQ_LOCAL_DISTRIBUTOR!, process.env.JDQ_LOCAL_BADGE!);
    expect(await source.getChainId()).toBe(84532);
    const height = Number(process.env.JDQ_LOCAL_EVENT_BLOCK);
    const observed = await source.getBlock(height);
    expect(observed.number).toBe(height);
    expect(observed.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(observed.logs).toEqual(expect.arrayContaining([expect.objectContaining({
      eventName: 'BadgeIssued',
      address: process.env.JDQ_LOCAL_BADGE!.toLowerCase(),
      entitlement: `0x${'d'.repeat(64)}`,
      tokenId: '77',
    })]));
    expect(observed.logs).toHaveLength(1);
  });
});
