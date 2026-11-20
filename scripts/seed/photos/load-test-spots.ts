// Loads a realistic spot set into the photo agent's WORK database (jdq_r_photos) so writes to
// spot_assets are exercised: the 90 spots of the old-production copy (read-only source) plus
// minimal rows for every beta-national item (Wikidata + OSM), keyed by external_refs.
// The 90 get external_refs by matching them to beta/OSM items (distinctive name + ≤ 500 m).
// Work DB only — never run against a production or shared database. Dry-run by default.
//
//   DATABASE_URL=<work db owner> OLD_COPY_URL=<old copy read-only> \
//     npx tsx scripts/seed/photos/load-test-spots.ts [--apply]
import fs from 'fs';
import { Pool } from 'pg';
import { OSM_CANDIDATES, SEED_DESTINATIONS, SEED_OSM_DESTINATIONS } from './config.js';
import { distinctiveTokens, fold } from './names.js';
import { osmKeyToRef } from './seed-index.js';
import { haversineM } from './select.js';

const APPLY = process.argv.includes('--apply');

interface Item {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category: string;
  subcategory: string;
  municipality: string;
  province: string;
  refs: { wikidata?: string; osm?: string };
}

/**
 * Same place: identical folded names within 10 km (big parks are pinned at their access point),
 * or every distinctive token of the shorter name in the other within 500 m.
 */
export function samePlace(
  a: { name: string; lat: number; lng: number },
  b: { name: string; lat: number; lng: number },
): boolean {
  const d = haversineM(a.lat, a.lng, b.lat, b.lng);
  if (fold(a.name) === fold(b.name) && d <= 10_000) return true;
  if (d > 500) return false;
  const ta = distinctiveTokens(a.name);
  const tb = distinctiveTokens(b.name);
  // Type words ("falls", "lighthouse", "church") must overlap when both names have them.
  const typeWords = (n: string, d: string[]) =>
    fold(n)
      .split(' ')
      .filter((w) => w.length >= 3 && !d.includes(w));
  const ga = typeWords(a.name, ta);
  const gb = typeWords(b.name, tb);
  if (ga.length && gb.length && !ga.some((w) => gb.includes(w))) return false;
  const [short, long] = ta.length <= tb.length ? [ta, fold(b.name).split(' ')] : [tb, fold(a.name).split(' ')];
  return short.length > 0 && short.every((t) => long.includes(t));
}

function loadItems(): Item[] {
  const items: Item[] = [];
  const d = JSON.parse(fs.readFileSync(SEED_DESTINATIONS, 'utf8')).items as Array<Record<string, string & number>>;
  for (const it of d)
    items.push({
      id: `p116t-${it.qid}`,
      name: it.name,
      lat: it.lat,
      lng: it.lng,
      category: it.category ?? 'nature_outdoors',
      subcategory: it.subcategory ?? '',
      municipality: it.municipality ?? '',
      province: it.province ?? '',
      refs: { wikidata: it.qid },
    });
  const o = JSON.parse(fs.readFileSync(SEED_OSM_DESTINATIONS, 'utf8')).items as Array<Record<string, string & number>>;
  for (const it of o) {
    const osm = osmKeyToRef(it.key);
    if (!osm) continue;
    items.push({
      id: `p116t-${it.key}`,
      name: it.name,
      lat: it.lat,
      lng: it.lng,
      category: it.category ?? 'nature_outdoors',
      subcategory: it.subcategory ?? '',
      municipality: it.municipality ?? '',
      province: it.province ?? '',
      refs: { osm },
    });
  }
  return items;
}

/** OSM refs for Wikidata items (from osm-candidates.jsonl) and Pangasinan OSM rows for matching. */
function loadOsm(): Array<{ name: string; lat: number; lng: number; refs: { osm?: string; wikidata?: string } }> {
  return fs
    .readFileSync(OSM_CANDIDATES, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((o) => ({ name: o.name, lat: o.gps_lat, lng: o.gps_lng, refs: o.external_refs }));
}

async function main() {
  if (!process.env.DATABASE_URL || !process.env.OLD_COPY_URL) throw new Error('DATABASE_URL and OLD_COPY_URL required');
  const work = new Pool({ connectionString: process.env.DATABASE_URL });
  const old = new Pool({ connectionString: process.env.OLD_COPY_URL });
  const dbName = (await work.query<{ d: string }>('SELECT current_database() AS d')).rows[0].d;
  if (!/^jdq_r_photos$/.test(dbName)) throw new Error(`refusing to load test spots into ${dbName}`);

  const items = loadItems();
  const osm = loadOsm();
  const osmByQid = new Map(
    osm.filter((o) => o.refs.wikidata && o.refs.osm).map((o) => [o.refs.wikidata!, o.refs.osm!]),
  );
  for (const it of items)
    if (it.refs.wikidata && osmByQid.has(it.refs.wikidata)) it.refs.osm = osmByQid.get(it.refs.wikidata);

  const oldSpots = (await old.query(`SELECT * FROM spots ORDER BY id`)).rows;
  const workCols = new Set(
    (
      await work.query<{ c: string }>(
        `SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'spots'`,
      )
    ).rows.map((r) => r.c),
  );
  const usedRefs = new Set<string>();
  for (const r of (
    await work.query<{ w: string | null; o: string | null }>(
      `SELECT external_refs->>'wikidata' w, external_refs->>'osm' o FROM spots`,
    )
  ).rows) {
    if (r.w) usedRefs.add(`wikidata:${r.w}`);
    if (r.o) usedRefs.add(`osm:${r.o}`);
  }
  const claim = (refs: { wikidata?: string; osm?: string }) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(refs)) if (v && !usedRefs.has(`${k}:${v}`)) out[k] = v;
    for (const [k, v] of Object.entries(out)) usedRefs.add(`${k}:${v}`);
    return out;
  };

  const stats = {
    old_inserted: 0,
    old_existing: 0,
    old_refs_set: 0,
    items_inserted: 0,
    items_skipped_same_place: 0,
    items_existing: 0,
  };
  const client = await work.connect();
  try {
    await client.query('BEGIN');
    const matchedItemIds = new Set<string>();
    for (const s of oldSpots) {
      const cols = Object.keys(s).filter((c) => workCols.has(c));
      const row: Record<string, unknown> = { ...s };
      for (const fk of ['quest_id', 'created_by', 'reviewed_by', 'town_area_id', 'barangay_area_id']) row[fk] = null;
      const ins = await client.query(
        `INSERT INTO spots (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT (id) DO NOTHING`,
        cols.map((c) =>
          typeof row[c] === 'object' && row[c] !== null && !(row[c] instanceof Date) ? JSON.stringify(row[c]) : row[c],
        ),
      );
      if (ins.rowCount) stats.old_inserted++;
      else stats.old_existing++;
      const me = { name: s.name, lat: Number(s.gps_lat), lng: Number(s.gps_lng) };
      const hit = items.find((it) => samePlace(me, it)) ?? null;
      const osmHit = osm.find((o) => o.refs.osm && samePlace(me, o));
      const refs = { wikidata: hit?.refs.wikidata ?? osmHit?.refs.wikidata, osm: hit?.refs.osm ?? osmHit?.refs.osm };
      if (hit) matchedItemIds.add(hit.id);
      const cur =
        (await client.query(`SELECT external_refs FROM spots WHERE id = $1`, [s.id])).rows[0]?.external_refs ?? {};
      if (!cur.wikidata && !cur.osm) {
        // A minimal test row loaded earlier for the same place gives its refs to the real spot.
        if (hit) {
          const del = await client.query(
            `DELETE FROM spots WHERE id = $1 AND source_name = 'Plan 116 photo test row'
               AND NOT EXISTS (SELECT 1 FROM spot_assets WHERE spot_id = $1)
             RETURNING external_refs`,
            [hit.id],
          );
          for (const r of del.rows)
            for (const [k, v] of Object.entries(r.external_refs as Record<string, string>))
              usedRefs.delete(`${k}:${v}`);
        }
        const got = claim(refs);
        if (Object.keys(got).length) {
          await client.query(`UPDATE spots SET external_refs = external_refs || $2::jsonb WHERE id = $1`, [
            s.id,
            JSON.stringify(got),
          ]);
          stats.old_refs_set++;
        }
      }
    }
    for (const it of items) {
      if (matchedItemIds.has(it.id)) {
        stats.items_skipped_same_place++;
        continue;
      }
      const exists = await client.query(`SELECT 1 FROM spots WHERE id = $1`, [it.id]);
      if (exists.rowCount) {
        stats.items_existing++;
        continue;
      }
      const refs = claim(it.refs);
      if (!Object.keys(refs).length) {
        stats.items_skipped_same_place++;
        continue;
      }
      await client.query(
        `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng,
           source_type, source_name, trust_level, status, external_refs)
         VALUES ($1::text, $1::varchar, $2, '', $3, $4, $5, $6, $7, $8, 'open_data', 'Plan 116 photo test row', 'open_data', 'needs_review', $9::jsonb)`,
        [
          it.id,
          it.name,
          it.category,
          it.subcategory,
          it.municipality,
          it.province,
          it.lat,
          it.lng,
          JSON.stringify(refs),
        ],
      );
      stats.items_inserted++;
    }
    await client.query(APPLY ? 'COMMIT' : 'ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  console.log(
    JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', db: dbName, items: items.length, ...stats }, null, 2),
  );
  await work.end();
  await old.end();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
