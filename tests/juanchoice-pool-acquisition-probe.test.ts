import { Pool } from 'pg';
import {
  installAcquisitionProbe,
  computePercentile,
  summarizeSamples,
  AcquisitionSample,
} from '../scripts/juanchoice-pool-acquisition-probe.js';

describe('JuanChoice connection acquisition probe helper', () => {
  it('measures elapsed time and records successful Promise connect', async () => {
    const fakeClient = { release: jest.fn() };
    const mockOriginalConnect = jest.fn().mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 20));
      return fakeClient;
    });

    const pool = {
      connect: mockOriginalConnect,
    } as unknown as Pool;

    const probe = installAcquisitionProbe(pool);
    expect(pool.connect).not.toBe(mockOriginalConnect);

    const client = await pool.connect();
    expect(client).toBe(fakeClient);

    const samples = probe.getSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0].success).toBe(true);
    expect(samples[0].phase).toBe('idle_read');
    expect(samples[0].elapsedMs).toBeGreaterThanOrEqual(15);
    expect(Number.isFinite(samples[0].elapsedMs)).toBe(true);

    probe.restore();
    expect(pool.connect).toBe(mockOriginalConnect);
  });

  it('measures elapsed time and records failed Promise connect', async () => {
    const expectedError = new Error('Connection timeout exceeded');
    const mockOriginalConnect = jest.fn().mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 10));
      throw expectedError;
    });

    const pool = {
      connect: mockOriginalConnect,
    } as unknown as Pool;

    const probe = installAcquisitionProbe(pool);

    await expect(pool.connect()).rejects.toThrow('Connection timeout exceeded');

    const samples = probe.getSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0].success).toBe(false);
    expect((samples[0] as any).error).toBeUndefined();
    expect(samples[0].elapsedMs).toBeGreaterThanOrEqual(5);

    probe.restore();
  });

  it('measures elapsed time and handles callback connect on success', done => {
    const fakeClient = { release: jest.fn() };
    const mockOriginalConnect = jest.fn().mockImplementation((cb: (err: any, client: any, release: any) => void) => {
      setTimeout(() => {
        cb(undefined, fakeClient, () => {});
      }, 15);
    });

    const pool = {
      connect: mockOriginalConnect,
    } as unknown as Pool;

    const probe = installAcquisitionProbe(pool);

    pool.connect((err, client, release) => {
      try {
        expect(err).toBeUndefined();
        expect(client).toBe(fakeClient);
        expect(typeof release).toBe('function');

        const samples = probe.getSamples();
        expect(samples).toHaveLength(1);
        expect(samples[0].success).toBe(true);
        expect(samples[0].elapsedMs).toBeGreaterThanOrEqual(10);

        probe.restore();
        expect(pool.connect).toBe(mockOriginalConnect);
        done();
      } catch (e) {
        probe.restore();
        done(e);
      }
    });
  });

  it('measures elapsed time and handles callback connect on error without storing error string', done => {
    const mockOriginalConnect = jest.fn().mockImplementation((cb: (err: any, client: any, release: any) => void) => {
      setTimeout(() => {
        cb(new Error('Pool exhausted'), undefined, () => {});
      }, 10);
    });

    const pool = {
      connect: mockOriginalConnect,
    } as unknown as Pool;

    const probe = installAcquisitionProbe(pool);

    pool.connect((err, client) => {
      try {
        expect(err?.message).toBe('Pool exhausted');
        expect(client).toBeUndefined();

        const samples = probe.getSamples();
        expect(samples).toHaveLength(1);
        expect(samples[0].success).toBe(false);
        expect((samples[0] as any).error).toBeUndefined();

        probe.restore();
        done();
      } catch (e) {
        probe.restore();
        done(e);
      }
    });
  });

  it('correctly tracks phases when setPhase is called', async () => {
    const mockOriginalConnect = jest.fn().mockResolvedValue({ release: () => {} });
    const pool = { connect: mockOriginalConnect } as unknown as Pool;
    const probe = installAcquisitionProbe(pool);

    // Initial phase is idle_read
    await pool.connect();

    // Switch phase to mixed_ballot_burst
    probe.setPhase('mixed_ballot_burst');
    await pool.connect();

    // Switch back
    probe.setPhase('idle_read');
    await pool.connect();

    const samples = probe.getSamples();
    expect(samples).toHaveLength(3);
    expect(samples[0].phase).toBe('idle_read');
    expect(samples[1].phase).toBe('mixed_ballot_burst');
    expect(samples[2].phase).toBe('idle_read');

    const summary = probe.getSummary();
    expect(summary.all.count).toBe(3);
    expect(summary.mixed_ballot_burst.count).toBe(1);
    expect(summary.idle_read.count).toBe(2);

    probe.restore();
  });

  it('captures phase at connect invocation, not settlement (phase change during deferred acquisition)', async () => {
    let resolveFirstConnect!: (client: any) => void;
    let resolveSecondConnect!: (client: any) => void;

    const mockOriginalConnect = jest.fn()
      .mockImplementationOnce(() => new Promise(res => { resolveFirstConnect = res; }))
      .mockImplementationOnce(() => new Promise(res => { resolveSecondConnect = res; }));

    const pool = { connect: mockOriginalConnect } as unknown as Pool;
    const probe = installAcquisitionProbe(pool);

    probe.setPhase('mixed_ballot_burst');
    // Invoked while phase is mixed_ballot_burst
    const firstPromise = pool.connect();

    // Phase changes before first connect settles
    probe.setPhase('idle_read');
    // Invoked while phase is idle_read
    const secondPromise = pool.connect();

    // Settle both after phase change
    resolveFirstConnect({ release: () => {} });
    resolveSecondConnect({ release: () => {} });

    await Promise.all([firstPromise, secondPromise]);

    const samples = probe.getSamples();
    expect(samples).toHaveLength(2);
    // First acquisition was invoked during mixed_ballot_burst
    expect(samples[0].phase).toBe('mixed_ballot_burst');
    // Second acquisition was invoked during idle_read
    expect(samples[1].phase).toBe('idle_read');

    probe.restore();
  });

  it('guarantees no negative or nonfinite durations in percentiles and summary statistics', () => {
    const badSamples: AcquisitionSample[] = [
      { elapsedMs: -10, phase: 'idle_read', success: true },
      { elapsedMs: NaN, phase: 'idle_read', success: true },
      { elapsedMs: Infinity, phase: 'idle_read', success: true },
      { elapsedMs: 50, phase: 'idle_read', success: true },
      { elapsedMs: 100, phase: 'idle_read', success: true },
      { elapsedMs: 200, phase: 'idle_read', success: false },
    ];

    const stats = summarizeSamples(badSamples);
    expect(stats.count).toBe(6);
    expect(Number.isFinite(stats.p50_ms)).toBe(true);
    expect(Number.isFinite(stats.p95_ms)).toBe(true);
    expect(Number.isFinite(stats.max_ms)).toBe(true);
    expect(stats.p50_ms).toBeGreaterThanOrEqual(0);
    expect(stats.p95_ms).toBeGreaterThanOrEqual(0);
    expect(stats.max_ms).toBe(200);
    expect(stats.errorCount).toBe(1);
  });

  it('computes exact percentiles correctly for empty and sorted arrays', () => {
    expect(computePercentile([], 0.95)).toBe(0);
    expect(computePercentile([10], 0.50)).toBe(10);
    expect(computePercentile([10], 0.95)).toBe(10);
    expect(computePercentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.50)).toBe(50);
    expect(computePercentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.95)).toBe(100);
  });

  it('attributes acquisitions in concurrent asynchronous callback contexts to their own phase', async () => {
    let currentAsyncContextPhase: 'mixed_ballot_burst' | 'idle_read' | 'unscoped' = 'unscoped';
    const mockOriginalConnect = jest.fn().mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 10));
      return { release: () => {} };
    });
    const pool = { connect: mockOriginalConnect } as unknown as Pool;

    // Simulate request-scoped phase resolver via getter
    const probe = installAcquisitionProbe(pool, () => currentAsyncContextPhase);

    // Run first context
    currentAsyncContextPhase = 'mixed_ballot_burst';
    const firstOp = pool.connect();

    // Run second context
    currentAsyncContextPhase = 'idle_read';
    const secondOp = pool.connect();

    await Promise.all([firstOp, secondOp]);

    const samples = probe.getSamples();
    expect(samples).toHaveLength(2);
    expect(samples[0].phase).toBe('mixed_ballot_burst');
    expect(samples[1].phase).toBe('idle_read');

    const summary = probe.getSummary();
    expect(summary.mixed_ballot_burst.count).toBe(1);
    expect(summary.idle_read.count).toBe(1);
    expect(summary.unscoped.count).toBe(0);
    expect(summary.all.count).toBe(2);

    probe.restore();
  });

  it('records unscoped acquisition without counting it as idle_read and does not fall back to setPhase', async () => {
    const mockOriginalConnect = jest.fn().mockResolvedValue({ release: () => {} });
    const pool = { connect: mockOriginalConnect } as unknown as Pool;

    let callbackPhase: 'mixed_ballot_burst' | 'idle_read' | 'unscoped' = 'unscoped';
    const probe = installAcquisitionProbe(pool, () => callbackPhase);

    // Call setPhase to verify it is NOT used as a fallback when callback returns 'unscoped'
    probe.setPhase('mixed_ballot_burst');

    await pool.connect();

    const samples = probe.getSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0].phase).toBe('unscoped');

    const summary = probe.getSummary();
    expect(summary.all.count).toBe(1);
    expect(summary.unscoped.count).toBe(1);
    expect(summary.idle_read.count).toBe(0);
    expect(summary.mixed_ballot_burst.count).toBe(0);

    probe.restore();
  });

  it('preserves legacy setPhase semantics when no getRequestPhase callback is provided', async () => {
    const mockOriginalConnect = jest.fn().mockResolvedValue({ release: () => {} });
    const pool = { connect: mockOriginalConnect } as unknown as Pool;

    const probe = installAcquisitionProbe(pool);

    // Default without setPhase is idle_read
    await pool.connect();

    probe.setPhase('mixed_ballot_burst');
    await pool.connect();

    const samples = probe.getSamples();
    expect(samples).toHaveLength(2);
    expect(samples[0].phase).toBe('idle_read');
    expect(samples[1].phase).toBe('mixed_ballot_burst');

    const summary = probe.getSummary();
    expect(summary.all.count).toBe(2);
    expect(summary.idle_read.count).toBe(1);
    expect(summary.mixed_ballot_burst.count).toBe(1);
    expect(summary.unscoped.count).toBe(0);

    probe.restore();
  });

  it('rejects unknown phase values returned by getRequestPhase callback', async () => {
    const mockOriginalConnect = jest.fn().mockResolvedValue({ release: () => {} });
    const pool = { connect: mockOriginalConnect } as unknown as Pool;

    const probe = installAcquisitionProbe(pool, () => 'invalid_phase' as any);

    expect(() => pool.connect()).toThrow('Invalid acquisition phase resolved from getRequestPhase: invalid_phase');

    probe.restore();
  });

  it('rejects unknown phase values passed to setPhase', () => {
    const mockOriginalConnect = jest.fn().mockResolvedValue({ release: () => {} });
    const pool = { connect: mockOriginalConnect } as unknown as Pool;

    const probe = installAcquisitionProbe(pool);

    expect(() => probe.setPhase('invalid_phase' as any)).toThrow('Invalid phase passed to setPhase: invalid_phase');

    probe.restore();
  });
});
