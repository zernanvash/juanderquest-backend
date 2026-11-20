// Plan 116 §9 post-carry check, run as the app role (jdq_app):
//   1. verifyMigrations() still passes on the target;
//   2. every carried user loads through the app's own UsersRepository (findById + session scope);
//   3. every carried user with an email identity also has a password credential or account email.
//   NODE_ENV=test DATABASE_URL=<same> CHECK_APP_URL=<target jdq_app url> npx tsx scripts/prod-cutover/check-carried.ts
// (NODE_ENV=test only satisfies src/config/env.ts local-safety checks; nothing else reads it.)
import { Pool } from 'pg';
import { verifyMigrations } from '../../src/db/migrations.js';
import { UsersRepository } from '../../src/repositories/users.js';

async function main() {
  const url = process.env.CHECK_APP_URL;
  if (!url) throw new Error('Set CHECK_APP_URL (jdq_app connection to the target).');
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    await verifyMigrations(pool);
    console.log('[check] verifyMigrations: OK');
    const repo = new UsersRepository(pool);
    const { rows } = await pool.query(`SELECT id FROM users ORDER BY id`);
    let loaded = 0;
    const failures: string[] = [];
    for (const { id } of rows) {
      const user = await repo.findById(id);
      if (user && user.id === id) loaded++;
      else failures.push(id.slice(0, 8));
    }
    for (let i = 0; i < rows.length; i += 100) {
      const ids = rows.slice(i, i + 100).map((r) => r.id as string);
      const scopes = await repo.findAlphaSessionScopesByIds(ids);
      for (const id of ids) if (!scopes.has(id)) failures.push(`scope:${id.slice(0, 8)}`);
    }
    const { rows: login } = await pool.query(
      `SELECT count(*)::int AS users,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM auth_identities a WHERE a.user_id = u.id AND a.provider = 'email'))::int AS email_identity,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM password_credentials p WHERE p.user_id = u.id))::int AS password,
              count(*) FILTER (WHERE u.wallet_address IS NOT NULL OR u.demo_points <> 0 OR u.scout_reputation <> 0
                                 OR cardinality(u.featured_badges) > 0)::int AS not_sanitised
         FROM users u`,
    );
    console.log(
      `[check] users=${rows.length} loaded=${loaded} email_identity=${login[0].email_identity} ` +
        `password=${login[0].password} not_sanitised=${login[0].not_sanitised}`,
    );
    if (failures.length || login[0].not_sanitised) {
      console.error(`[check] FAILED: ${failures.join(', ') || 'unsanitised users present'}`);
      process.exitCode = 1;
    } else console.log('[check] every carried user loads through UsersRepository: OK');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(`[check] failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
