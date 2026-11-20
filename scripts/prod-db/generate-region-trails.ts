// Plan 116: generate engine trails for a launch region's provinces with the production trail
// engine (same path as POST /admin/trails/generate). Trails are saved as pending_review: an admin
// approves them before anyone sees them. Routing comes from VALHALLA_URL (use the PH graph).
// A theme is generated only where the province has >= MIN_PER_THEME published spots of that
// category, and a trail whose stops repeat an existing trail's is deleted again.
//   NODE_ENV=test DATABASE_URL=<owner url> VALHALLA_URL=http://127.0.0.1:8003 \
//     node node_modules/tsx/dist/cli.mjs scripts/prod-db/generate-region-trails.ts ilocos-norte ilocos-sur la-union
// (NODE_ENV=test only satisfies src/config/env.ts local-safety checks, as in check-carried.ts.)
import pg from 'pg';
import { generateTrail, TrailGenerationError } from '../../src/trails/generate.js';

// theme = title word; category = spots.category the engine's fit signal matches on.
const THEMES = [
  { theme: 'heritage', category: 'culture_heritage' },
  { theme: 'nature', category: 'nature_outdoors' },
  { theme: 'food', category: 'eat_drink' },
] as const;
const MIN_PER_THEME = 3;

const areas = process.argv.slice(2);
if (!areas.length) {
  console.error('usage: generate-region-trails.ts <province-area-id>...');
  process.exit(2);
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const counts = await pool.query(
    `SELECT province_area_id AS area, category, count(*)::int AS n FROM spots
      WHERE status='published' AND NOT coalesce(is_test,false) AND province_area_id = ANY($1)
      GROUP BY 1, 2`,
    [areas],
  );
  const have = new Map(counts.rows.map((r) => [`${r.area}|${r.category}`, r.n as number]));
  let made = 0;
  let skipped = 0;
  for (const areaId of areas) {
    for (const [i, t] of THEMES.entries()) {
      const n = have.get(`${areaId}|${t.category}`) ?? 0;
      if (n < MIN_PER_THEME) {
        console.log(`SKIP ${areaId} ${t.theme}: only ${n} published ${t.category} spots`);
        skipped++;
        continue;
      }
      try {
        const r: any = await generateTrail(pool, {
          kind: 'admin',
          areaId,
          theme: t.theme,
          constraints: { themes: [t.category] },
          tier: 'explorer',
          budgetMin: 360,
          minStops: 3,
          maxStops: 6,
          costing: 'auto',
          seed: 116_000 + i,
          status: 'pending_review',
        });
        const id = String(r.trail?.id ?? r.id ?? r.trailId);
        // Same stop set as another trail? Then it adds nothing: remove it.
        const dup = await pool.query(
          `WITH me AS (SELECT array_agg(spot_id ORDER BY spot_id) a FROM trail_stops WHERE trail_id=$1)
           SELECT o.trail_id FROM trail_stops o JOIN trails ot ON ot.id=o.trail_id
            WHERE o.trail_id<>$1 AND ot.status IN ('published','pending_review')
            GROUP BY o.trail_id HAVING array_agg(o.spot_id ORDER BY o.spot_id)=(SELECT a FROM me) LIMIT 1`,
          [id],
        );
        if (dup.rowCount) {
          await pool.query(`DELETE FROM trail_stops WHERE trail_id=$1`, [id]);
          await pool.query(`DELETE FROM trails WHERE id=$1`, [id]);
          console.log(`DUP  ${areaId} ${t.theme}: same stops as ${dup.rows[0].trail_id}; removed`);
          skipped++;
          continue;
        }
        made++;
        const s = await pool.query(
          `SELECT t.slug, t.title, count(*)::int AS n FROM trails t JOIN trail_stops st ON st.trail_id=t.id
            WHERE t.id=$1 GROUP BY 1, 2`,
          [id],
        );
        console.log(`OK   ${areaId} ${t.theme}: ${s.rows[0]?.slug} — ${s.rows[0]?.title} (${s.rows[0]?.n} stops)`);
      } catch (e) {
        skipped++;
        const code = e instanceof TrailGenerationError ? e.code : (e as Error).message;
        console.log(`FAIL ${areaId} ${t.theme}: ${code}`);
      }
    }
  }
  console.log(`generated ${made}, skipped ${skipped}`);
  await pool.end();
}
void main();
