import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  CapacityCpuProfiler,
  formatCpuProfileSummaryLine,
  resolveCpuProfileMode,
  type InspectorSessionLike,
  MAX_PROFILE_BYTES,
} from '../scripts/juanchoice-capacity-cpu-profile.js';

describe('juanchoice capacity CPU profile helper', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdq-cpu-profile-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('resolveCpuProfileMode', () => {
    it('is off by default when undefined or empty', () => {
      expect(resolveCpuProfileMode(undefined)).toBeNull();
      expect(resolveCpuProfileMode('')).toBeNull();
    });

    it('resolves exact request_window mode', () => {
      expect(resolveCpuProfileMode('request_window')).toBe('request_window');
    });

    it('rejects invalid or typo modes explicitly', () => {
      expect(() => resolveCpuProfileMode('request-window')).toThrow(
        /JDQ_CAPACITY_CPU_PROFILE must be "request_window" or unset/
      );
      expect(() => resolveCpuProfileMode('full')).toThrow(
        /JDQ_CAPACITY_CPU_PROFILE must be "request_window" or unset/
      );
      expect(() => resolveCpuProfileMode('true')).toThrow(
        /JDQ_CAPACITY_CPU_PROFILE must be "request_window" or unset/
      );
      expect(() => resolveCpuProfileMode(' REQUEST_WINDOW ')).toThrow(
        /JDQ_CAPACITY_CPU_PROFILE must be "request_window" or unset/
      );
      expect(() => resolveCpuProfileMode('private-value')).not.toThrow('private-value');
    });
  });

  describe('CapacityCpuProfiler lifecycle & execution order', () => {
    it('does nothing when disabled', async () => {
      const calls: string[] = [];
      const fakeSession: InspectorSessionLike = {
        connect: () => calls.push('connect'),
        post: (method: string, cb?: any) => {
          calls.push(`post:${method}`);
          if (typeof cb === 'function') cb(null, {});
        },
        disconnect: () => calls.push('disconnect'),
      };

      const profiler = new CapacityCpuProfiler(undefined, {
        session: fakeSession,
        profilesDir: tempDir,
      });

      expect(profiler.isEnabled()).toBe(false);
      expect(profiler.getMode()).toBeNull();

      await profiler.start();
      const res = await profiler.stop();

      expect(res.enabled).toBe(false);
      expect(res.artifact).toBeUndefined();
      expect(calls).toEqual([]);
    });

    it('executes connect -> enable -> start and stop -> disable -> disconnect in exact deterministic order', async () => {
      const calls: string[] = [];
      const fakeProfile = {
        nodes: [{ id: 1, callFrame: { functionName: '(root)' } }, { id: 2, callFrame: { functionName: 'app' } }],
        samples: [1, 2, 2],
        timeDeltas: [100, 200, 200],
      };

      const fakeSession: InspectorSessionLike = {
        connect: () => calls.push('connect'),
        post: (method: string, ...rest: any[]) => {
          calls.push(`post:${method}`);
          const cb = rest[rest.length - 1];
          if (typeof cb === 'function') {
            if (method === 'Profiler.stop') {
              cb(null, { profile: fakeProfile });
            } else {
              cb(null, {});
            }
          }
        },
        disconnect: () => calls.push('disconnect'),
      };

      const profiler = new CapacityCpuProfiler('request_window', {
        session: fakeSession,
        profilesDir: tempDir,
      });

      expect(profiler.isEnabled()).toBe(true);
      expect(profiler.getMode()).toBe('request_window');

      await profiler.start();
      expect(calls).toEqual(['connect', 'post:Profiler.enable', 'post:Profiler.start']);

      const stopResult = await profiler.stop();
      expect(calls).toEqual([
        'connect',
        'post:Profiler.enable',
        'post:Profiler.start',
        'post:Profiler.stop',
        'post:Profiler.disable',
        'disconnect',
      ]);

      expect(stopResult.enabled).toBe(true);
      expect(stopResult.artifact).toBeDefined();
      expect(stopResult.artifact?.mode).toBe('request_window');
      expect(stopResult.artifact?.nodeCount).toBe(2);
      expect(stopResult.artifact?.sampleCount).toBe(3);
      expect(stopResult.artifact?.fileSizeBytes).toBeGreaterThan(0);

      const filePath = stopResult.artifact!.profilePath;
      expect(fs.existsSync(filePath)).toBe(true);
      const parsedJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(parsedJson).toEqual(fakeProfile);
    });

    it('ensures disconnect occurs in finally block if Profiler.start fails', async () => {
      const calls: string[] = [];
      const fakeSession: InspectorSessionLike = {
        connect: () => calls.push('connect'),
        post: (method: string, ...rest: any[]) => {
          calls.push(`post:${method}`);
          const cb = rest[rest.length - 1];
          if (method === 'Profiler.start') {
            cb(new Error('Profiler start failed'));
          } else {
            cb(null, {});
          }
        },
        disconnect: () => calls.push('disconnect'),
      };

      const profiler = new CapacityCpuProfiler('request_window', {
        session: fakeSession,
        profilesDir: tempDir,
      });

      await expect(profiler.start()).rejects.toThrow('Profiler start failed');
      expect(calls).toEqual(['connect', 'post:Profiler.enable', 'post:Profiler.start', 'disconnect']);
    });

    it('ensures disconnect occurs in finally block if Profiler.stop fails', async () => {
      const calls: string[] = [];
      const fakeSession: InspectorSessionLike = {
        connect: () => calls.push('connect'),
        post: (method: string, ...rest: any[]) => {
          calls.push(`post:${method}`);
          const cb = rest[rest.length - 1];
          if (method === 'Profiler.stop') {
            cb(new Error('Profiler stop failed'));
          } else {
            cb(null, {});
          }
        },
        disconnect: () => calls.push('disconnect'),
      };

      const profiler = new CapacityCpuProfiler('request_window', {
        session: fakeSession,
        profilesDir: tempDir,
      });

      await profiler.start();
      await expect(profiler.stop()).rejects.toThrow('Profiler stop failed');
      expect(calls).toContain('disconnect');
    });

    it('cleans up and disconnects cleanly via cleanup()', async () => {
      const calls: string[] = [];
      const fakeSession: InspectorSessionLike = {
        connect: () => calls.push('connect'),
        post: (_method: string, ...rest: any[]) => {
          const cb = rest[rest.length - 1];
          cb(null, {});
        },
        disconnect: () => calls.push('disconnect'),
      };

      const profiler = new CapacityCpuProfiler('request_window', {
        session: fakeSession,
        profilesDir: tempDir,
      });

      await profiler.start();
      await profiler.cleanup();
      expect(calls).toEqual(['connect', 'disconnect']);
    });
  });

  describe('size bounding and artifact path validation', () => {
    it('fails when serialized profile exceeds size limit', async () => {
      const largeProfile = {
        nodes: [{ id: 1 }],
        samples: Array.from({ length: 100 }, () => 1),
      };

      const fakeSession: InspectorSessionLike = {
        connect: () => {},
        post: (method: string, ...rest: any[]) => {
          const cb = rest[rest.length - 1];
          if (method === 'Profiler.stop') {
            cb(null, { profile: largeProfile });
          } else {
            cb(null, {});
          }
        },
        disconnect: () => {},
      };

      const profiler = new CapacityCpuProfiler('request_window', {
        session: fakeSession,
        profilesDir: tempDir,
        maxFileSizeBytes: 50, // Force small bound
      });

      await profiler.start();
      await expect(profiler.stop()).rejects.toThrow(/exceeds maximum allowed size/);
    });

    it('formats summary line without sensitive credentials or URLs', () => {
      const dummyArtifact = {
        profilePath: path.join(tempDir, 'sample.cpuprofile'),
        relativeProfilePath: '.local/capacity-cpu-profiles/sample.cpuprofile',
        mode: 'request_window' as const,
        nodeCount: 142,
        sampleCount: 890,
        fileSizeBytes: 12345,
      };

      const line = formatCpuProfileSummaryLine(dummyArtifact);
      expect(line).toBe(
        'CAPACITY_CPU_PROFILE mode=request_window path=.local/capacity-cpu-profiles/sample.cpuprofile nodes=142 samples=890 bytes=12345\n'
      );

      // Verify no sensitive tokens/secrets
      expect(line).not.toMatch(/bearer/i);
      expect(line).not.toMatch(/postgres/i);
      expect(line).not.toMatch(/password/i);
      expect(line).not.toMatch(/secret/i);
      expect(line).not.toMatch(/cookie/i);
    });
  });
});
