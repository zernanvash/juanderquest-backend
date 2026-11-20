// Plan 116 destinations: make the destinations work DB (jdq_r_dest only) look like the launch DB for testing:
//   1. Pangasinan admin areas from the old-production copy (rows + geom built from the stored boundary JSON),
//   2. the 90 existing spots from the old copy (they win every conflict in the importer).
// Existing rows are never changed (ON CONFLICT DO NOTHING). User / quest FKs that the work DB lacks are nulled.
// Usage (WSL): source ~/.jdq-secrets/workdb-jdq_r_dest.env + old-copy.env, then
//   WORK_URL="$WORKDB_OWNER_URL" OLD_URL="$OLD_COPY_READONLY_URL" npx tsx scripts/seed/destinations/prepare-workdb.ts [--apply]

import { Client } from 'pg';
import { flag } from './lib/io.js';

const GENERATED = new Set(['geog', 'search_tsv']);

async function columns(c: Client, table: string): Promise<string[]> {
  const { rows } = await c.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((r) => r.column_name as string);
}

async function main() {
  const workUrl = process.env.WORK_URL;
  const oldUrl = process.env.OLD_URL;
  if (!workUrl || !oldUrl) throw new Error('set WORK_URL and OLD_URL');
  if (new URL(workUrl).pathname !== '/jdq_r_dest') throw new Error('WORK_URL must point at jdq_r_dest');
  if (new URL(oldUrl).pathname !== '/jdq_old_copy') throw new Error('OLD_URL must point at jdq_old_copy');
  const apply = flag('--apply');
  const work = new Client({ connectionString: workUrl });
  const old = new Client({ connectionString: oldUrl });
  await work.connect();
  await old.connect();
  try {
    const areaCols = (await columns(old, 'admin_areas')).filter((c) => c !== 'geom');
    const areas = (
      await old.query(
        `SELECT ${areaCols.map((c) => `"${c}"`).join(', ')} FROM admin_areas
          ORDER BY CASE level WHEN 'region' THEN 0 WHEN 'province' THEN 1 WHEN 'town' THEN 2 ELSE 3 END, id`,
      )
    ).rows;
    const workSpotCols = new Set(await columns(work, 'spots'));
    const spotCols = (await columns(old, 'spots')).filter((c) => workSpotCols.has(c) && !GENERATED.has(c));
    const spots = (await old.query(`SELECT ${spotCols.map((c) => `"${c}"`).join(', ')} FROM spots ORDER BY id`)).rows;

    await work.query('BEGIN');
    const a = await work.query(
      `INSERT INTO admin_areas (${areaCols.map((c) => `"${c}"`).join(', ')})
       SELECT ${areaCols.map((c) => `x."${c}"`).join(', ')} FROM jsonb_populate_recordset(NULL::admin_areas, $1::jsonb) x
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(areas)],
    );
    const g = await work.query(
      `UPDATE admin_areas SET geom = ST_Multi(ST_CollectionExtract(ST_MakeValid(
              ST_SetSRID(ST_GeomFromGeoJSON(boundary::text), 4326)), 3))
        WHERE boundary IS NOT NULL AND geom IS NULL`,
    );
    const s = await work.query(
      `INSERT INTO spots (${spotCols.map((c) => `"${c}"`).join(', ')})
       SELECT ${spotCols
         .map((c) =>
           c === 'quest_id'
             ? `CASE WHEN EXISTS (SELECT 1 FROM quests q WHERE q.id = x.quest_id) THEN x.quest_id END`
             : c === 'created_by' || c === 'reviewed_by'
               ? `CASE WHEN EXISTS (SELECT 1 FROM users u WHERE u.id = x."${c}") THEN x."${c}" END`
               : `x."${c}"`,
         )
         .join(', ')}
         FROM jsonb_populate_recordset(NULL::spots, $1::jsonb) x
       ON CONFLICT DO NOTHING`,
      [JSON.stringify(spots)],
    );
    const counts = (
      await work.query(
        `SELECT (SELECT count(*) FROM admin_areas)::int areas, (SELECT count(*) FROM admin_areas WHERE geom IS NOT NULL)::int with_geom,
                (SELECT count(*) FROM spots)::int spots`,
      )
    ).rows[0];
    console.log(
      `[prepare] areas +${a.rowCount} (geom built ${g.rowCount}), spots +${s.rowCount}; now`,
      counts,
      apply ? 'COMMIT' : 'ROLLBACK (dry-run)',
    );
    await work.query(apply ? 'COMMIT' : 'ROLLBACK');
  } catch (e) {
    await work.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await work.end();
    await old.end();
  }
}

main().catch((e) => {
  console.error(`[prepare] failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
