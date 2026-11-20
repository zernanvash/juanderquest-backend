// Licence backfill for the existing Pangasinan Commons photos (migrations 038–040): the live
// spots keep them in spots.image_url (a local catalog-*.jpg) with the credit in source_name and
// the Commons file page in source_url. Reads the old-production copy (read-only), looks each file
// up in the Commons API and writes a mapping spot id → file → normalised licence/author for the
// orchestrator to create proper spot_assets rows. Writes report files only (no DB writes).
//
//   OLD_COPY_URL=<read-only> npx tsx scripts/seed/photos/backfill-pangasinan.ts
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { HTTP_CACHE, REPORTS_DIR } from './config.js';
import { normaliseLicence } from './licence.js';
import { metadataRejection } from './quality.js';
import { commonsClient, normaliseFileTitle, pageToCandidate } from './sources/commons.js';

/** "Photo: Ralff Nestor Nacor · CC BY-SA 4.0" → { author, licence } */
export function parseCredit(sourceName: string): { author: string | null; license: string | null } {
  const m = /^Photo:\s*(.+?)\s*[·|]\s*(.+)$/.exec(sourceName.trim());
  if (!m) return { author: null, license: null };
  const lic = normaliseLicence(m[2]);
  return { author: m[1].replace(/^User:/i, '').trim(), license: lic.ok ? lic.license : null };
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  if (!process.env.OLD_COPY_URL) throw new Error('OLD_COPY_URL required');
  const db = new Pool({ connectionString: process.env.OLD_COPY_URL });
  const rows = (
    await db.query<{
      id: string;
      slug: string;
      name: string;
      image_url: string;
      source_name: string;
      source_url: string;
    }>(
      `SELECT id, slug, name, image_url, source_name, source_url FROM spots
        WHERE source_url ILIKE 'https://commons.wikimedia.org/wiki/File:%' ORDER BY id`,
    )
  ).rows;
  await db.end();
  const titles = rows.map((r) => normaliseFileTitle(r.source_url)).filter((t): t is string => !!t);
  const info = await commonsClient(HTTP_CACHE).imageInfo(titles);
  const out = rows.map((r) => {
    const title = normaliseFileTitle(r.source_url);
    const page = title ? info.get(title) : undefined;
    const c = page ? pageToCandidate(page, 'wikidata_p18', null) : null;
    const credit = parseCredit(r.source_name);
    const problems: string[] = [];
    if (!c) problems.push('file_not_found_on_commons');
    else {
      if (c.rejected || !c.license) problems.push(`licence:${c.rejected ?? c.license_raw}`);
      if (!c.author) problems.push('no_author');
      if (credit.license && c.license && credit.license !== c.license)
        problems.push(`credit_licence_differs:${credit.license}`);
      const q = metadataRejection(c);
      if (q && !problems.length) problems.push(`quality:${q}`);
    }
    return {
      spot_id: r.id,
      slug: r.slug,
      spot_name: r.name,
      current_image_url: r.image_url,
      current_credit: r.source_name,
      commons_file: title,
      attribution_url: c?.attribution_url ?? r.source_url,
      license: c?.license ?? null,
      license_raw: c?.license_raw ?? null,
      license_url: c?.license_url ?? null,
      author: c?.author ?? null,
      width: c?.width ?? null,
      height: c?.height ?? null,
      download_url: c?.download_url ?? null,
      ok: problems.length === 0,
      problems,
    };
  });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORTS_DIR, 'pangasinan-backfill.json'), JSON.stringify(out, null, 2));
  const cols = [
    'spot_id',
    'slug',
    'commons_file',
    'license',
    'author',
    'attribution_url',
    'license_url',
    'current_image_url',
    'current_credit',
    'ok',
    'problems',
  ] as const;
  fs.writeFileSync(
    path.join(REPORTS_DIR, 'pangasinan-backfill.csv'),
    [
      cols.join(','),
      ...out.map((o) => cols.map((k) => csvCell(Array.isArray(o[k]) ? (o[k] as string[]).join('; ') : o[k])).join(',')),
    ].join('\n') + '\n',
  );
  console.log(
    JSON.stringify(
      {
        spots: out.length,
        ok: out.filter((o) => o.ok).length,
        problems: out.filter((o) => !o.ok).map((o) => [o.spot_id, o.problems]),
      },
      null,
      2,
    ),
  );
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
