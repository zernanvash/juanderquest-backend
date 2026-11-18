import { publishAfterCommit, publishBroadcast, publishToUser, subscribe } from '../src/realtime/bus.js';

function fakeClient(commitCommand = 'COMMIT') {
  const queries: string[] = [];
  return {
    queries,
    released: 0,
    async query(text: string) {
      queries.push(text);
      return { command: text.trim().toUpperCase() === 'COMMIT' ? commitCommand : 'SELECT', rows: [] };
    },
    release() {
      this.released += 1;
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('realtime bus', () => {
  it('delivers user and broadcast events to subscribers and isolates listener failures', () => {
    const seen: unknown[] = [];
    const offBad = subscribe(() => {
      throw new Error('boom');
    });
    const off = subscribe((target, event) => seen.push([target, event]));
    expect(() => publishToUser('u1', { type: 'points', balance: 5 })).not.toThrow();
    publishBroadcast({ type: 'plaza_activity', id: 'act_1' });
    publishToUser('', { type: 'points' });
    off();
    offBad();
    publishBroadcast({ type: 'plaza_activity', id: 'act_2' });
    expect(seen).toEqual([
      [{ userId: 'u1' }, { type: 'points', balance: 5 }],
      ['all', { type: 'plaza_activity', id: 'act_1' }],
    ]);
  });

  it('publishes immediately for a pool or plain queryable', () => {
    const fn = jest.fn();
    publishAfterCommit({ query: async () => ({}) }, fn);
    publishAfterCommit(null, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('waits for COMMIT on a checked-out client and restores the client methods', async () => {
    const client = fakeClient();
    const originalQuery = client.query;
    const fn = jest.fn();
    await client.query('BEGIN');
    publishAfterCommit(client, fn);
    publishAfterCommit(client, fn);
    await client.query('SAVEPOINT x');
    await client.query('ROLLBACK TO SAVEPOINT x');
    expect(fn).not.toHaveBeenCalled();
    await client.query('COMMIT');
    await tick();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(client.query).toBe(originalQuery);
    client.release();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('drops events on ROLLBACK, an aborted COMMIT, or release with an error', async () => {
    const fn = jest.fn();
    const rolledBack = fakeClient();
    publishAfterCommit(rolledBack, fn);
    await rolledBack.query('ROLLBACK');
    const aborted = fakeClient('ROLLBACK');
    publishAfterCommit(aborted, fn);
    await aborted.query('COMMIT');
    const broken = fakeClient();
    publishAfterCommit(broken, fn);
    (broken as any).release(new Error('bad connection'));
    await tick();
    expect(fn).not.toHaveBeenCalled();
  });

  it('flushes on a clean release when no transaction ended (autocommit) and swallows publisher errors', async () => {
    const client = fakeClient();
    const fn = jest.fn();
    publishAfterCommit(client, () => {
      throw new Error('publisher failed');
    });
    publishAfterCommit(client, fn);
    expect(() => client.release()).not.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(client.released).toBe(1);
  });
});
