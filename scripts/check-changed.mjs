#!/usr/bin/env node
// Plan 125a: fast inner-loop check for small changes.
// Changed .ts files = committed since the merge base with origin/master + staged + unstaged + untracked.
// Runs: incremental tsc (src), eslint and prettier on those files, jest --findRelatedTests.
// This is the implementer's quick gate; the orchestrator still runs `npm run check:full` + real-PG.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const base = process.env.CHECK_BASE || 'origin/master';
let mergeBase = '';
try {
  mergeBase = git('merge-base', 'HEAD', base);
} catch {
  console.warn(`[check:fast] no merge base with ${base}; checking uncommitted changes only`);
}
const lists = [
  mergeBase ? git('diff', '--name-only', '--diff-filter=ACMR', mergeBase, 'HEAD') : '',
  git('diff', '--name-only', '--diff-filter=ACMR'),
  git('diff', '--name-only', '--diff-filter=ACMR', '--cached'),
  git('ls-files', '--others', '--exclude-standard'),
];
const files = [...new Set(lists.join('\n').split('\n'))]
  .filter((f) => /^(src|tests)\/.+\.ts$/.test(f) && existsSync(f))
  .sort();

if (files.length === 0) {
  console.log('[check:fast] no changed .ts files under src/ or tests/');
  process.exit(0);
}
console.log(`[check:fast] ${files.length} changed file(s):\n  ${files.join('\n  ')}`);

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const steps = [
  ['typecheck (incremental)', ['tsc', '--noEmit']],
  ['eslint', ['eslint', '--cache', '--cache-location', '.cache/eslint/', ...files]],
  ['prettier', ['prettier', '--cache', '--cache-location', '.cache/prettier', '--check', ...files]],
  ['jest (related tests)', ['jest', '--findRelatedTests', ...files, '--passWithNoTests']],
];
for (const [label, args] of steps) {
  const started = Date.now();
  const result = spawnSync(npx, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    console.error(`[check:fast] FAILED at ${label} (${seconds}s)`);
    process.exit(result.status ?? 1);
  }
  console.log(`[check:fast] ${label} ok (${seconds}s)`);
}
console.log('[check:fast] all passed');
