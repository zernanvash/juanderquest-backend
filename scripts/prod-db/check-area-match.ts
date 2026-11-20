// Plan 116: smoke-check resolveSpotAreas against a database with loaded admin areas.
// Usage: CHECK_DB_URL=postgres://... npx tsx scripts/prod-db/check-area-match.ts
import { Pool } from 'pg';
import { resolveSpotAreas } from '../../src/maps/areas-service.js';

const points: Array<[string, number, number]> = [
  ['Laoag City (Ilocos Norte)', 18.1977, 120.5936],
  ['Vigan City (Ilocos Sur)', 17.5747, 120.3869],
  ['San Fernando (La Union)', 16.6159, 120.3166],
  ['Dagupan City (Pangasinan)', 16.0433, 120.3333],
  ['Hundred Islands, offshore (Alaminos)', 16.2006, 119.9874],
  ['Manila (outside Region I)', 14.5995, 120.9842],
];

const url = process.env.CHECK_DB_URL;
if (!url || !/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):/.test(url)) {
  console.error('CHECK_DB_URL must be a loopback PostgreSQL URL');
  process.exit(1);
}
const pool = new Pool({ connectionString: url, options: '-c search_path=public,extensions' });
(async () => {
  for (const [label, lat, lng] of points) {
    const t0 = performance.now();
    const m = await resolveSpotAreas(pool, lat, lng);
    const ms = (performance.now() - t0).toFixed(1);
    console.log(`${label.padEnd(38)} town=${m.townAreaId} bgy=${m.barangayAreaId} prov=${m.provinceAreaId} region=${m.regionAreaId} (${ms} ms)`);
  }
  await pool.end();
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
