import { EventEmitter } from 'events';
import type { Pool } from 'pg';
import { getPool, setPool } from '../src/db/pool.js';
import { runBadgeMinterLoopTickForTests as tick } from '../src/chain/badgeMinter.js';

// The minter loop shares the API process; a database outage must not crash it.
describe('badge minter loop resilience', () => {
  const original = getPool();
  let errors: jest.SpyInstance;
  beforeEach(() => { errors = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { errors.mockRestore(); setPool(original); });

  it('survives a connection timeout and runs again on the next tick', async () => {
    let calls = 0;
    setPool({ connect: async () => { calls += 1; throw new Error('Connection terminated due to connection timeout'); } } as unknown as Pool);
    await expect(tick()).resolves.toBeUndefined();
    await expect(tick()).resolves.toBeUndefined();
    expect(calls).toBe(2);
    expect(errors).toHaveBeenCalledWith('[badge-minter] tick failed:', expect.stringContaining('connection timeout'));
  });

  it('discards a client whose connection drops mid-tick', async () => {
    const client = Object.assign(new EventEmitter(), {
      query: async () => { client.emit('error', new Error('Connection terminated unexpectedly')); throw new Error('Connection terminated unexpectedly'); },
      release: jest.fn(),
    });
    setPool({ connect: async () => client } as unknown as Pool);
    await expect(tick()).resolves.toBeUndefined();
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
    expect(client.listenerCount('error')).toBe(0);
  });
});
