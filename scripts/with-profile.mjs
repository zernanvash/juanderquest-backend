#!/usr/bin/env node
// Runs a command with JDQ_ENV=<profile> so the backend loads `.env.<profile>`.
// Portable across WSL/macOS/Linux shells and Windows cmd/PowerShell.
import { spawn } from 'node:child_process';

const PROFILES = ['dev', 'prod'];
const [profile, separator, ...command] = process.argv.slice(2);

if (!profile || !PROFILES.includes(profile) || separator !== '--' || command.length === 0) {
  console.error(`Usage: node scripts/with-profile.mjs <${PROFILES.join('|')}> -- <command> [args...]`);
  process.exit(2);
}

const child = spawn(command[0], command.slice(1), {
  stdio: 'inherit',
  env: { ...process.env, JDQ_ENV: profile },
  shell: process.platform === 'win32',
});

child.on('error', (error) => {
  console.error(`[with-profile] Failed to launch: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
