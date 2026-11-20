// Plan 116 §9: dump the catalog shape + row counts of the carry source and target to
// JSON (no row data), to build and review carry-manifest.json.
//   CARRY_SOURCE_URL=… CARRY_TARGET_URL=… npx tsx scripts/prod-cutover/inspect-schema.ts --out <dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, describeUrl } from './lib/db.js';
import { introspect, rowCounts } from './lib/introspect.js';

async function dump(url: string, label: string) {
  const client = await connect(url, `jdq-carry-inspect-${label}`);
  try {
    await client.query('BEGIN READ ONLY');
    const schema = await introspect(client);
    const counts = await rowCounts(client, schema.tables.keys());
    await client.query('COMMIT');
    return {
      db: describeUrl(url).replace(/^[^@]*@/, ''),
      tables: Object.fromEntries(
        [...schema.tables.values()].map((t) => [t.name, { ...t, rows: counts.get(t.name) ?? 0 }]),
      ),
      sequences: schema.sequences,
    };
  } finally {
    await client.end();
  }
}

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const out = outIdx > 0 ? process.argv[outIdx + 1] : '.';
  const source = process.env.CARRY_SOURCE_URL;
  const target = process.env.CARRY_TARGET_URL;
  if (!source || !target) throw new Error('Set CARRY_SOURCE_URL and CARRY_TARGET_URL.');
  mkdirSync(out, { recursive: true });
  for (const [label, url] of [
    ['source', source],
    ['target', target],
  ] as const) {
    const d = await dump(url, label);
    writeFileSync(join(out, `schema-${label}.json`), JSON.stringify(d, null, 2));
    console.log(`[inspect] ${label}: ${Object.keys(d.tables).length} tables, ${d.sequences.length} sequences`);
  }
}

main().catch((e) => {
  console.error(`[inspect] failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
