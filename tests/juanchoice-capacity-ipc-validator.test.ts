import http from 'node:http';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import path from 'node:path';
import {
  calculateExpectedCapacityBounds,
  validateChildDonePayload,
  validateSanitizedSample,
  VALID_BALLOT_KINDS,
  VALID_READ_KINDS,
} from '../scripts/juanchoice-capacity-ipc-validator.js';
import type { ParentToChildMessage, ChildToParentMessage } from '../scripts/juanchoice-capacity-child-client.js';

describe('JuanChoice capacity parent IPC validator and failure handling', () => {
  describe('Pure IPC validator tests', () => {
    it('validates a correct sample and records reqId in seenReqIds', () => {
      const seen = new Set<string>();
      const sample = validateSanitizedSample(
        { reqId: 'req-1', kind: 'overview', status: 200, totalClientMs: 42.5 },
        VALID_READ_KINDS,
        seen,
        'read'
      );
      expect(sample.reqId).toBe('req-1');
      expect(sample.kind).toBe('overview');
      expect(sample.status).toBe(200);
      expect(sample.totalClientMs).toBe(42.5);
      expect(seen.has('req-1')).toBe(true);
    });

    it('rejects sample with empty reqId or missing fields', () => {
      const seen = new Set<string>();
      expect(() => validateSanitizedSample(null, VALID_READ_KINDS, seen, 'read')).toThrow();
      expect(() => validateSanitizedSample({ reqId: '', kind: 'overview', status: 200, totalClientMs: 10 }, VALID_READ_KINDS, seen, 'read')).toThrow();
      expect(() => validateSanitizedSample({ reqId: 123, kind: 'overview', status: 200, totalClientMs: 10 }, VALID_READ_KINDS, seen, 'read')).toThrow();
      expect(() => validateSanitizedSample({ reqId: 'r1', kind: 'invalid_kind', status: 200, totalClientMs: 10 }, VALID_READ_KINDS, seen, 'read')).toThrow();
      expect(() => validateSanitizedSample({ reqId: 'r1', kind: 'overview', status: '200', totalClientMs: 10 }, VALID_READ_KINDS, seen, 'read')).toThrow();
      expect(() => validateSanitizedSample({ reqId: 'r1', kind: 'overview', status: -1, totalClientMs: 10 }, VALID_READ_KINDS, seen, 'read')).toThrow();
      expect(() => validateSanitizedSample({ reqId: 'r1', kind: 'overview', status: 600, totalClientMs: 10 }, VALID_READ_KINDS, seen, 'read')).toThrow();
      expect(() => validateSanitizedSample({ reqId: 'r1', kind: 'overview', status: 200, totalClientMs: -5 }, VALID_READ_KINDS, seen, 'read')).toThrow();
      expect(() => validateSanitizedSample({ reqId: 'r1', kind: 'overview', status: 200, totalClientMs: Infinity }, VALID_READ_KINDS, seen, 'read')).toThrow();
      expect(() => validateSanitizedSample({ reqId: 'r1', kind: 'overview', status: 200, totalClientMs: NaN }, VALID_READ_KINDS, seen, 'read')).toThrow();
    });

    it('rejects duplicate reqId within the same category or across reads and ballots', () => {
      const seen = new Set<string>();
      validateSanitizedSample({ reqId: 'shared-uuid', kind: 'overview', status: 200, totalClientMs: 10 }, VALID_READ_KINDS, seen, 'read');
      expect(() =>
        validateSanitizedSample({ reqId: 'shared-uuid', kind: 'standings', status: 200, totalClientMs: 15 }, VALID_READ_KINDS, seen, 'read')
      ).toThrow(/duplicate reqId/);

      expect(() =>
        validateSanitizedSample({ reqId: 'shared-uuid', kind: '0', status: 200, totalClientMs: 25 }, VALID_BALLOT_KINDS, seen, 'ballot')
      ).toThrow(/duplicate reqId/);
    });

    it('validates a complete DONE payload and converts errors array to static diagnostic count', () => {
      const bounds = calculateExpectedCapacityBounds(60_000, 15_000, 10, 5);
      const rawPayload = {
        type: 'DONE',
        reads: [
          { reqId: 'r1', kind: 'overview', status: 200, totalClientMs: 10 },
          { reqId: 'r2', kind: 'standings', status: 200, totalClientMs: 12 },
        ],
        ballots: [
          { reqId: 'b1', kind: '0', status: 200, totalClientMs: 35 },
          { reqId: 'b2', kind: '1', status: 200, totalClientMs: 38 },
        ],
        errors: ['sensitive error: http://secret.internal/token=xyz', 'socket hangup on user 42'],
      };

      const result = validateChildDonePayload(rawPayload, bounds);
      expect(result.reads.length).toBe(2);
      expect(result.ballots.length).toBe(2);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toBe('CHILD_REPORTED_FAILURES count=2');
      // Verify raw sensitive error strings are never echoed
      expect(result.errors[0]).not.toContain('secret.internal');
      expect(result.errors[0]).not.toContain('user 42');
    });

    it('rejects DONE payload with excessive cardinality', () => {
      const bounds = { maxReads: 3, maxBallots: 2 };
      const rawPayload = {
        type: 'DONE',
        reads: [
          { reqId: 'r1', kind: 'overview', status: 200, totalClientMs: 10 },
          { reqId: 'r2', kind: 'overview', status: 200, totalClientMs: 10 },
          { reqId: 'r3', kind: 'overview', status: 200, totalClientMs: 10 },
          { reqId: 'r4', kind: 'overview', status: 200, totalClientMs: 10 }, // exceeds maxReads 3
        ],
        ballots: [],
        errors: [],
      };

      expect(() => validateChildDonePayload(rawPayload, bounds)).toThrow(/exceeded upper bound/);
    });

    it('rejects DONE payload when reqId collision occurs between reads and ballots', () => {
      const bounds = { maxReads: 10, maxBallots: 10 };
      const rawPayload = {
        type: 'DONE',
        reads: [{ reqId: 'colliding-id', kind: 'overview', status: 200, totalClientMs: 10 }],
        ballots: [{ reqId: 'colliding-id', kind: '0', status: 200, totalClientMs: 20 }],
        errors: [],
      };

      expect(() => validateChildDonePayload(rawPayload, bounds)).toThrow(/duplicate reqId/);
    });

    it('rejects malformed DONE payloads with invalid structures', () => {
      expect(() => validateChildDonePayload(null)).toThrow();
      expect(() => validateChildDonePayload('DONE')).toThrow();
      expect(() => validateChildDonePayload({ reads: 'not an array', ballots: [], errors: [] })).toThrow();
      expect(() => validateChildDonePayload({ reads: [], ballots: null, errors: [] })).toThrow();
      expect(() => validateChildDonePayload({ reads: [], ballots: [], errors: {} })).toThrow();
    });
  });

  describe('Loopback failure-path tests without PostgreSQL', () => {
    it('promptly handles child ERROR message and fails before long timeout', async () => {
      const repoDir = path.resolve(__dirname, '..');
      const childScript = path.join(repoDir, 'scripts', 'juanchoice-capacity-child-client.ts');

      const child = fork(childScript, [], {
        cwd: repoDir,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          NODE_PATH: process.env.NODE_PATH,
        },
        execArgv: ['-r', 'tsx'],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });

      let childReady = false;
      let reportedError: string | null = null;
      const childErrors: string[] = [];

      child.on('message', (msg: ChildToParentMessage) => {
        if (msg.type === 'READY') {
          childReady = true;
        } else if (msg.type === 'ERROR') {
          reportedError = msg.error;
          childErrors.push('CHILD_REPORTED_ERROR');
        }
      });

      const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }));
      });

      try {
        const readyDeadline = Date.now() + 5000;
        while (!childReady && Date.now() < readyDeadline) {
          await new Promise(r => setTimeout(r, 50));
        }
        expect(childReady).toBe(true);

        // Send an invalid START config to trigger child ERROR event
        const startMsg: ParentToChildMessage = {
          type: 'START',
          config: {
            baseUrl: 'http://127.0.0.1:9999/invalid-path', // prohibited custom path
            campaignId: 'c1',
            candidateIds: ['cand-1', 'cand-2'],
            tokens: ['t1'],
            durationMs: 2000,
            pollIntervalMs: 500,
            voterCount: 1,
            readerCount: 1,
          },
        };
        child.send(startMsg);

        // Race child exit against 4s timeout (well below capacity workload timeout)
        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<'timeout'>(r => {
          timeoutHandle = setTimeout(() => r('timeout'), 4000);
        });

        let outcome: { code: number | null; signal: NodeJS.Signals | null } | 'timeout';
        try {
          outcome = await Promise.race([exitPromise, timeoutPromise]);
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }

        expect(outcome).not.toBe('timeout');
        const exitResult = outcome as { code: number | null; signal: NodeJS.Signals | null };
        expect(exitResult.code).not.toBe(0);
        expect(reportedError).toBe('INVALID_START_CONFIG');
        expect(childErrors).toContain('CHILD_REPORTED_ERROR');
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGTERM'); } catch {}
          let cleanupTimeout: NodeJS.Timeout | undefined;
          await Promise.race([
            exitPromise,
            new Promise(r => { cleanupTimeout = setTimeout(r, 1000); }),
          ]).finally(() => {
            if (cleanupTimeout) clearTimeout(cleanupTimeout);
          });
        }
      }
    });

    it('promptly handles child disconnect before valid DONE and cleans up boundedly', async () => {
      const repoDir = path.resolve(__dirname, '..');
      const childScript = path.join(repoDir, 'scripts', 'juanchoice-capacity-child-client.ts');

      const child = fork(childScript, [], {
        cwd: repoDir,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          NODE_PATH: process.env.NODE_PATH,
        },
        execArgv: ['-r', 'tsx'],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });

      let childReady = false;
      let disconnectObserved = false;
      const errors: string[] = [];

      child.on('message', (msg: ChildToParentMessage) => {
        if (msg.type === 'READY') {
          childReady = true;
        }
      });

      child.on('disconnect', () => {
        disconnectObserved = true;
        errors.push('CHILD_DISCONNECT_BEFORE_VALID_DONE');
      });

      const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }));
      });

      try {
        const readyDeadline = Date.now() + 5000;
        while (!childReady && Date.now() < readyDeadline) {
          await new Promise(r => setTimeout(r, 50));
        }
        expect(childReady).toBe(true);

        // Abruptly disconnect IPC from parent side
        child.disconnect();

        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<'timeout'>(r => {
          timeoutHandle = setTimeout(() => r('timeout'), 4000);
        });

        let outcome: { code: number | null; signal: NodeJS.Signals | null } | 'timeout';
        try {
          outcome = await Promise.race([exitPromise, timeoutPromise]);
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }

        expect(outcome).not.toBe('timeout');
        expect(disconnectObserved).toBe(true);
        expect(errors).toContain('CHILD_DISCONNECT_BEFORE_VALID_DONE');
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGTERM'); } catch {}
          let cleanupTimeout: NodeJS.Timeout | undefined;
          await Promise.race([
            exitPromise,
            new Promise(r => { cleanupTimeout = setTimeout(r, 1000); }),
          ]).finally(() => {
            if (cleanupTimeout) clearTimeout(cleanupTimeout);
          });
        }
      }
    });
  });
});
