import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Pool, PoolClient } from 'pg';
import { verifyMigrations } from '../../src/db/migrations.js';
import { DestinationCandidate, isAutoPublishCandidate } from '../../src/seed/normalize.js';
import { ensureAreaCache, matchSpotToAreas } from '../../src/maps/areas-service.js';

type Mode = 'dry-run' | 'apply';
type Existing = { id: string; name: string; source_type: string; image_url: string; external_refs: Record<string, string>; field_sources: Record<string, unknown>; gps_lat: number; gps_lng: number };
type PhotoFile = { path: string; objectKey: string; mime: string; bytes: number; width: number; height: number; createdByThisRun: boolean };
const argv = process.argv.slice(2);
const value = (name: string) => argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const mode: Mode = argv.includes('--apply') ? 'apply' : 'dry-run';
const wave = value('--wave');
const region = value('--region');
const inputFile = value('--input');
const factsFile = value('--facts');
const explicitDatabaseUrl = process.env.DATABASE_URL;

function assertSafeTarget(raw: string | undefined): URL {
  if (!raw) throw new Error('DATABASE_URL must be explicitly set.');
  const url = new URL(raw);
  const database = url.pathname.slice(1);
  const hostAllowed = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  const databaseAllowed = database === 'jdq_reliability_test' || /^jdq_preview_[a-z0-9_]+_dev$/.test(database);
  if (!hostAllowed || !databaseAllowed) throw new Error('Refusing seed import: only loopback jdq_reliability_test or jdq_preview_*_dev databases are allowed.');
  if (process.env.DB_MIGRATION_MODE !== 'verify' || process.env.SEED_DEVELOPMENT_DATA !== 'false' || process.env.ALLOW_IN_MEMORY_FALLBACK !== 'false') {
    throw new Error('Required safety environment: DB_MIGRATION_MODE=verify, SEED_DEVELOPMENT_DATA=false, ALLOW_IN_MEMORY_FALLBACK=false.');
  }
  return url;
}

function normalizedName(name: string): string { return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function distanceM(a: DestinationCandidate, b: { gps_lat: number; gps_lng: number }): number {
  const rad = Math.PI / 180, dLat = (a.gps_lat - b.gps_lat) * rad, dLng = (a.gps_lng - b.gps_lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.gps_lat * rad) * Math.cos(b.gps_lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
function stableId(candidate: DestinationCandidate): string {
  const ref = candidate.external_refs.osm || candidate.external_refs.wikidata;
  if (!ref) throw new Error(`Missing stable external ref for ${candidate.name}`);
  return `open-${createHash('sha256').update(ref).digest('hex').slice(0, 28)}`;
}
function slugFor(candidate: DestinationCandidate): string {
  const name = normalizedName(candidate.name).replace(/\s+/g, '-').slice(0, 90) || 'place';
  return `open-${name}-${createHash('sha256').update(candidate.external_refs.osm || candidate.external_refs.wikidata || name).digest('hex').slice(0, 10)}`;
}
function parseCandidates(filename: string): Promise<DestinationCandidate[]> {
  return new Promise((resolve, reject) => {
    const items: DestinationCandidate[] = [];
    const input = readline.createInterface({ input: fs.createReadStream(filename), crlfDelay: Infinity });
    input.on('line', (line) => { if (line.trim()) { try { items.push(JSON.parse(line)); } catch (error) { input.close(); reject(error); } } });
    input.on('close', () => resolve(items)); input.on('error', reject);
  });
}
async function parseScrapedFacts(filename?: string): Promise<Map<string, Record<string, unknown>>> {
  const facts = new Map<string, Record<string, unknown>>();
  if (!filename) return facts;
  const input = readline.createInterface({ input: fs.createReadStream(filename), crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.facts_only !== true || typeof record.external_ref !== 'string' || !record.fields || typeof record.fields !== 'object') continue;
    const safe: Record<string, unknown> = {};
    for (const key of ['hours', 'official_website', 'contact_number', 'entrance_fee', 'closure_notice']) {
      const field = record.fields[key];
      if (field?.source === 'scrapling' && field.reviewed === false && typeof field.proposed_value === 'string' && field.proposed_value.length <= 500) safe[key] = field;
    }
    if (Object.keys(safe).length) facts.set(record.external_ref, safe);
  }
  return facts;
}

function dedupeCandidates(items: DestinationCandidate[]) {
  const kept: DestinationCandidate[] = [];
  let duplicateCount = 0;
  for (const item of items) {
    const refs = Object.values(item.external_refs || {}).filter(Boolean).map(String);
    const name = normalizedName(item.name);
    const duplicate = kept.find((other) => refs.some((ref) => Object.values(other.external_refs || {}).includes(ref)) ||
      (normalizedName(other.name) === name && distanceM(item, other) <= 150));
    if (duplicate) {
      // Keep all stable identities on the canonical candidate instead of
      // silently dropping the second OSM/Wikidata reference.
      duplicate.external_refs = { ...duplicate.external_refs, ...item.external_refs };
      duplicate.field_sources = { ...duplicate.field_sources, ...item.field_sources };
      duplicateCount++;
      continue;
    }
    kept.push(item);
  }
  return { candidates: kept, duplicateCount };
}

async function locateExisting(client: PoolClient, candidate: DestinationCandidate): Promise<Existing | undefined> {
  const osm = candidate.external_refs.osm || null, wikidata = candidate.external_refs.wikidata || null;
  const { rows } = await client.query(
    `SELECT id, name, source_type, image_url, external_refs, field_sources, gps_lat, gps_lng
       FROM spots
      WHERE ($1::text IS NOT NULL AND external_refs->>'osm' = $1)
         OR ($2::text IS NOT NULL AND external_refs->>'wikidata' = $2)
         OR (name % $3 AND similarity(name, $3) >= 0.6
             AND gps_lat BETWEEN $4 - 0.004 AND $4 + 0.004
             AND gps_lng BETWEEN $5 - 0.004 AND $5 + 0.004)
      ORDER BY CASE WHEN external_refs->>'osm' = $1 OR external_refs->>'wikidata' = $2 THEN 0 ELSE 1 END,
               similarity(name, $3) DESC LIMIT 30`,
    [osm, wikidata, candidate.name, candidate.gps_lat, candidate.gps_lng],
  );
  return rows.find((row: Existing) => {
    const hasRef = (osm && row.external_refs?.osm === osm) || (wikidata && row.external_refs?.wikidata === wikidata);
    return Boolean(hasRef) || distanceM(candidate, row) <= 300;
  });
}

function photoDirectory(): string {
  const configured = process.env.JDQ_SEED_PHOTO_DIR;
  if (!configured || !path.isAbsolute(configured)) throw new Error('Set JDQ_SEED_PHOTO_DIR to an absolute directory outside the repository (recommended: ~/jdq-seed/photos).');
  const resolved = path.resolve(configured), home = path.resolve(process.env.HOME || '');
  if (!resolved.startsWith(`${home}${path.sep}`)) throw new Error('JDQ_SEED_PHOTO_DIR must stay under the WSL home directory.');
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

async function saveCommonsPhoto(candidate: DestinationCandidate, directory: string): Promise<PhotoFile | undefined> {
  const photo = candidate.photo;
  if (!photo || !/^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\//.test(photo.thumbnail_url) ||
      !/^(CC0|Public domain|PD|CC BY(?:-SA)?(?:\s+[0-9.]+)?)$/i.test(photo.license) || !photo.author.trim()) return undefined;
  const response = await fetch(photo.thumbnail_url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'JuanDerQuest-NationalSeed/1.0 (Commons attribution import)' } });
  if (!response.ok) return undefined;
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'upload.wikimedia.org') return undefined;
  const mime = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as Record<string, string>)[mime];
  if (!ext) return undefined;
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > 6 * 1024 * 1024) return undefined;
  const valid = (mime === 'image/jpeg' && buffer[0] === 0xff && buffer[1] === 0xd8) ||
    (mime === 'image/png' && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
    (mime === 'image/webp' && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP');
  if (!valid) return undefined;
  const objectKey = `spot_photo_commons_${createHash('sha256').update(candidate.external_refs.osm || candidate.external_refs.wikidata || photo.attribution_url).digest('hex').slice(0, 32)}.${ext}`;
  const destination = path.join(directory, objectKey);
  const createdByThisRun = !fs.existsSync(destination);
  if (createdByThisRun) fs.writeFileSync(destination, buffer, { flag: 'wx', mode: 0o600 });
  return { path: destination, objectKey, mime, bytes: buffer.length, width: 0, height: 0, createdByThisRun };
}

async function main() {
  if (!wave || !region || !inputFile) throw new Error('Usage: seed-import.ts --wave <wave> --region <PSGC> --input <candidate-jsonl> [--apply] (dry-run is default).');
  if (!/^\d{6,10}$/.test(region)) throw new Error('--region must be the target PSA/PSGC code.');
  const url = assertSafeTarget(explicitDatabaseUrl);
  if (!fs.existsSync(inputFile)) throw new Error(`Input file does not exist: ${inputFile}`);
  const pool = new Pool({ connectionString: explicitDatabaseUrl, max: 3, connectionTimeoutMillis: 5000 });
  const photoFiles: PhotoFile[] = [];
  const runId = randomUUID();
  const started = new Date();
  try {
    await verifyMigrations(pool);
    await ensureAreaCache(pool, true);
    const { rows: areas } = await pool.query(`WITH RECURSIVE descendants AS (
      SELECT id, psgc_code, level, name, display_name, parent_id, bbox FROM admin_areas WHERE psgc_code = $1
      UNION ALL SELECT child.id, child.psgc_code, child.level, child.name, child.display_name, child.parent_id, child.bbox
        FROM admin_areas child JOIN descendants parent ON child.parent_id = parent.id
    ) SELECT * FROM descendants`, [region]);
    if (!areas.length) throw new Error(`No imported admin area found for region/PSGC ${region}; import boundaries before this wave.`);
    const loaded = await parseCandidates(inputFile);
    const scrapedFacts = await parseScrapedFacts(factsFile);
    let pendingScrapedFieldCount = 0;
    for (const candidate of loaded) {
      const entry = Object.entries(candidate.external_refs || {}).find(([, ref]) => scrapedFacts.has(String(ref)));
      const pending = entry ? scrapedFacts.get(String(entry[1])) : undefined;
      if (pending) {
        candidate.field_sources.scraped_pending = pending;
        pendingScrapedFieldCount += Object.keys(pending).length;
      }
    }
    const scopeAreaIds = new Set<string>(areas.map((area: any) => area.id));
    const scoped = loaded.filter((candidate) => {
      const assignment = matchSpotToAreas(candidate.gps_lat, candidate.gps_lng, candidate.municipality);
      return assignment.townAreaId && scopeAreaIds.has(assignment.townAreaId);
    });
    const { candidates, duplicateCount } = dedupeCandidates(scoped);
    const stats = { total_input: loaded.length, in_region: scoped.length, within_import_duplicates: duplicateCount, pending_scraped_fields: pendingScrapedFieldCount, would_publish: 0, review: 0,
      existing_ref_merges: 0, name_location_merges: 0, no_area: 0, photo_downloads: 0, by_category: {} as Record<string, number>, confidence_buckets: { '0-.29': 0, '.3-.59': 0, '.6-.79': 0, '.8-1': 0 }, samples_publish: [] as unknown[], samples_review: [] as unknown[] };
    const preview: Array<{ candidate: DestinationCandidate; area: { townAreaId: string | null; barangayAreaId: string | null }; existing?: Existing; autoPublish: boolean }> = [];
    const publishSamples: Array<{ rank: string; sample: unknown }> = [];
    const reviewSamples: Array<{ rank: string; sample: unknown }> = [];
    const client = await pool.connect();
    try {
      for (const candidate of candidates) {
        const area = matchSpotToAreas(candidate.gps_lat, candidate.gps_lng, candidate.municipality);
        if (!area.townAreaId) { stats.no_area++; candidate.review_only = true; }
        const existing = await locateExisting(client, candidate);
        if (existing) {
          const hasRef = (candidate.external_refs.osm && existing.external_refs?.osm === candidate.external_refs.osm) ||
            (candidate.external_refs.wikidata && existing.external_refs?.wikidata === candidate.external_refs.wikidata);
          if (hasRef) stats.existing_ref_merges++; else stats.name_location_merges++;
        }
        const autoPublish = !existing && Boolean(area.townAreaId) && isAutoPublishCandidate(candidate);
        if (autoPublish) stats.would_publish++; else if (!existing) stats.review++;
        stats.by_category[candidate.category] = (stats.by_category[candidate.category] || 0) + 1;
        const confidence = candidate.import_confidence;
        stats.confidence_buckets[confidence < 0.3 ? '0-.29' : confidence < 0.6 ? '.3-.59' : confidence < 0.8 ? '.6-.79' : '.8-1']++;
        const sample = { name: candidate.name, category: candidate.category, confidence: Number(confidence.toFixed(3)), municipality: candidate.municipality || null,
          external_refs: candidate.external_refs, photo_license: candidate.photo?.license || null, photo_author: candidate.photo?.author || null,
          status: autoPublish ? 'would_publish' : existing ? 'provenance_merge_only' : 'needs_review', reason: !area.townAreaId ? 'outside_imported_area' : candidate.review_only ? 'generic_or_flagged' : confidence < 0.6 ? 'confidence_below_0.6' : candidate.field_sources.scraped_pending ? 'scraped_facts_require_review' : existing ? 'existing_destination_provenance_only' : 'manual_review_required' };
        const sampleRank = createHash('sha256').update(`${wave}:${candidate.external_refs.osm || candidate.external_refs.wikidata}`).digest('hex');
        if (autoPublish) publishSamples.push({ rank: sampleRank, sample });
        if (!autoPublish && !existing) reviewSamples.push({ rank: sampleRank, sample });
        preview.push({ candidate, area, existing, autoPublish });
      }
      // Stable hash ranking gives a reproducible, well-distributed owner sample
      // instead of biasing the handoff to the extractor's source order.
      stats.samples_publish = publishSamples.sort((a, b) => a.rank.localeCompare(b.rank)).slice(0, 30).map(({ sample }) => sample);
      stats.samples_review = reviewSamples.sort((a, b) => a.rank.localeCompare(b.rank)).slice(0, 30).map(({ sample }) => sample);
      if (mode === 'apply') {
        await client.query('BEGIN');
        const directory = photoDirectory();
        for (const item of preview) {
          const { candidate, area, existing, autoPublish } = item;
          const sourceMerge = { external_refs: candidate.external_refs, field_sources: candidate.field_sources, import_confidence: candidate.import_confidence, import_wave: wave };
          if (existing) {
            await client.query(`UPDATE spots SET external_refs = COALESCE(external_refs, '{}'::jsonb) || $1::jsonb,
              field_sources = COALESCE(field_sources, '{}'::jsonb) || $2::jsonb, import_confidence = $3, import_wave = $4
              WHERE id = $5 AND (external_refs IS DISTINCT FROM (COALESCE(external_refs, '{}'::jsonb) || $1::jsonb)
                OR field_sources IS DISTINCT FROM (COALESCE(field_sources, '{}'::jsonb) || $2::jsonb)
                OR import_confidence IS DISTINCT FROM $3 OR import_wave IS DISTINCT FROM $4)`,
            [JSON.stringify(sourceMerge.external_refs), JSON.stringify(sourceMerge.field_sources), sourceMerge.import_confidence, sourceMerge.import_wave, existing.id]);
            continue;
          }
          let savedPhoto: PhotoFile | undefined;
          if (autoPublish && candidate.photo) {
            savedPhoto = await saveCommonsPhoto(candidate, directory);
            if (savedPhoto) { photoFiles.push(savedPhoto); stats.photo_downloads++; }
          }
          const id = stableId(candidate), slug = slugFor(candidate), status = autoPublish ? 'published' : 'needs_review';
          const areaRecord = area.townAreaId ? await client.query('SELECT name FROM admin_areas WHERE id=$1', [area.townAreaId]) : { rows: [] };
          const municipality = candidate.municipality || areaRecord.rows[0]?.name || 'Unknown';
          const imageUrl = savedPhoto ? `/api/v1/uploads/spot-photos/${savedPhoto.objectKey}` : '';
          await client.query(`INSERT INTO spots (id, slug, name, description, category, subcategory, tags, municipality, address,
              gps_lat, gps_lng, price_level, hours, amenities, good_for, best_time, image_url, source_type, source_name, source_url,
              trust_level, status, created_at, updated_at, town_area_id, barangay_area_id, external_refs, field_sources, import_confidence, import_wave, official_website)
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,0,$12::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,$13,'open_data','OpenStreetMap contributors',$14,'open_data',$15,NOW(),NOW(),$16,$17,$18::jsonb,$19::jsonb,$20,$21,$22)
            ON CONFLICT (id) DO NOTHING`, [id, slug, candidate.name, candidate.description || '', candidate.category, candidate.subcategory,
            JSON.stringify(candidate.tags || []), municipality, candidate.address || '', candidate.gps_lat, candidate.gps_lng,
            JSON.stringify(candidate.hours || {}), imageUrl, candidate.field_sources.name?.url || 'https://www.openstreetmap.org/', status,
            area.townAreaId, area.barangayAreaId, JSON.stringify(candidate.external_refs), JSON.stringify(candidate.field_sources), candidate.import_confidence, wave, candidate.official_website || null]);
          if (savedPhoto) {
            await client.query(`INSERT INTO spot_assets (id,user_id,storage_provider,object_key,url,mime_type,width,height,size_bytes,status,spot_id,license,author,attribution_url)
              VALUES ($1,NULL,'local',$2,$3,$4,$5,$6,$7,'attached',$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
            [randomUUID(), savedPhoto.objectKey, imageUrl, savedPhoto.mime, savedPhoto.width, savedPhoto.height, savedPhoto.bytes, id, candidate.photo!.license, candidate.photo!.author, candidate.photo!.attribution_url]);
          }
        }
        const finishedAt = new Date().toISOString();
        await client.query(`INSERT INTO seed_runs (id,wave,region_psgc,mode,stats,started_at,finished_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
          [runId, wave, region, mode, JSON.stringify({ ...stats, finished_at: finishedAt }), started, finishedAt]);
        await client.query('COMMIT');
      } else {
        const finishedAt = new Date().toISOString();
        await client.query(`INSERT INTO seed_runs (id,wave,region_psgc,mode,stats,started_at,finished_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
          [runId, wave, region, mode, JSON.stringify({ ...stats, finished_at: finishedAt }), started, finishedAt]);
      }
      process.stdout.write(`[national-seed] mode=${mode} wave=${wave} region=${region} input=${inputFile}\n${JSON.stringify(stats, null, 2)}\n`);
    } catch (error) {
      if (mode === 'apply') await client.query('ROLLBACK').catch(() => undefined);
          for (const photo of photoFiles) if (photo.createdByThisRun) fs.rmSync(photo.path, { force: true });
      throw error;
    } finally { client.release(); }
  } finally { await pool.end(); }
}

main().catch((error) => { console.error(`[national-seed] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
