// Plan 116 §8.1: extract → normalise → enrich → dedupe (within import) → confidence → tier.
// Reads the reused inputs plus enrichment.json (run enrich-wikidata.ts first) and writes
// ~/jdq-seed/national-116/destinations/catalogue.jsonl + catalogue-stats.json. No DB access.
// Usage (WSL): npx tsx scripts/seed/destinations/build-catalogue.ts

import { buildCatalogue } from './lib/catalogue.js';
import { paths, readJson, writeJson, writeJsonl } from './lib/io.js';
import { confidenceBucket } from './lib/score.js';
import { loadSources } from './lib/sources.js';
import type { Enrichment } from './enrich-wikidata.js';

async function main() {
  const started = Date.now();
  const enrichment = readJson<Enrichment>(paths.enrichment);
  const { records, skipped } = await loadSources();
  const { rows, stats } = buildCatalogue(records, enrichment);
  writeJsonl(paths.catalogue, rows);

  const count = (f: (r: (typeof rows)[number]) => string) =>
    rows.reduce<Record<string, number>>((acc, r) => ((acc[f(r)] = (acc[f(r)] ?? 0) + 1), acc), {});
  const summary = {
    generated_at: new Date().toISOString(),
    skipped_inputs: skipped,
    ...stats,
    by_category: count((r) => `${r.category}/${r.subcategory}`),
    confidence_histogram: count((r) => confidenceBucket(r.confidence)),
    computed_tiers: count((r) => r.computed_tier),
    tiers_by_island_group: count((r) => `${r.hints.island_group}:${r.computed_tier}`),
    standard_not_featured_reasons: rows
      .filter((r) => r.computed_tier === 'standard')
      .flatMap((r) => r.tier_reasons)
      .reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {}),
    with_description: count((r) => String((r.field_sources.description as { source?: string })?.source ?? 'none')),
    with_usable_photo: rows.filter((r) => r.photo_candidates.some((p) => p.usable)).length,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  writeJson(paths.catalogueStats, summary);
  console.log(JSON.stringify(summary, null, 1));
}

main().catch((e) => {
  console.error(`[catalogue] failed: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
