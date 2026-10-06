import type { Pool } from 'pg';
import { initPostgres, seedDevelopmentData } from '../src/db/pool.js';
import {
  DatabaseRuntimePolicy,
  isDevelopmentSeedEnabled,
  isInMemoryFallbackAllowed,
} from '../src/db/policy.js';

const productionPolicy: DatabaseRuntimePolicy = {
  nodeEnv: 'production',
  allowInMemoryFallback: true,
  seedDevelopmentData: true,
};

function unavailablePool() {
  return {
    query: jest.fn().mockRejectedValue(new Error('connection refused')),
    end: jest.fn().mockResolvedValue(undefined),
  } as unknown as Pool;
}

describe('PostgreSQL runtime policy', () => {
  it('never permits memory fallback or development seeding in production', () => {
    expect(isInMemoryFallbackAllowed(productionPolicy)).toBe(false);
    expect(isDevelopmentSeedEnabled(productionPolicy)).toBe(false);
  });

  it('fails closed when PostgreSQL initialization fails in production', async () => {
    const candidate = unavailablePool();

    await expect(
      initPostgres({ policy: productionPolicy, poolFactory: () => candidate })
    ).rejects.toThrow('refusing to start without durable storage');
    expect(candidate.end).toHaveBeenCalledTimes(1);
  });

  it('only falls back in development when the escape hatch is explicitly enabled', async () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const candidate = unavailablePool();
    const policy: DatabaseRuntimePolicy = {
      nodeEnv: 'development',
      allowInMemoryFallback: true,
      seedDevelopmentData: false,
    };

    await expect(initPostgres({ policy, poolFactory: () => candidate })).resolves.toBe(false);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('explicit in-memory fallback is active'));
    warning.mockRestore();
  });

  it('does not seed unless a non-production runtime explicitly enables it', () => {
    expect(isDevelopmentSeedEnabled({
      nodeEnv: 'development',
      allowInMemoryFallback: false,
      seedDevelopmentData: false,
    })).toBe(false);
    expect(isDevelopmentSeedEnabled({
      nodeEnv: 'development',
      allowInMemoryFallback: false,
      seedDevelopmentData: true,
    })).toBe(true);
  });

  it('replays the idempotent development seed to repair partially populated databases', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

    await seedDevelopmentData({ query } as unknown as Pick<Pool, 'query'>);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('INSERT INTO quests');
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT');
  });

  it('handles idle pool errors without crashing after a database interruption', async () => {
    const logger = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const on = jest.fn();
    const candidate = {
      ...unavailablePool(),
      on,
    } as unknown as Pool;

    await expect(initPostgres({ policy: productionPolicy, poolFactory: () => candidate }))
      .rejects.toThrow('refusing to start without durable storage');

    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
    const handler = on.mock.calls[0][1] as (error: Error) => void;
    expect(() => handler(new Error('terminating connection due to administrator command')))
      .not.toThrow();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Idle PostgreSQL connection error'));
    logger.mockRestore();
  });
});
