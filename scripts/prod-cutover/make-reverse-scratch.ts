// Plan 116 §11 step 8 rehearsal aid: build a scratch schema shaped like the OLD database's
// account tables (columns, types, defaults, NOT NULL, PK/unique keys, FKs among them), inside
// a rehearsal work DB, so reverse-carry.ts can be exercised without touching jdq_old_copy.
//   SHAPE_SOURCE_URL=<old copy, read-only> SCRATCH_TARGET_URL=<jdq_r_* owner url> \
//     npx tsx scripts/prod-cutover/make-reverse-scratch.ts --schema reverse_scratch [--replace]
import type { Client } from 'pg';
import { connect, currentDatabase, quoteIdent as q } from './lib/db.js';
import { introspect } from './lib/introspect.js';
import { REVERSE_ALLOWED_TABLES } from './reverse-carry.js';

export async function buildScratchSchema(
  shape: Client,
  target: Client,
  schema: string,
  replace: boolean,
  shapeSchema = 'public',
) {
  if (!/^reverse_scratch[a-z0-9_]*$/.test(schema)) throw new Error('schema must start with reverse_scratch');
  const info = await introspect(shape, shapeSchema);
  const defaults = await shape.query(
    `SELECT c.relname AS tbl, a.attname AS col, pg_get_expr(d.adbin, d.adrelid) AS expr
       FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE n.nspname = $2 AND c.relname = ANY($1::text[])`,
    [REVERSE_ALLOWED_TABLES, shapeSchema],
  );
  const def = new Map(defaults.rows.map((r) => [`${r.tbl}.${r.col}`, String(r.expr)]));
  await target.query('BEGIN');
  try {
    if (replace) await target.query(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
    await target.query(`CREATE SCHEMA ${q(schema)}`);
    for (const name of REVERSE_ALLOWED_TABLES) {
      const t = info.tables.get(name);
      if (!t) continue; // not every deployment has every account table
      const cols = t.columns.map((c) => {
        const d = def.get(`${name}.${c.name}`);
        return `${q(c.name)} ${c.type}${d ? ` DEFAULT ${d}` : ''}${c.notNull ? ' NOT NULL' : ''}`;
      });
      cols.push(`PRIMARY KEY (${t.primaryKey.map(q).join(', ')})`);
      for (const u of t.uniqueKeys) cols.push(`UNIQUE (${u.map(q).join(', ')})`);
      for (const fk of t.foreignKeys) {
        if (!REVERSE_ALLOWED_TABLES.includes(fk.refTable)) continue; // e.g. users.favorite_spot_id -> spots
        cols.push(
          `FOREIGN KEY (${fk.columns.map(q).join(', ')}) REFERENCES ${q(schema)}.${q(fk.refTable)} (${fk.refColumns
            .map(q)
            .join(', ')})`,
        );
      }
      await target.query(`CREATE TABLE ${q(schema)}.${q(name)} (\n  ${cols.join(',\n  ')}\n)`);
    }
    await target.query('COMMIT');
  } catch (e) {
    await target.query('ROLLBACK');
    throw e;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const schema = argv[argv.indexOf('--schema') + 1];
  if (!argv.includes('--schema') || !schema) throw new Error('--schema reverse_scratch… is required');
  const shapeUrl = process.env.SHAPE_SOURCE_URL;
  const targetUrl = process.env.SCRATCH_TARGET_URL;
  if (!shapeUrl || !targetUrl) throw new Error('Set SHAPE_SOURCE_URL and SCRATCH_TARGET_URL.');
  const shape = await connect(shapeUrl, 'jdq-reverse-scratch-shape');
  const target = await connect(targetUrl, 'jdq-reverse-scratch');
  try {
    await shape.query('SET default_transaction_read_only = on');
    const db = await currentDatabase(target);
    if (!/^jdq_r_[a-z0-9_]+$/.test(db)) throw new Error(`scratch schemas go only into rehearsal work DBs (got ${db})`);
    await buildScratchSchema(shape, target, schema, argv.includes('--replace'));
    console.log(`[scratch] ${db}.${schema}: ${REVERSE_ALLOWED_TABLES.length} account tables in the old-DB shape`);
  } finally {
    await shape.end();
    await target.end();
  }
}

if (require.main === module)
  main().catch((e) => {
    console.error(`[scratch] failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
