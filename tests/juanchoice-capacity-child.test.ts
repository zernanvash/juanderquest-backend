import http from 'node:http';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import path from 'node:path';
import { validateChildStartConfig, type ChildToParentMessage, type ParentToChildMessage } from '../scripts/juanchoice-capacity-child-client.js';

describe('JuanChoice capacity child client loopback test', () => {
  it('validates ChildStartConfig properly and rejects deceptive or invalid configs', () => {
    expect(() => validateChildStartConfig(null)).toThrow();
    expect(() => validateChildStartConfig({ baseUrl: 'http://evil.com' })).toThrow();
    expect(() => validateChildStartConfig({ baseUrl: 'http://127.0.0.1:1234@evil.test' })).toThrow();
    expect(() => validateChildStartConfig({ baseUrl: 'http://127.0.0.1' })).toThrow(); // missing port
    expect(() => validateChildStartConfig({ baseUrl: 'http://127.0.0.1:0' })).toThrow(); // port out of bounds
    expect(() => validateChildStartConfig({ baseUrl: 'http://127.0.0.1:70000' })).toThrow(); // port out of bounds
    expect(() => validateChildStartConfig({ baseUrl: 'http://127.0.0.1:5555/api' })).toThrow(); // custom pathname rejected
    expect(() => validateChildStartConfig({ baseUrl: 'http://127.0.0.1:5555/api/v1' })).toThrow(); // prefix rejected
    expect(() => validateChildStartConfig({ baseUrl: 'http://127.0.0.1:5555/api/v1/juanchoice/extra' })).toThrow(); // child path rejected
    expect(() => validateChildStartConfig({ baseUrl: 'http://127.0.0.1:5555/api/v1/juanchoice/../admin' })).toThrow(); // traversal rejected
    expect(() => validateChildStartConfig({ baseUrl: 'http://127.0.0.1:5555/api/v1/juanchoice?param=1' })).toThrow(); // search forbidden
    expect(() => validateChildStartConfig({ baseUrl: 'http://127.0.0.1:5555/api/v1/juanchoice#hash' })).toThrow(); // hash forbidden
    expect(() => validateChildStartConfig({ baseUrl: 'http://127.0.0.1:5555?param=1' })).toThrow(); // search forbidden
    expect(() => validateChildStartConfig({ baseUrl: 'http://127.0.0.1:5555#hash' })).toThrow(); // hash forbidden

    const baseValid = {
      baseUrl: 'http://127.0.0.1:5555',
      campaignId: 'camp-1',
      candidateIds: ['cand-1', 'cand-2'],
      tokens: ['token-1'],
      durationMs: 2000,
      pollIntervalMs: 500,
      voterCount: 1,
      readerCount: 2,
    };

    expect(() => validateChildStartConfig({ ...baseValid, durationMs: Infinity })).toThrow();
    expect(() => validateChildStartConfig({ ...baseValid, durationMs: 500 })).toThrow();
    expect(() => validateChildStartConfig({ ...baseValid, pollIntervalMs: NaN })).toThrow();
    expect(() => validateChildStartConfig({ ...baseValid, voterCount: 1.5 })).toThrow();
    expect(() => validateChildStartConfig({ ...baseValid, voterCount: 5 })).toThrow(); // voterCount > tokens.length
    expect(() => validateChildStartConfig({ ...baseValid, readerCount: -1 })).toThrow();

    // readerAuthMode and readerTokens validation tests
    // 1. Unknown / invalid mode
    expect(() => validateChildStartConfig({ ...baseValid, readerAuthMode: 'unknown_mode' })).toThrow(
      'readerAuthMode must be guest or wallet_alpha'
    );
    expect(() => validateChildStartConfig({ ...baseValid, readerAuthMode: 123 })).toThrow();

    // 2. Guest with forbidden non-empty readerTokens
    expect(() =>
      validateChildStartConfig({
        ...baseValid,
        readerAuthMode: 'guest',
        readerTokens: ['forbidden-token'],
      })
    ).toThrow('readerTokens must not be non-empty in guest readerAuthMode');

    // 3. Guest with valid empty readerTokens or omitted readerTokens
    const validGuestWithEmpty = validateChildStartConfig({
      ...baseValid,
      readerAuthMode: 'guest',
      readerTokens: [],
    });
    expect(validGuestWithEmpty.readerAuthMode).toBe('guest');
    expect(validGuestWithEmpty.readerTokens).toEqual([]);

    const validGuestDefault = validateChildStartConfig(baseValid);
    expect(validGuestDefault.readerAuthMode).toBe('guest');
    expect(validGuestDefault.readerTokens).toBeUndefined();

    // 4. Wallet-alpha tests
    const dummy100Tokens = Array.from({ length: 100 }, (_, i) => `jwt-wallet-reader-token-${i}`);

    // Absent readerTokens in wallet_alpha
    expect(() =>
      validateChildStartConfig({
        ...baseValid,
        readerCount: 100,
        readerAuthMode: 'wallet_alpha',
      })
    ).toThrow('readerTokens must be an array of exactly 100 tokens in wallet_alpha readerAuthMode');

    // Mismatched token count (e.g. 99 tokens or 101 tokens)
    expect(() =>
      validateChildStartConfig({
        ...baseValid,
        readerCount: 100,
        readerAuthMode: 'wallet_alpha',
        readerTokens: dummy100Tokens.slice(0, 99),
      })
    ).toThrow('readerTokens must be an array of exactly 100 tokens in wallet_alpha readerAuthMode');

    expect(() =>
      validateChildStartConfig({
        ...baseValid,
        readerCount: 100,
        readerAuthMode: 'wallet_alpha',
        readerTokens: [...dummy100Tokens, 'extra-token'],
      })
    ).toThrow('readerTokens must be an array of exactly 100 tokens in wallet_alpha readerAuthMode');

    // Mismatched readerCount (e.g. readerCount = 50 or 101)
    expect(() =>
      validateChildStartConfig({
        ...baseValid,
        readerCount: 50,
        readerAuthMode: 'wallet_alpha',
        readerTokens: dummy100Tokens,
      })
    ).toThrow('readerCount must be exactly 100 in wallet_alpha readerAuthMode');

    // Blank / empty string token in wallet_alpha
    const dummyWithBlank = [...dummy100Tokens];
    dummyWithBlank[42] = '   ';
    expect(() =>
      validateChildStartConfig({
        ...baseValid,
        readerCount: 100,
        readerAuthMode: 'wallet_alpha',
        readerTokens: dummyWithBlank,
      })
    ).toThrow('Each readerToken must be a non-empty string');

    // Ensure sensitive token text is never leaked in error messages
    const sensitiveToken = 'super-secret-jwt-private-payload-string-xyz';
    const dummyWithSensitiveBlank = [...dummy100Tokens];
    dummyWithSensitiveBlank[5] = '';
    dummyWithSensitiveBlank[6] = sensitiveToken;
    try {
      validateChildStartConfig({
        ...baseValid,
        readerCount: 100,
        readerAuthMode: 'wallet_alpha',
        readerTokens: dummyWithSensitiveBlank,
      });
      throw new Error('Should have failed');
    } catch (err: unknown) {
      const errorMsg = String(err);
      expect(errorMsg).not.toContain(sensitiveToken);
    }

    // Valid wallet-alpha config
    const validWalletAlpha = validateChildStartConfig({
      ...baseValid,
      readerCount: 100,
      readerAuthMode: 'wallet_alpha',
      readerTokens: dummy100Tokens,
    });
    expect(validWalletAlpha.readerAuthMode).toBe('wallet_alpha');
    expect(validWalletAlpha.readerCount).toBe(100);
    expect(validWalletAlpha.readerTokens?.length).toBe(100);

    const valid = validateChildStartConfig(baseValid);
    expect(valid.campaignId).toBe('camp-1');
    expect(valid.baseUrl).toBe('http://127.0.0.1:5555');

    const validHarnessBase = validateChildStartConfig({
      ...baseValid,
      baseUrl: 'http://127.0.0.1:49152/api/v1/juanchoice',
    });
    expect(validHarnessBase.baseUrl).toBe('http://127.0.0.1:49152/api/v1/juanchoice');
  });

  it('fails promptly with sanitized ERROR code and exits nonzero on invalid START config', async () => {
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
    let receivedError: string | null = null;

    child.on('message', (msg: ChildToParentMessage) => {
      if (msg.type === 'READY') {
        childReady = true;
      } else if (msg.type === 'ERROR') {
        receivedError = msg.error;
      }
    });

    const exitPromise = new Promise<{ code: number | null }>((resolve) => {
      child.on('exit', (code) => resolve({ code }));
    });

    try {
      const readyDeadline = Date.now() + 5000;
      while (!childReady && Date.now() < readyDeadline) {
        await new Promise(r => setTimeout(r, 50));
      }
      expect(childReady).toBe(true);

      // Send invalid start config with deceptive URL and sensitive tokens
      child.send({
        type: 'START',
        config: {
          baseUrl: 'http://127.0.0.1:8080@evil.com',
          campaignId: 'bad-camp',
          candidateIds: ['cand-1', 'cand-2'],
          tokens: ['secret-jwt-token-12345'],
          durationMs: 1500,
          pollIntervalMs: 600,
          voterCount: 1,
          readerCount: 1,
        },
      } as any);

      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        timeoutHandle = setTimeout(() => resolve('timeout'), 5000);
      });

      let finishedOrTimeout: { code: number | null } | 'timeout';
      try {
        finishedOrTimeout = await Promise.race([exitPromise, timeoutPromise]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      expect(finishedOrTimeout).not.toBe('timeout');
      const exitResult = finishedOrTimeout as { code: number | null };
      expect(exitResult.code).not.toBe(0);
      expect(receivedError).toBe('INVALID_START_CONFIG');
      expect(receivedError).not.toContain('secret-jwt-token-12345');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGTERM');
        } catch {}
        let cleanupTimeout: NodeJS.Timeout | undefined;
        await Promise.race([
          exitPromise,
          new Promise(r => { cleanupTimeout = setTimeout(r, 2000); }),
        ]).finally(() => {
          if (cleanupTimeout) clearTimeout(cleanupTimeout);
        });
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {}
        }
      }
    }
  });

  it('runs loopback HTTP schedule against a lightweight node:http server with child process (guest mode)', async () => {
    const receivedRequests: Array<{
      url: string;
      method: string;
      authorization?: string;
      xForwardedFor?: string;
      benchmarkId?: string;
      benchmarkPhase?: string;
    }> = [];

    const server = http.createServer((req, res) => {
      const benchmarkId = req.headers['x-benchmark-request-id'] as string;
      const benchmarkPhase = req.headers['x-benchmark-phase'] as string;
      const authorization = req.headers['authorization'] as string | undefined;
      const xForwardedFor = req.headers['x-forwarded-for'] as string | undefined;
      receivedRequests.push({
        url: req.url || '',
        method: req.method || '',
        authorization,
        xForwardedFor,
        benchmarkId,
        benchmarkPhase,
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Invalid address');
    const baseUrl = `http://127.0.0.1:${address.port}`;

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
    let childDone = false;
    let donePayload: { readonly reads: readonly any[]; readonly ballots: readonly any[]; readonly errors: readonly string[] } | null = null;

    child.on('message', (msg: ChildToParentMessage) => {
      if (msg.type === 'READY') {
        childReady = true;
      } else if (msg.type === 'DONE') {
        childDone = true;
        donePayload = { reads: msg.reads, ballots: msg.ballots, errors: msg.errors };
        try {
          child.send({ type: 'ACK_DONE' } as ParentToChildMessage);
        } catch {
          // IPC channel may already be closed
        }
      }
    });

    const exitPromise = new Promise<{ code: number | null }>((resolve) => {
      child.on('exit', (code) => resolve({ code }));
    });

    try {
      // Wait for READY (bounded 5s)
      const readyDeadline = Date.now() + 5000;
      while (!childReady && Date.now() < readyDeadline) {
        await new Promise(r => setTimeout(r, 50));
      }
      expect(childReady).toBe(true);

      const voterToken = 'dummy-voter-token-1';
      const startMsg: ParentToChildMessage = {
        type: 'START',
        config: {
          baseUrl,
          campaignId: 'test-camp',
          candidateIds: ['cand-1', 'cand-2'],
          tokens: [voterToken],
          durationMs: 1500,
          pollIntervalMs: 600,
          voterCount: 1,
          readerCount: 2,
        },
      };
      child.send(startMsg);

      // Bounded wait for exit (10s allowance)
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        timeoutHandle = setTimeout(() => resolve('timeout'), 10000);
      });
      let finishedOrTimeout: { code: number | null } | 'timeout';
      try {
        finishedOrTimeout = await Promise.race([exitPromise, timeoutPromise]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
      expect(finishedOrTimeout).not.toBe('timeout');

      const exitResult = finishedOrTimeout as { code: number | null };
      expect(exitResult.code).toBe(0);
      expect(childDone).toBe(true);
      expect(Boolean(donePayload)).toBe(true);

      const payload = donePayload!;
      expect(payload.reads.length).toBeGreaterThanOrEqual(4); // wave 0 (2) + midpoint wave 1 (2)
      expect(payload.ballots.length).toBe(2); // wave 0 (1) + wave 1 (1)
      expect(payload.errors.length).toBe(0);
      for (const s of payload.reads) {
        expect(s.status).toBe(200);
        expect(s.totalClientMs).toBeGreaterThan(0);
        expect(s.reqId).toBeDefined();
      }

      // Assert phase headers on received requests
      const ballotRequests = receivedRequests.filter(r => r.method === 'PUT');
      expect(ballotRequests.length).toBe(2);
      for (const req of ballotRequests) {
        expect(req.benchmarkPhase).toBe('mixed_ballot_burst');
        // Confirm voter token is carried on ballot requests
        expect(req.authorization).toBe(`Bearer ${voterToken}`);
      }

      const readRequests = receivedRequests.filter(r => r.method === 'GET');
      expect(readRequests.length).toBeGreaterThanOrEqual(6); // 3 rounds * 2 readers
      // Confirm guest GETs have NO Authorization header
      for (const req of readRequests) {
        expect(req.authorization).toBeUndefined();
      }

      // Round 0 (first 2 reads) sent concurrently with wave 0 ballots -> mixed_ballot_burst
      for (const req of readRequests.slice(0, 2)) {
        expect(req.benchmarkPhase).toBe('mixed_ballot_burst');
      }
      // Round 1 (at 600ms < 750ms) -> idle_read
      for (const req of readRequests.slice(2, 4)) {
        expect(req.benchmarkPhase).toBe('idle_read');
      }
      // Round 2 (at 1200ms >= 750ms) sent concurrently with wave 1 ballots -> mixed_ballot_burst
      for (const req of readRequests.slice(4, 6)) {
        expect(req.benchmarkPhase).toBe('mixed_ballot_burst');
      }
      // Any further rounds if present are idle_read
      for (const req of readRequests.slice(6)) {
        expect(req.benchmarkPhase).toBe('idle_read');
      }
    } finally {
      if (child.connected) {
        try {
          child.send({ type: 'ABORT' } as ParentToChildMessage, () => {});
        } catch {}
      }
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGTERM');
        } catch {}
        let cleanupTimeout: NodeJS.Timeout | undefined;
        await Promise.race([
          exitPromise,
          new Promise(r => { cleanupTimeout = setTimeout(r, 2000); }),
        ]).finally(() => {
          if (cleanupTimeout) clearTimeout(cleanupTimeout);
        });
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {}
          let killTimeout: NodeJS.Timeout | undefined;
          await Promise.race([
            exitPromise,
            new Promise(r => { killTimeout = setTimeout(r, 2000); }),
          ]).finally(() => {
            if (killTimeout) clearTimeout(killTimeout);
          });
        }
      }
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  }, 15000);

  it('runs loopback HTTP schedule with wallet_alpha reader tokens and verifies header indexing in memory', async () => {
    const receivedRequests: Array<{
      url: string;
      method: string;
      authorization?: string;
      xForwardedFor?: string;
      benchmarkId?: string;
      benchmarkPhase?: string;
    }> = [];

    const server = http.createServer((req, res) => {
      const benchmarkId = req.headers['x-benchmark-request-id'] as string;
      const benchmarkPhase = req.headers['x-benchmark-phase'] as string;
      const authorization = req.headers['authorization'] as string | undefined;
      const xForwardedFor = req.headers['x-forwarded-for'] as string | undefined;
      receivedRequests.push({
        url: req.url || '',
        method: req.method || '',
        authorization,
        xForwardedFor,
        benchmarkId,
        benchmarkPhase,
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Invalid address');
    const baseUrl = `http://127.0.0.1:${address.port}`;

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
    let childDone = false;
    let donePayload: { readonly reads: readonly any[]; readonly ballots: readonly any[]; readonly errors: readonly string[] } | null = null;

    child.on('message', (msg: ChildToParentMessage) => {
      if (msg.type === 'READY') {
        childReady = true;
      } else if (msg.type === 'DONE') {
        childDone = true;
        donePayload = { reads: msg.reads, ballots: msg.ballots, errors: msg.errors };
        try {
          child.send({ type: 'ACK_DONE' } as ParentToChildMessage);
        } catch {
          // IPC channel may already be closed
        }
      }
    });

    const exitPromise = new Promise<{ code: number | null }>((resolve) => {
      child.on('exit', (code) => resolve({ code }));
    });

    try {
      const readyDeadline = Date.now() + 5000;
      while (!childReady && Date.now() < readyDeadline) {
        await new Promise(r => setTimeout(r, 50));
      }
      expect(childReady).toBe(true);

      const voterTokens = Array.from({ length: 50 }, (_, i) => `voter-token-unique-${i}`);
      const readerTokens = Array.from({ length: 100 }, (_, i) => `wallet-reader-unique-token-${i}`);

      const startMsg: ParentToChildMessage = {
        type: 'START',
        config: {
          baseUrl,
          campaignId: 'test-camp-alpha',
          candidateIds: ['cand-1', 'cand-2'],
          tokens: voterTokens,
          durationMs: 1500,
          pollIntervalMs: 600,
          voterCount: 2,
          readerCount: 100,
          readerAuthMode: 'wallet_alpha',
          readerTokens,
        },
      };
      child.send(startMsg);

      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        timeoutHandle = setTimeout(() => resolve('timeout'), 10000);
      });
      let finishedOrTimeout: { code: number | null } | 'timeout';
      try {
        finishedOrTimeout = await Promise.race([exitPromise, timeoutPromise]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
      expect(finishedOrTimeout).not.toBe('timeout');

      const exitResult = finishedOrTimeout as { code: number | null };
      expect(exitResult.code).toBe(0);
      expect(childDone).toBe(true);
      expect(Boolean(donePayload)).toBe(true);
      expect(donePayload!.errors.length).toBe(0);

      // Verify ballot requests carry the distinct voter tokens
      const ballotRequests = receivedRequests.filter(r => r.method === 'PUT');
      expect(ballotRequests.length).toBe(4); // 2 waves * 2 voters
      for (const req of ballotRequests) {
        // Voter index comes from X-Forwarded-For: 10.40.2.${i + 1}
        const ipMatch = req.xForwardedFor?.match(/^10\.40\.2\.(\d+)$/);
        expect(ipMatch).not.toBeNull();
        const voterIndex = Number(ipMatch![1]) - 1;
        expect(voterIndex).toBeGreaterThanOrEqual(0);
        expect(voterIndex).toBeLessThan(2);
        expect(req.authorization).toBe(`Bearer ${voterTokens[voterIndex]}`);
      }

      // Verify read requests carry the intended reader token matched strictly in-memory by reader index
      const readRequests = receivedRequests.filter(r => r.method === 'GET');
      expect(readRequests.length).toBeGreaterThanOrEqual(200); // at least 2 waves of 100 readers
      for (const req of readRequests) {
        // Reader index comes from X-Forwarded-For: 10.40.1.${i + 1}
        const ipMatch = req.xForwardedFor?.match(/^10\.40\.1\.(\d+)$/);
        expect(ipMatch).not.toBeNull();
        const readerIndex = Number(ipMatch![1]) - 1;
        expect(readerIndex).toBeGreaterThanOrEqual(0);
        expect(readerIndex).toBeLessThan(100);
        // Compare Authorization header in memory against the intended index's token without logging token values
        const matchesIntendedToken = req.authorization === `Bearer ${readerTokens[readerIndex]}`;
        expect(matchesIntendedToken).toBe(true);
      }
    } finally {
      if (child.connected) {
        try {
          child.send({ type: 'ABORT' } as ParentToChildMessage, () => {});
        } catch {}
      }
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGTERM');
        } catch {}
        let cleanupTimeout: NodeJS.Timeout | undefined;
        await Promise.race([
          exitPromise,
          new Promise(r => { cleanupTimeout = setTimeout(r, 2000); }),
        ]).finally(() => {
          if (cleanupTimeout) clearTimeout(cleanupTimeout);
        });
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {}
          let killTimeout: NodeJS.Timeout | undefined;
          await Promise.race([
            exitPromise,
            new Promise(r => { killTimeout = setTimeout(r, 2000); }),
          ]).finally(() => {
            if (killTimeout) clearTimeout(killTimeout);
          });
        }
      }
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  }, 15000);
});
