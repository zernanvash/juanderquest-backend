import { spawnSync } from 'child_process';
import path from 'path';
import {
  resolveBallotMode,
  resolveClientMode,
  resolveReaderAuthMode,
} from '../scripts/juanchoice-capacity-mode.js';

describe('JuanChoice capacity harness mode validation', () => {
  const repoDir = path.resolve(__dirname, '..');
  const scriptPath = path.join(repoDir, 'scripts', 'juanchoice-capacity-rehearsal.ts');

  describe('pure resolveBallotMode helper', () => {
    it('defaults to sequential when envValue is undefined', () => {
      expect(resolveBallotMode(undefined)).toBe('sequential');
      expect(resolveBallotMode()).toBe('sequential');
    });

    it('returns sequential when explicitly passed sequential', () => {
      expect(resolveBallotMode('sequential')).toBe('sequential');
    });

    it('returns batch when explicitly passed batch', () => {
      expect(resolveBallotMode('batch')).toBe('batch');
    });

    it('throws assertion error when passed invalid mode', () => {
      expect(() => resolveBallotMode('invalid_mode')).toThrow(
        'JDQ_CAPACITY_BALLOT_MODE must be "batch" or "sequential"'
      );
      expect(() => resolveBallotMode('')).toThrow(
        'JDQ_CAPACITY_BALLOT_MODE must be "batch" or "sequential"'
      );
    });
  });

  describe('pure resolveClientMode helper', () => {
    it('defaults to inprocess when envValue is undefined', () => {
      expect(resolveClientMode(undefined)).toBe('inprocess');
      expect(resolveClientMode()).toBe('inprocess');
    });

    it('returns inprocess when explicitly passed inprocess', () => {
      expect(resolveClientMode('inprocess')).toBe('inprocess');
    });

    it('returns child_process when explicitly passed child_process', () => {
      expect(resolveClientMode('child_process')).toBe('child_process');
    });

    it('throws assertion error when passed invalid mode', () => {
      expect(() => resolveClientMode('invalid_mode')).toThrow(
        'JDQ_CAPACITY_CLIENT_MODE must be "inprocess" or "child_process"'
      );
      expect(() => resolveClientMode('')).toThrow(
        'JDQ_CAPACITY_CLIENT_MODE must be "inprocess" or "child_process"'
      );
    });
  });

  describe('pure resolveReaderAuthMode helper', () => {
    it('defaults to guest when envValue is undefined', () => {
      expect(resolveReaderAuthMode(undefined)).toBe('guest');
      expect(resolveReaderAuthMode()).toBe('guest');
    });

    it('returns guest when explicitly passed guest', () => {
      expect(resolveReaderAuthMode('guest')).toBe('guest');
    });

    it('returns wallet_alpha when explicitly passed wallet_alpha', () => {
      expect(resolveReaderAuthMode('wallet_alpha')).toBe('wallet_alpha');
    });

    it('throws assertion error when passed invalid mode', () => {
      expect(() => resolveReaderAuthMode('invalid_mode')).toThrow(
        'JDQ_CAPACITY_READER_AUTH must be "guest" or "wallet_alpha"'
      );
      expect(() => resolveReaderAuthMode('')).toThrow(
        'JDQ_CAPACITY_READER_AUTH must be "guest" or "wallet_alpha"'
      );
    });
  });

  describe('subprocess startup validation', () => {
    it('rejects an invalid JDQ_CAPACITY_BALLOT_MODE before connecting to database or opening fixture', () => {
      const result = spawnSync(
        process.execPath,
        ['-r', 'tsx', scriptPath],
        {
          cwd: repoDir,
          env: {
            ...process.env,
            JDQ_CAPACITY_BALLOT_MODE: 'invalid_mode',
            // Even if a PG URL is present, it should fail immediately on mode assert
            JDQ_REAL_PG_URL: 'postgresql://127.0.0.1:55432/jdq_reliability_test',
            NODE_ENV: 'test',
          },
          encoding: 'utf8',
        }
      );

      expect(result.status).not.toBe(0);
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(combinedOutput).toContain('JDQ_CAPACITY_BALLOT_MODE must be "batch" or "sequential"');
      // Ensure it did not attempt to connect or print fixture lifecycle lines
      expect(combinedOutput).not.toContain('CAPACITY_START');
      expect(combinedOutput).not.toContain('CAPACITY_FIXTURE_CLOSED');
    });

    it('rejects an invalid JDQ_CAPACITY_CLIENT_MODE before connecting to database or opening fixture', () => {
      const result = spawnSync(
        process.execPath,
        ['-r', 'tsx', scriptPath],
        {
          cwd: repoDir,
          env: {
            ...process.env,
            JDQ_CAPACITY_CLIENT_MODE: 'invalid_mode',
            JDQ_REAL_PG_URL: 'postgresql://127.0.0.1:55432/jdq_reliability_test',
            NODE_ENV: 'test',
          },
          encoding: 'utf8',
        }
      );

      expect(result.status).not.toBe(0);
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(combinedOutput).toContain('JDQ_CAPACITY_CLIENT_MODE must be "inprocess" or "child_process"');
      expect(combinedOutput).not.toContain('CAPACITY_START');
      expect(combinedOutput).not.toContain('CAPACITY_FIXTURE_CLOSED');
    });

    it('accepts sequential mode without failing the mode assertion', () => {
      const result = spawnSync(
        process.execPath,
        ['-r', 'tsx', scriptPath],
        {
          cwd: repoDir,
          env: {
            ...process.env,
            JDQ_CAPACITY_BALLOT_MODE: 'sequential',
            // Intentionally omit JDQ_REAL_PG_URL to test that mode assertion passed and next check reached
            JDQ_REAL_PG_URL: '',
            NODE_ENV: 'test',
          },
          encoding: 'utf8',
        }
      );

      expect(result.status).not.toBe(0);
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(combinedOutput).not.toContain('JDQ_CAPACITY_BALLOT_MODE must be "batch" or "sequential"');
      expect(combinedOutput).toContain('JDQ_REAL_PG_URL is required');
    });

    it('accepts batch mode without failing the mode assertion', () => {
      const result = spawnSync(
        process.execPath,
        ['-r', 'tsx', scriptPath],
        {
          cwd: repoDir,
          env: {
            ...process.env,
            JDQ_CAPACITY_BALLOT_MODE: 'batch',
            // Intentionally omit JDQ_REAL_PG_URL to test that mode assertion passed and next check reached
            JDQ_REAL_PG_URL: '',
            NODE_ENV: 'test',
          },
          encoding: 'utf8',
        }
      );

      expect(result.status).not.toBe(0);
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(combinedOutput).not.toContain('JDQ_CAPACITY_BALLOT_MODE must be "batch" or "sequential"');
      expect(combinedOutput).toContain('JDQ_REAL_PG_URL is required');
    });

    it('defaults to sequential mode when JDQ_CAPACITY_BALLOT_MODE is unset', () => {
      const envCopy = { ...process.env };
      delete envCopy.JDQ_CAPACITY_BALLOT_MODE;
      envCopy.JDQ_REAL_PG_URL = '';
      envCopy.NODE_ENV = 'test';

      const result = spawnSync(
        process.execPath,
        ['-r', 'tsx', scriptPath],
        {
          cwd: repoDir,
          env: envCopy,
          encoding: 'utf8',
        }
      );

      expect(result.status).not.toBe(0);
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(combinedOutput).not.toContain('JDQ_CAPACITY_BALLOT_MODE must be "batch" or "sequential"');
      expect(combinedOutput).toContain('JDQ_REAL_PG_URL is required');
    });

    it('rejects an invalid JDQ_CAPACITY_READER_AUTH before connecting to database or opening fixture', () => {
      const result = spawnSync(
        process.execPath,
        ['-r', 'tsx', scriptPath],
        {
          cwd: repoDir,
          env: {
            ...process.env,
            JDQ_CAPACITY_READER_AUTH: 'invalid_auth',
            JDQ_REAL_PG_URL: 'postgresql://127.0.0.1:55432/jdq_reliability_test',
            NODE_ENV: 'test',
          },
          encoding: 'utf8',
        }
      );

      expect(result.status).not.toBe(0);
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(combinedOutput).toContain('JDQ_CAPACITY_READER_AUTH must be "guest" or "wallet_alpha"');
      expect(combinedOutput).not.toContain('CAPACITY_START');
      expect(combinedOutput).not.toContain('CAPACITY_FIXTURE_CLOSED');
    });

    it('allows wallet_alpha in child_process mode past auth/client mode gates but fails JDQ_REAL_PG_URL is required before fixture creation with empty URL', () => {
      const result = spawnSync(
        process.execPath,
        ['-r', 'tsx', scriptPath],
        {
          cwd: repoDir,
          env: {
            ...process.env,
            JDQ_CAPACITY_READER_AUTH: 'wallet_alpha',
            JDQ_CAPACITY_CLIENT_MODE: 'child_process',
            JDQ_REAL_PG_URL: '',
            NODE_ENV: 'test',
          },
          encoding: 'utf8',
        }
      );

      expect(result.status).not.toBe(0);
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(combinedOutput).not.toContain('JDQ_CAPACITY_READER_AUTH must be "guest" or "wallet_alpha"');
      expect(combinedOutput).not.toContain('JDQ_CAPACITY_CLIENT_MODE must be "inprocess" or "child_process"');
      expect(combinedOutput).not.toContain('WALLET_ALPHA_CHILD_NOT_IMPLEMENTED');
      expect(combinedOutput).toContain('JDQ_REAL_PG_URL is required');
      expect(combinedOutput).not.toContain('CAPACITY_START');
      expect(combinedOutput).not.toContain('CAPACITY_FIXTURE_CLOSED');
    });

    it('allows wallet_alpha in inprocess mode past the wallet gate but fails JDQ_REAL_PG_URL is required before fixture creation with empty URL', () => {
      const result = spawnSync(
        process.execPath,
        ['-r', 'tsx', scriptPath],
        {
          cwd: repoDir,
          env: {
            ...process.env,
            JDQ_CAPACITY_READER_AUTH: 'wallet_alpha',
            JDQ_CAPACITY_CLIENT_MODE: 'inprocess',
            JDQ_REAL_PG_URL: '',
            NODE_ENV: 'test',
          },
          encoding: 'utf8',
        }
      );

      expect(result.status).not.toBe(0);
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(combinedOutput).not.toContain('WALLET_ALPHA_CHILD_NOT_IMPLEMENTED');
      expect(combinedOutput).toContain('JDQ_REAL_PG_URL is required');
      expect(combinedOutput).not.toContain('CAPACITY_START');
      expect(combinedOutput).not.toContain('CAPACITY_FIXTURE_CLOSED');
    });

    it('accepts guest reader auth mode without failing reader auth assertions', () => {
      const result = spawnSync(
        process.execPath,
        ['-r', 'tsx', scriptPath],
        {
          cwd: repoDir,
          env: {
            ...process.env,
            JDQ_CAPACITY_READER_AUTH: 'guest',
            JDQ_REAL_PG_URL: '',
            NODE_ENV: 'test',
          },
          encoding: 'utf8',
        }
      );

      expect(result.status).not.toBe(0);
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(combinedOutput).not.toContain('JDQ_CAPACITY_READER_AUTH must be "guest" or "wallet_alpha"');
      expect(combinedOutput).not.toContain('WALLET_ALPHA_CHILD_NOT_IMPLEMENTED');
      expect(combinedOutput).toContain('JDQ_REAL_PG_URL is required');
    });

    it('defaults to guest reader auth mode when JDQ_CAPACITY_READER_AUTH is unset', () => {
      const envCopy = { ...process.env };
      delete envCopy.JDQ_CAPACITY_READER_AUTH;
      envCopy.JDQ_REAL_PG_URL = '';
      envCopy.NODE_ENV = 'test';

      const result = spawnSync(
        process.execPath,
        ['-r', 'tsx', scriptPath],
        {
          cwd: repoDir,
          env: envCopy,
          encoding: 'utf8',
        }
      );

      expect(result.status).not.toBe(0);
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(combinedOutput).not.toContain('JDQ_CAPACITY_READER_AUTH must be "guest" or "wallet_alpha"');
      expect(combinedOutput).not.toContain('WALLET_ALPHA_CHILD_NOT_IMPLEMENTED');
      expect(combinedOutput).toContain('JDQ_REAL_PG_URL is required');
    });
  });

  describe('WSL wrapper shell pipeline contract', () => {
    const hasWsl = (() => {
      try {
        const check = spawnSync('wsl', ['-e', 'bash', '-c', 'echo OK'], { encoding: 'utf8' });
        return check.status === 0 && check.stdout.includes('OK');
      } catch {
        return false;
      }
    })();

    (hasWsl ? it : it.skip)('captures stdout to report artifact and propagates node non-zero exit with pipefail', () => {
      const testCmd = [
        'set -euo pipefail',
        'report_file=$(mktemp "/tmp/capacity-20261001T120000Z-XXXXXXXX.log")',
        '[[ "$report_file" =~ ^/tmp/capacity-[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9_]{8}\\.log$ ]]',
        'set +e',
        '(echo "TEST_STDOUT_LINE"; echo "TEST_SENSITIVE_STDERR_LINE" >&2; exit 42) | tee "$report_file"',
        'pipeline_status=$?',
        'set -e',
        'echo "STATUS:$pipeline_status"',
        'content=$(cat "$report_file")',
        'echo "LOG_CONTENT:$content"',
        'rm -f "$report_file"',
      ].join('\n');

      const result = spawnSync('wsl', ['-e', 'bash', '-c', testCmd], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('STATUS:42');
      expect(result.stdout).toContain('LOG_CONTENT:TEST_STDOUT_LINE');
      expect(result.stdout).not.toContain('LOG_CONTENT:TEST_SENSITIVE_STDERR_LINE');
    });

    (hasWsl ? it : it.skip)('run-juanchoice-capacity-wsl.sh rejects invalid ballot mode before contacting docker', () => {
      const wrapperPath = path.posix.join(
        path.resolve(repoDir).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`),
        'scripts',
        'run-juanchoice-capacity-wsl.sh'
      );

      const result = spawnSync(
        'wsl',
        ['-e', 'bash', wrapperPath, '30000', '5', 'invalid_mode'],
        { encoding: 'utf8' }
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Ballot mode must be "batch" or "sequential".');
    });

    (hasWsl ? it : it.skip)('run-juanchoice-capacity-wsl.sh rejects invalid client mode before contacting docker', () => {
      const wrapperPath = path.posix.join(
        path.resolve(repoDir).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`),
        'scripts',
        'run-juanchoice-capacity-wsl.sh'
      );

      const result = spawnSync(
        'wsl',
        ['-e', 'bash', wrapperPath, '30000', '5', 'sequential', 'invalid_client_mode'],
        { encoding: 'utf8' }
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Client mode must be "inprocess" or "child_process".');
    });

    (hasWsl ? it : it.skip)('run-juanchoice-capacity-wsl.sh rejects invalid reader auth mode before contacting docker', () => {
      const wrapperPath = path.posix.join(
        path.resolve(repoDir).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`),
        'scripts',
        'run-juanchoice-capacity-wsl.sh'
      );

      const result = spawnSync(
        'wsl',
        ['-e', 'bash', wrapperPath, '30000', '5', 'sequential', 'inprocess', 'invalid_auth'],
        { encoding: 'utf8' }
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Reader auth mode must be "guest" or "wallet_alpha".');
    });

    (hasWsl ? it : it.skip)('verifies source-freshness logic rejects when a source file is newer than compiled rehearsal script', () => {
      // Isolate source-freshness check logic in a mock directory tree
      const testCmd = [
        'set -euo pipefail',
        'tmp_dir=$(mktemp -d)',
        'mkdir -p "$tmp_dir/src" "$tmp_dir/scripts" "$tmp_dir/.local/capacity-build/scripts"',
        'rehearsal="$tmp_dir/.local/capacity-build/scripts/juanchoice-capacity-rehearsal.js"',
        'touch -t 202609010000 "$rehearsal"',
        'touch -t 202609020000 "$tmp_dir/src/test.ts"',
        'newest_source=$(find "$tmp_dir/src" -type f -name "*.ts" -newer "$rehearsal" -print -quit)',
        'if [[ -n "$newest_source" ]]; then echo "STALE_SOURCE_DETECTED"; fi',
        'rm -rf "$tmp_dir"',
      ].join('\n');

      const result = spawnSync('wsl', ['-e', 'bash', '-c', testCmd], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('STALE_SOURCE_DETECTED');
    });

    (hasWsl ? it : it.skip)('verifies byte-for-byte migration check fails closed on mismatch', () => {
      const testCmd = [
        'set -euo pipefail',
        'tmp_dir=$(mktemp -d)',
        'mkdir -p "$tmp_dir/migrations" "$tmp_dir/.local/capacity-build/migrations"',
        'echo "CREATE TABLE test();" > "$tmp_dir/migrations/020_juanchoice_monthly_schedules.sql"',
        'echo "CREATE TABLE modified();" > "$tmp_dir/.local/capacity-build/migrations/020_juanchoice_monthly_schedules.sql"',
        'set +e',
        'cmp -s "$tmp_dir/migrations/020_juanchoice_monthly_schedules.sql" "$tmp_dir/.local/capacity-build/migrations/020_juanchoice_monthly_schedules.sql"',
        'cmp_status=$?',
        'set -e',
        'if [[ $cmp_status -ne 0 ]]; then echo "MIGRATION_MISMATCH_DETECTED"; fi',
        'rm -rf "$tmp_dir"',
      ].join('\n');

      const result = spawnSync('wsl', ['-e', 'bash', '-c', testCmd], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('MIGRATION_MISMATCH_DETECTED');
    });
  });
});
