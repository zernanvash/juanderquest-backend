#!/usr/bin/env node
// Creates the dedicated dev (seeded dummy data) and prod (clean, real-UX)
// PostgreSQL databases on the server configured by `.env.dev` / `.env.prod`,
// then applies migrations and seeds the dev database.
//
// Usage:
//   cp .env.dev.example .env.dev     (adjust credentials)
//   cp .env.prod.example .env.prod   (adjust credentials + JWT secret)
//   npm run db:setup
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import { Client } from 'pg';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILES = ['dev', 'prod'];

function fail(message) {
  console.error(`[db-setup] ${message}`);
  process.exit(1);
}

const configs = {};
for (const profile of PROFILES) {
  const file = join(rootDir, `.env.${profile}`);
  if (!existsSync(file)) {
    fail(`Missing ${file}. Copy .env.${profile}.example to .env.${profile} and adjust credentials first.`);
  }
  const target = {};
  dotenv.config({ path: file, processEnv: target });
  if (!target.DATABASE_URL) {
    fail(`${file} must define DATABASE_URL.`);
  }
  configs[profile] = target;
}

const devUrl = new URL(configs.dev.DATABASE_URL);
const prodUrl = new URL(configs.prod.DATABASE_URL);
if (devUrl.host !== prodUrl.host || devUrl.username !== prodUrl.username) {
  fail('.env.dev and .env.prod must share the same PostgreSQL host and user (only the database name differs).');
}

function databaseName(url) {
  const name = url.pathname.replace(/^\//, '');
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    fail(`Refusing to create suspicious database name "${name}".`);
  }
  return name;
}

const targets = [
  { profile: 'dev', name: databaseName(devUrl) },
  { profile: 'prod', name: databaseName(prodUrl) },
];
if (targets[0].name === targets[1].name) {
  fail('.env.dev and .env.prod must point at different databases.');
}

async function ensureDatabase(adminUrl, dbName) {
  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 3000 });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (existing.rowCount) {
      console.log(`  • ${dbName} already exists`);
      return;
    }
    await client.query(`CREATE DATABASE "${dbName}"`);
    console.log(`  ✓ created ${dbName}`);
  } finally {
    await client.end();
  }
}

async function withMaintenanceDatabase(run) {
  let lastError;
  for (const candidate of ['postgres', 'template1']) {
    const maintenance = new URL(devUrl.toString());
    maintenance.pathname = `/${candidate}`;
    try {
      await run(maintenance.toString());
      return;
    } catch (error) {
      lastError = error;
      // 3D000 = maintenance database does not exist; try the next candidate.
      // Anything else (connection refused, auth failure) is fatal and should
      // not be masked by a second attempt.
      if (error?.code !== '3D000') {
        fail(`Could not provision databases at ${devUrl.host}: ${error.message}`);
      }
    }
  }
  fail(`Could not connect to PostgreSQL at ${devUrl.host}: ${lastError?.message ?? 'unknown error'}`);
}

const tsxCli = join(rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
if (!existsSync(tsxCli)) {
  fail('Could not find the local tsx CLI (node_modules/tsx/dist/cli.mjs). Run npm install first.');
}

await withMaintenanceDatabase(async (adminUrl) => {
  console.log('[db-setup] Creating databases:');
  for (const { name } of targets) {
    await ensureDatabase(adminUrl, name);
  }
});

console.log('[db-setup] Applying migrations:');
for (const { profile } of targets) {
  const args = ['scripts/db-migrate.ts'];
  if (profile === 'dev') args.push('--seed');
  const result = spawnSync(process.execPath, [tsxCli, ...args], {
    cwd: rootDir,
    env: { ...process.env, JDQ_ENV: profile },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    fail(`Migration run failed for profile=${profile}.`);
  }
}

console.log('[db-setup] Done.');
console.log('  Development (dummy data):  npm run dev:dummy');
console.log('  Real UX (clean database):  npm run start:real');
