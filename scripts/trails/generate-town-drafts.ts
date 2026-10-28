// Plan 64: premade trails for every town, generated as drafts (pending_review) for the owner to
// approve in Trail Studio (D5). Per town: a free Starter trail inside the town and a premium
// "Hiyas Trail" (Signature tier) reaching nearby towns. Template stories only: no NIM call here.
// Idempotent: each town/tier is keyed (trail_generations.input.candidate_key) and skipped on reruns.
//
//   DATABASE_URL=... npx tsx scripts/trails/generate-town-drafts.ts [--dry-run] [--limit N] [--province Pangasinan]
import { Pool } from 'pg';
import { generateTrail, TrailGenerationError } from '../../src/trails/generate.js';
import { templateStoryWriter } from '../../src/trails/ai/service.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const DRY = flag('--dry-run');
const LIMIT = Number(value('--limit', '0'));
const PROVINCE = value('--province', 'Pangasinan');

const WORD: Record<string, string> = {
  nature_outdoors: 'Nature', culture_heritage: 'Heritage', eat_drink: 'Food', activities_wellness: 'Leisure', shopping_local: 'Market', stay: 'Stay',
};
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const towns = (await pool.query(`SELECT municipality, COUNT(*)::int AS spots,
      AVG(gps_lat) AS lat, AVG(gps_lng) AS lng,
      MODE() WITHIN GROUP (ORDER BY category) AS top_category
    FROM spots WHERE status='published' AND NOT is_test AND gps_lat IS NOT NULL AND address ILIKE $1
    GROUP BY municipality HAVING COUNT(*) >= 3 ORDER BY COUNT(*) DESC, municipality`, [`%${PROVINCE}%`])).rows;
  const work = LIMIT ? towns.slice(0, LIMIT) : towns;
  console.log(`${PROVINCE}: ${towns.length} towns with >= 3 published spots; processing ${work.length}${DRY ? ' (dry run)' : ''}`);
  const done = new Set((await pool.query(`SELECT input->>'candidate_key' AS k FROM trail_generations WHERE input->>'candidate_key' LIKE 'town-draft:%'`)).rows.map((r) => r.k));
  let created = 0, skipped = 0, failed = 0;

  for (const town of work) {
    const plans = [
      { tier: 'starter' as const, key: `town-draft:${town.municipality}:starter`, input: {
        allowedMunicipalities: [town.municipality], budgetMin: 240, minStops: Math.min(3, town.spots), maxStops: 4, maxLegMin: 45 } },
      { tier: 'signature' as const, key: `town-draft:${town.municipality}:signature`, input: {
        startNode: { lat: Number(town.lat), lng: Number(town.lng) }, budgetMin: 420, minStops: 4, maxStops: 6, maxLegMin: 60 } },
    ];
    for (const plan of plans) {
      if (done.has(plan.key)) { skipped++; continue; }
      if (DRY) { console.log(`  would draft ${plan.tier} for ${town.municipality} (${town.spots} spots)`); continue; }
      try {
        const result: any = await generateTrail(pool, {
          kind: 'admin', tier: plan.tier, status: 'pending_review', theme: WORD[town.top_category] ?? 'local',
          candidateKey: plan.key, maxPerCategory: 2, ...plan.input,
        }, { storyWriter: templateStoryWriter });
        const id = result.trail.id as string;
        const stops = (await pool.query(`SELECT p.municipality, p.category FROM trail_stops s JOIN spots p ON p.id=s.spot_id WHERE s.trail_id=$1 ORDER BY s.position`, [id])).rows;
        const cats = [...new Set(stops.map((s) => WORD[s.category]).filter(Boolean))].slice(0, 2);
        const others = [...new Set(stops.map((s) => s.municipality).filter((m) => m !== town.municipality))].slice(0, 1);
        const title = plan.tier === 'starter'
          ? `${titleCase(town.municipality)} ${cats.join(' & ') || 'Discovery'} Trail`
          : `${[town.municipality, ...others].map(titleCase).join(' – ')} Hiyas Trail`;
        const hours = Math.max(1, Math.round(Number(result.trail.total_minutes) / 60));
        const tagline = `${stops.length} stops · about ${hours} h${plan.tier === 'signature' ? ' · hand-picked gems' : ''}`;
        await pool.query(`UPDATE trails SET title=$2, tagline=$3, story = story || jsonb_build_object('title', $2::text, 'tagline', $3::text) WHERE id=$1`, [id, title.slice(0, 80), tagline]);
        console.log(`  drafted ${plan.tier}: ${title} (${stops.length} stops, ${result.trail.total_minutes} min)`);
        created++;
      } catch (error) {
        failed++;
        console.log(`  skipped ${plan.tier} for ${town.municipality}: ${error instanceof TrailGenerationError ? error.code : (error as Error).message}`);
      }
    }
  }
  console.log(`drafted ${created}; already drafted ${skipped}; not feasible ${failed}. Review them in Trail Studio (pending review).`);
  await pool.end();
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
