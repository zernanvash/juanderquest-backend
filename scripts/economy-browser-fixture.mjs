#!/usr/bin/env node
// Disposable, marked PostgreSQL fixture for the local economic browser lab.
// Never targets alpha, presentation, production, or the public tunnel.
import { randomUUID, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import { Pool } from 'pg';

const container = 'jdq-reliability-pg-20260910';
const expectedPort = '127.0.0.1:55432';
const databasePattern = /^jdq_economy_lab_[a-f0-9]{12}_dev$/;
const [action, databaseArg, markerArg] = process.argv.slice(2);

function fail(message) {
  console.error(`ECONOMY_LAB_FIXTURE_ERROR ${message}`);
  process.exit(1);
}

function wslDocker(args, { secret = false } = {}) {
  const command = platform() === 'win32' ? 'wsl' : 'docker';
  const commandArgs = platform() === 'win32' ? ['-e', 'docker', ...args] : args;
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) fail(`${args[0]} failed: ${(result.stderr || '').trim().split('\n')[0] || result.status}`);
  const output = (result.stdout || '').trim();
  if (!secret && output.length > 10_000) fail('Unexpected Docker output length');
  return output;
}

function connectionString(user, password, database) {
  const url = new URL(`postgresql://127.0.0.1:55432/${database}`);
  url.username = user;
  url.password = password;
  return url.toString();
}

export function labRoleName(database) {
  if (!databasePattern.test(database)) fail('Invalid lab role database name');
  return `jdq_econ_lab_${database.match(/[a-f0-9]{12}/)[0]}_app`;
}

function labRolePassword(containerPassword, marker) {
  return createHmac('sha256', containerPassword).update(`economy-browser-lab:${marker}`).digest('hex');
}

async function provisionRole(pool, database, marker, containerPassword) {
  const role = labRoleName(database);
  const password = labRolePassword(containerPassword, marker);
  const exists = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (!exists.rowCount) await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  else await pool.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
  await pool.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await pool.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${role}`);
  await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await pool.query(`REVOKE ALL ON economic_accounts, economic_transactions, economic_transfers FROM ${role}`);
  await pool.query(`GRANT SELECT, INSERT ON economic_accounts TO ${role}`);
  await pool.query(`GRANT SELECT ON economic_transactions, economic_transfers TO ${role}`);
  await pool.query(`GRANT EXECUTE ON FUNCTION economic_post_transfer(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,TEXT) TO ${role}`);
  await pool.query(`GRANT EXECUTE ON FUNCTION economic_refund_cosmetic(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO ${role}`);
  const privileges = await pool.query(
    `SELECT has_table_privilege($1, 'economic_accounts', 'UPDATE') AS accounts_update,
            has_table_privilege($1, 'economic_transactions', 'INSERT') AS transactions_insert,
            has_table_privilege($1, 'economic_transfers', 'INSERT') AS transfers_insert`, [role]
  );
  if (Object.values(privileges.rows[0]).some(Boolean)) fail('Restricted lab role retained economic ledger write privileges');
  return role;
}

async function main() {
  if (platform() !== 'linux') fail('Run the fixture tool inside WSL; Windows cannot reach this Docker loopback binding');
  if (process.env.NODE_ENV === 'production') fail('Production process profile is forbidden');
  if (!['--create', '--create-benchmark', '--check', '--drop', '--provision-role'].includes(action)) {
    fail('Usage: node scripts/economy-browser-fixture.mjs --create | --create-benchmark | --check/--drop/--provision-role <database> <marker>');
  }
  if (wslDocker(['port', container, '5432']) !== expectedPort) fail('Reliability PostgreSQL is not on the expected loopback port');
  const parentDatabase = wslDocker(['exec', container, 'printenv', 'POSTGRES_DB']);
  const user = wslDocker(['exec', container, 'printenv', 'POSTGRES_USER']);
  const password = wslDocker(['exec', container, 'printenv', 'POSTGRES_PASSWORD'], { secret: true });
  if (parentDatabase !== 'jdq_reliability_test' || !user || !password) fail('Reliability container identity mismatch');

  const creating = action === '--create' || action === '--create-benchmark';
  const benchmark = action === '--create-benchmark';
  const database = creating
    ? `jdq_economy_lab_${randomUUID().replaceAll('-', '').slice(0, 12)}_dev`
    : databaseArg;
  if (!databasePattern.test(database || '')) fail('Refusing a database name outside the economy lab prefix');
  if (!creating && !/^[0-9a-f-]{36}$/i.test(markerArg || '')) fail('An exact fixture marker UUID is required');

  if (creating) {
    wslDocker(['exec', container, 'createdb', '-U', user, '-T', 'template0', database]);
    console.log(`ECONOMY_LAB_CREATED_UNSEEDED ${database}`);
  }
  const pool = new Pool({ connectionString: connectionString(user, password, database), max: 2, connectionTimeoutMillis: 3000 });
  let marker;
  try {
    if (creating) {
      const { applyMigrations, verifyMigrations, MIGRATIONS } = await import('../dist/db/migrations.js');
      const { EconomyService, SIM_ASSET } = await import('../dist/economy/service.js');
      process.env.JDQ_ENV = 'dev';
      if (MIGRATIONS.at(-1) !== '035_chain_indexer_reorg_safety.sql') fail('Source migration boundary changed; re-review fixture before use');
      await applyMigrations(pool);
      await verifyMigrations(pool);
      marker = randomUUID();
      await pool.query('CREATE TABLE economy_browser_lab_marker (id UUID PRIMARY KEY, fixture_version TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      const fixtureVersion = benchmark ? 'browser-lab-bench-v2' : 'browser-lab-v1';
      await pool.query('INSERT INTO economy_browser_lab_marker(id, fixture_version) VALUES ($1, $2)', [marker, fixtureVersion]);
      const adminId = 'lab-economy-admin';
      const authorId = 'lab-economy-author';
      const travelerId = 'lab-economy-traveler';
      const appealAdminId = 'lab-economy-appeal-admin';
      const appealTravelerId = 'lab-economy-appeal-traveler';
      const questId = 'lab-economy-reviewed-quest';
      await pool.query(`
        INSERT INTO users(id, seed_id, display_name, email, role, is_test) VALUES
        ($1, 'admin-1', 'Lab Review Admin', 'lab-admin@example.invalid', 'admin', true),
        ($2, 'lab-author', 'Lab Destination Author', 'lab-author@example.invalid', 'user', true),
        ($3, 'wallet:lab-traveler', 'Lab Traveler', 'lab-traveler@example.invalid', 'user', true),
        ($4, 'admin-2', 'Lab Appeal Reviewer', 'lab-appeal-admin@example.invalid', 'admin', true),
        ($5, 'wallet:lab-appeal', 'Lab Appeal Traveler', 'lab-appeal-traveler@example.invalid', 'user', true)
      `, [adminId, authorId, travelerId, appealAdminId, appealTravelerId]);
      if (benchmark) {
        for (let index = 1; index <= 150; index++) {
          await pool.query(
            `INSERT INTO users(id, seed_id, display_name, email, role, is_test)
             VALUES ($1, $2, 'Fictional Benchmark Traveler', $3, 'user', true)`,
            [`lab-bench-traveler-${index}`, `wallet:lab-bench-${index}`, `lab-bench-${index}@example.invalid`]
          );
        }
      }
      if (benchmark) {
        for (let index = 1; index <= 5; index++) {
          await pool.query(
            `INSERT INTO users(id, seed_id, display_name, email, role, is_test)
             VALUES ($1, $2, 'Fictional Benchmark Reviewer', $3, 'admin', true)`,
            [`lab-bench-reviewer-${index}`, `admin:lab-bench-${index}`, `lab-reviewer-${index}@example.invalid`]
          );
        }
      }
      await pool.query(`
        INSERT INTO quests(id, title, description, category, location_name, gps_lat, gps_lng,
          radius_meters, reward_points, marker_code, marker_image_url, status, is_active, author_id, is_test)
        VALUES ($1, 'Fictional economy lab checkpoint', 'Synthetic quest for local browser verification only',
          'eco', 'Fictional test venue', 16.0, 120.0, 100, 0, 'LAB_ECONOMY_MARKER',
          'https://example.invalid/lab-marker.png', 'published', true, $2, true)
      `, [questId, authorId]);
      const economy = new EconomyService(pool);
      await economy.createReviewedPilotAuthority({
        questId, scopeId: 'lab-reviewed-activity', scopeKey: 'lab-reviewed-activity',
        policyId: 'lab-policy-v1', policyKey: 'lab-policy', policyVersion: 1,
        proposedBy: authorId, reviewedBy: adminId, countryCode: 'PH',
        provinceName: 'Pangasinan', activityKind: 'visit',
        activityFingerprint: 'fictional-economy-lab-visit',
        summary: 'Fictional local browser checkpoint', rationale: 'Independent local fixture review',
        rewardMinor: 100n, reservationSeconds: 3600, appealSeconds: 3600,
      });
      const poolId = 'lab-economy-pool';
      await economy.createPilotPool({
        id: poolId, questId, scopeId: 'lab-reviewed-activity', scopeKey: 'lab-reviewed-activity',
        policyId: 'lab-policy-v1', policyVersion: 'lab-policy-v1', rewardMinor: 100n,
        allocationMinor: benchmark ? 20000n : 1200n, reservationSeconds: 3600, appealSeconds: 3600, adminId,
      });
      await economy.activatePilotPool(poolId, adminId);
      await pool.query('INSERT INTO economic_cosmetics(id, asset_code, cost_minor, active) VALUES ($1, $2, $3, true)',
        ['lab-compass-skin', SIM_ASSET, '40']);
      const appRole = await provisionRole(pool, database, marker, password);
      console.log(JSON.stringify({ database, marker, fixture_version: fixtureVersion, migration_count: MIGRATIONS.length,
        admin_seed_id: 'admin-1', appeal_admin_seed_id: 'admin-2',
        traveler_seed_id: 'wallet:lab-traveler', appeal_traveler_seed_id: 'wallet:lab-appeal', quest_id: questId,
        pool_id: poolId, cosmetic_id: 'lab-compass-skin', asset: SIM_ASSET, app_role: appRole }));
      return;
    }

    const identity = await pool.query("SELECT id::text, fixture_version FROM economy_browser_lab_marker LIMIT 2");
    if (identity.rowCount !== 1 || identity.rows[0].id !== markerArg ||
        !['browser-lab-v1', 'browser-lab-bench-v1', 'browser-lab-bench-v2'].includes(identity.rows[0].fixture_version)) {
      fail('Fixture marker does not match; no mutation performed');
    }
    marker = markerArg;
    if (action === '--provision-role') {
      console.log(JSON.stringify({ database, marker, app_role: await provisionRole(pool, database, marker, password) }));
      return;
    }
    if (action === '--check') {
      const { verifyMigrations, MIGRATIONS } = await import('../dist/db/migrations.js');
      await verifyMigrations(pool);
      const counts = await pool.query(`SELECT
        (SELECT count(*)::int FROM reward_pools WHERE id = 'lab-economy-pool') AS pools,
        (SELECT count(*)::int FROM economic_activity_scopes WHERE id = 'lab-reviewed-activity') AS scopes,
        (SELECT count(*)::int FROM economic_cosmetics WHERE id = 'lab-compass-skin') AS cosmetics`);
      const role = labRoleName(database);
      const roleCheck = await pool.query(`SELECT rolname FROM pg_roles WHERE rolname = $1`, [role]);
      if (!roleCheck.rowCount) fail('Restricted lab app role is missing');
      console.log(JSON.stringify({ database, marker, fixture_version: identity.rows[0].fixture_version,
        migration_count: MIGRATIONS.length, fixture: counts.rows[0] }));
      return;
    }
  } finally {
    await pool.end();
  }
  // The exact name and marker were verified above. No broad glob or computed directory is deleted.
  if (action === '--drop') {
    const role = labRoleName(database);
    const roleExists = wslDocker(['exec', container, 'psql', '-U', user, '-d', parentDatabase,
      '-Atc', `SELECT 1 FROM pg_roles WHERE rolname = '${role}'`]);
    wslDocker(['exec', container, 'dropdb', '-U', user, database]);
    if (roleExists === '1') {
      wslDocker(['exec', container, 'psql', '-U', user, '-d', parentDatabase, '-v', 'ON_ERROR_STOP=1', '-c', `DROP ROLE ${role}`]);
    }
    console.log(JSON.stringify({ dropped_disposable_database: database, marker }));
  }
}

main().catch((error) => fail(error instanceof Error ? error.message.split('\n')[0] : 'Unknown fixture error'));
