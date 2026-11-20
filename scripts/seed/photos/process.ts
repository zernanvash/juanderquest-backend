// Plan 116 §8.4 photo processing: download → WebP w320/w640/w1280 (no upscaling) + BlurHash +
// dominant colour + dHash → storage driver → spot_assets. Dry-run by default.
//
//   DATABASE_URL=… npx tsx scripts/seed/photos/process.ts --limit N --storage local|r2
//        [--dry-run|--apply] [--processor pillow|sharp] [--spot-ids a,b] [--max-downloads 8] [--sample-seed S]
//        [--region 0100000000|"Ilocos Region"] [--provinces "La Union,Pangasinan"]
// --region/--provinces: only spots inside those provinces (default whole country).
//
// Idempotent: each processed file has a manifest under <PHOTO_ROOT>/processed/, reused while its
// variants exist in storage, so a rerun downloads nothing and the DB upsert changes 0 rows.
// Originals are cached under <PHOTO_ROOT>/originals/ (cap 2 GB) and deleted once variants exist.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { PoolClient } from 'pg';
import {
  argValue,
  MANIFEST_DIR,
  ORIGINALS_CAP_BYTES,
  ORIGINALS_DIR,
  PHOTO_ROOT,
  REPORTS_DIR,
  WORK_DIR,
} from './config.js';
import { CATALOG_SOURCES, pool } from './db.js';
import { readAllDiscovery } from './discover.js';
import { downloadTo, SourceBlockedError, stats } from './http.js';
import { getProcessor, type ImageProcessor } from './image/processor.js';
import { blurhashEncode, dHash, dominantColor, toSignedInt64, toUnsignedInt64 } from './pixels.js';
import { MAX_PHOTOS_PER_SPOT } from './quality.js';
import { assignOwnership, choosePhotos, haversineM, NEIGHBOUR_RADIUS_M } from './select.js';
import { getStorage, variantKey, type PhotoStorage } from './storage.js';
import type { PhotoCandidate, SpotCandidates } from './types.js';
import { scopeFromArgs } from './scope.js';
import { seededSample } from './visual-check.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const LIMIT = Number(argValue(args, '--limit', '0'));
const STORAGE = argValue(args, '--storage', 'local')!;
const PROCESSOR = argValue(args, '--processor', 'pillow')!;
const IDS = argValue(args, '--spot-ids')?.split(',').filter(Boolean);
const MAX_DOWNLOADS = Number(argValue(args, '--max-downloads', '8'));
/** With --limit: a reproducible random sample instead of the first N spots by id. */
const SAMPLE_SEED = argValue(args, '--sample-seed');

export interface Manifest {
  source: string;
  source_id: string;
  ok: boolean;
  error?: string;
  storage?: string;
  orig_width?: number;
  orig_height?: number;
  phash?: string; // unsigned 64-bit, decimal
  blurhash?: string;
  dominant_color?: string;
  variants?: Record<string, { key: string; url: string; width: number; height: number; bytes: number }>;
  download_bytes?: number;
  processed_at?: string;
}

export function fileHash(source: string, sourceId: string): string {
  return crypto.createHash('sha1').update(`${source}:${sourceId}`).digest('hex').slice(0, 20);
}

function manifestPath(c: Pick<PhotoCandidate, 'source' | 'source_id'>): string {
  const h = fileHash(c.source, c.source_id);
  return path.join(MANIFEST_DIR, h.slice(0, 2), `${h}.json`);
}

function dirBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
  }
  return n;
}

async function processOne(
  c: PhotoCandidate,
  proc: ImageProcessor,
  storage: PhotoStorage,
  counters: Record<string, number>,
): Promise<Manifest> {
  const mp = manifestPath(c);
  if (fs.existsSync(mp)) {
    const m = JSON.parse(fs.readFileSync(mp, 'utf8')) as Manifest;
    if (!m.ok) return m;
    if (m.storage === storage.name && m.variants) {
      let all = true;
      for (const v of Object.values(m.variants)) if (!(await storage.exists(v.key))) all = false;
      if (all) {
        counters.reused++;
        return m;
      }
    }
  }
  const h = fileHash(c.source, c.source_id);
  const ext = (/\.([a-z0-9]{2,5})(?:$|\?)/i.exec(new URL(c.download_url).pathname)?.[1] ?? 'img').toLowerCase();
  const orig = path.join(ORIGINALS_DIR, `${h}.${ext}`);
  const work = path.join(WORK_DIR, h);
  let m: Manifest;
  try {
    if (!fs.existsSync(orig)) {
      if (dirBytes(ORIGINALS_DIR) > ORIGINALS_CAP_BYTES) throw new Error('originals cache over 2 GB cap');
      counters.downloads++;
      const t0 = Date.now();
      counters.download_bytes += await downloadTo(c.download_url, orig);
      counters.download_ms += Date.now() - t0;
    }
    const t1 = Date.now();
    const img = await proc.process(orig, work, h);
    counters.process_ms += Date.now() - t1;
    if (img.variants.length === 0) throw new Error('too_small_for_variants');
    const variants: NonNullable<Manifest['variants']> = {};
    for (const v of img.variants) {
      const key = variantKey(c.source, c.source_id, v.label);
      await storage.put(key, v.path, 'image/webp');
      variants[v.label] = { key, url: storage.url(key), width: v.width, height: v.height, bytes: v.bytes };
    }
    m = {
      source: c.source,
      source_id: c.source_id,
      ok: true,
      storage: storage.name,
      orig_width: c.width,
      orig_height: c.height,
      phash: dHash(img.gray9x8).toString(),
      blurhash: blurhashEncode(img.small.rgb, img.small.width, img.small.height),
      dominant_color: dominantColor(img.small.rgb),
      variants,
      download_bytes: fs.statSync(orig).size,
      processed_at: new Date().toISOString(),
    };
    counters.processed++;
  } catch (e) {
    if (e instanceof SourceBlockedError) throw e;
    const msg = (e as Error).message;
    // Network failures are not cached (retry next run); decode/size failures are.
    if (/^HTTP |fetch failed|timeout|aborted|cap/i.test(msg)) {
      counters.download_failed++;
      return { source: c.source, source_id: c.source_id, ok: false, error: msg };
    }
    m = { source: c.source, source_id: c.source_id, ok: false, error: msg.slice(0, 300) };
    counters.decode_failed++;
  } finally {
    fs.rmSync(orig, { force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(mp), { recursive: true });
  fs.writeFileSync(mp, JSON.stringify(m));
  return m;
}

type Accepted = PhotoCandidate & {
  manifest: Manifest;
  phash: bigint;
  quality_score: number;
  is_primary: boolean;
  sort_order: number;
};

const UPSERT = `
INSERT INTO spot_assets (id, user_id, storage_provider, object_key, url, mime_type, width, height, size_bytes, status,
  spot_id, source, source_id, license, license_url, author, attribution_url, blurhash, dominant_color, phash,
  quality_score, variants, is_primary, sort_order)
VALUES ($1, NULL, $2, $3, $4, 'image/webp', $5, $6, $7, 'approved', $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
  $18, $19::jsonb, $20, $21)
ON CONFLICT (source, source_id) WHERE source_id IS NOT NULL DO UPDATE SET
  storage_provider = EXCLUDED.storage_provider, object_key = EXCLUDED.object_key, url = EXCLUDED.url,
  mime_type = EXCLUDED.mime_type, width = EXCLUDED.width, height = EXCLUDED.height, size_bytes = EXCLUDED.size_bytes,
  status = EXCLUDED.status, spot_id = EXCLUDED.spot_id, license = EXCLUDED.license, license_url = EXCLUDED.license_url,
  author = EXCLUDED.author, attribution_url = EXCLUDED.attribution_url, blurhash = EXCLUDED.blurhash,
  dominant_color = EXCLUDED.dominant_color, phash = EXCLUDED.phash, quality_score = EXCLUDED.quality_score,
  variants = EXCLUDED.variants, is_primary = EXCLUDED.is_primary, sort_order = EXCLUDED.sort_order, updated_at = NOW()
WHERE (spot_assets.storage_provider, spot_assets.object_key, spot_assets.url, spot_assets.width, spot_assets.height,
       spot_assets.size_bytes, spot_assets.status, spot_assets.spot_id, spot_assets.license, spot_assets.license_url,
       spot_assets.author, spot_assets.attribution_url, spot_assets.blurhash, spot_assets.dominant_color,
       spot_assets.phash, spot_assets.quality_score, spot_assets.variants, spot_assets.is_primary, spot_assets.sort_order)
  IS DISTINCT FROM
      (EXCLUDED.storage_provider, EXCLUDED.object_key, EXCLUDED.url, EXCLUDED.width, EXCLUDED.height,
       EXCLUDED.size_bytes, EXCLUDED.status, EXCLUDED.spot_id, EXCLUDED.license, EXCLUDED.license_url,
       EXCLUDED.author, EXCLUDED.attribution_url, EXCLUDED.blurhash, EXCLUDED.dominant_color,
       EXCLUDED.phash, EXCLUDED.quality_score, EXCLUDED.variants, EXCLUDED.is_primary, EXCLUDED.sort_order)
RETURNING (xmax = 0) AS inserted`;

/** Writes one spot's chosen photos; returns {inserted, updated, retired}. */
async function writeSpot(client: PoolClient, spotId: string, chosen: Accepted[], storageName: string) {
  const res = { inserted: 0, updated: 0, retired: 0 };
  await client.query('BEGIN');
  try {
    const otherPrimary = await client.query(
      `SELECT 1 FROM spot_assets WHERE spot_id = $1 AND is_primary AND (source IS NULL OR source <> ALL($2))`,
      [spotId, CATALOG_SOURCES],
    );
    const keepIds = chosen.map((c) => c.source_id);
    const primaryId = otherPrimary.rowCount ? null : (chosen.find((c) => c.is_primary)?.source_id ?? null);
    // Clear a stale catalog primary first (unique index uq_spot_assets_primary), and retire
    // catalog photos of this spot that are no longer chosen.
    const cleared = await client.query(
      `UPDATE spot_assets SET is_primary = FALSE, updated_at = NOW()
        WHERE spot_id = $1 AND is_primary AND source = ANY($2) AND source_id IS DISTINCT FROM $3`,
      [spotId, CATALOG_SOURCES, primaryId],
    );
    res.updated += cleared.rowCount ?? 0;
    const retired = await client.query(
      `UPDATE spot_assets SET status = 'deleted', updated_at = NOW()
        WHERE spot_id = $1 AND source = ANY($2) AND status <> 'deleted' AND NOT (source_id = ANY($3))`,
      [spotId, CATALOG_SOURCES, keepIds],
    );
    res.retired += retired.rowCount ?? 0;
    for (const c of chosen) {
      const m = c.manifest;
      const largest = Object.values(m.variants!).sort((a, b) => b.width - a.width)[0];
      const r = await client.query<{ inserted: boolean }>(UPSERT, [
        `cat-${fileHash(c.source, c.source_id)}`,
        storageName,
        largest.key,
        largest.url,
        c.width,
        c.height,
        largest.bytes,
        spotId,
        c.source,
        c.source_id,
        c.license,
        c.license_url,
        c.author,
        c.attribution_url,
        m.blurhash,
        m.dominant_color,
        toSignedInt64(c.phash).toString(),
        c.quality_score,
        JSON.stringify(Object.fromEntries(Object.entries(m.variants!).map(([k, v]) => [k, v.url]))),
        c.source_id === primaryId,
        c.sort_order,
      ]);
      for (const row of r.rows) {
        if (row.inserted) res.inserted++;
        else res.updated++;
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
  return res;
}

async function main() {
  const started = Date.now();
  for (const d of [ORIGINALS_DIR, WORK_DIR, MANIFEST_DIR, REPORTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const scope = scopeFromArgs(args);
  // Out-of-scope spots are ignored entirely (also for file ownership).
  const all = readAllDiscovery().filter((d) => !scope || scope.test(d.spot));
  if (scope) console.log(`scope: ${scope.label}: ${all.length} discovered spots`);
  const owner = assignOwnership(all);
  const db = pool();

  const existing = await db.query<{
    source: string;
    source_id: string;
    spot_id: string;
    phash: string | null;
    lat: number;
    lng: number;
  }>(
    `SELECT a.source, a.source_id, a.spot_id, a.phash::text AS phash, s.gps_lat AS lat, s.gps_lng AS lng
       FROM spot_assets a JOIN spots s ON s.id = a.spot_id
      WHERE a.source = ANY($1) AND a.source_id IS NOT NULL AND a.status <> 'deleted'`,
    [CATALOG_SOURCES],
  );
  const dbOwner = new Map(existing.rows.map((r) => [`${r.source}:${r.source_id}`, r.spot_id]));
  const placed: Array<{ spot: string; lat: number; lng: number; phash: bigint }> = existing.rows
    .filter((r) => r.phash)
    .map((r) => ({
      spot: r.spot_id,
      lat: Number(r.lat),
      lng: Number(r.lng),
      phash: toUnsignedInt64(BigInt(r.phash!)),
    }));
  const liveSpots = new Set(
    (
      await db.query<{ id: string }>(`SELECT id FROM spots WHERE NOT is_test AND status NOT IN ('rejected','archived')`)
    ).rows.map((r) => r.id),
  );

  // Spots with a usable candidate, plus spots whose earlier catalog photos may now need retiring.
  const hasAssets = new Set(existing.rows.map((r) => r.spot_id));
  let todo: SpotCandidates[] = all.filter(
    (s) => liveSpots.has(s.spot.spot_id) && (s.candidates.some((c) => !c.rejected) || hasAssets.has(s.spot.spot_id)),
  );
  if (IDS?.length) todo = todo.filter((s) => IDS.includes(s.spot.spot_id));
  if (SAMPLE_SEED !== undefined && LIMIT > 0) todo = seededSample(todo, LIMIT, Number(SAMPLE_SEED));
  else if (LIMIT > 0) todo = todo.slice(0, LIMIT);

  const counters: Record<string, number> = {
    spots: 0,
    spots_with_photos: 0,
    spots_with_hero_primary: 0,
    downloads: 0,
    download_bytes: 0,
    download_ms: 0,
    process_ms: 0,
    reused: 0,
    processed: 0,
    decode_failed: 0,
    download_failed: 0,
    inserted: 0,
    updated: 0,
    retired: 0,
    accepted: 0,
  };
  const rejections: Record<string, number> = {};
  const licenceMix: Record<string, number> = {};
  const variantBytes: Record<string, { n: number; bytes: number }> = {};
  const reject = (r: string, n = 1) => (rejections[r] = (rejections[r] ?? 0) + n);
  const proc = APPLY ? getProcessor(PROCESSOR) : null;
  const storage = APPLY ? getStorage(STORAGE, PHOTO_ROOT) : null;
  const acceptedLog: string[] = [];
  let plannedDownloads = 0;

  console.log(
    `process: ${todo.length} spots, ${APPLY ? 'APPLY' : 'DRY-RUN'}, storage=${STORAGE}, processor=${PROCESSOR}`,
  );
  for (const sc of todo) {
    counters.spots++;
    const spotId = sc.spot.spot_id;
    const usable: PhotoCandidate[] = [];
    for (const c of sc.candidates) {
      if (c.rejected) continue;
      const key = `${c.source}:${c.source_id}`;
      const dbo = dbOwner.get(key);
      if ((dbo && dbo !== spotId) || (!dbo && owner.get(key) !== spotId)) {
        reject('claimed_by_other_spot');
        continue;
      }
      usable.push(c);
    }
    const tryList = usable.slice(0, MAX_DOWNLOADS);
    if (usable.length > tryList.length) reject('not_tried_download_budget', usable.length - tryList.length);
    if (!APPLY) {
      plannedDownloads += tryList.length;
      continue;
    }
    const neighbours = placed
      .filter((p) => p.spot !== spotId && haversineM(p.lat, p.lng, sc.spot.lat, sc.spot.lng) <= NEIGHBOUR_RADIUS_M)
      .map((p) => p.phash);
    // Best candidates first; stop downloading once 5 distinct photos are in hand.
    const hashed: Array<Omit<Accepted, 'is_primary' | 'sort_order'>> = [];
    let tried = 0;
    for (const c of tryList) {
      if (choosePhotos(hashed, neighbours).accepted.length >= MAX_PHOTOS_PER_SPOT) break;
      tried++;
      const m = await processOne(c, proc!, storage!, counters);
      if (!m.ok) {
        reject(
          /too_small/.test(m.error ?? '')
            ? 'too_small_for_variants'
            : /^HTTP |fetch|timeout|cap/i.test(m.error ?? '')
              ? 'download_failed'
              : 'decode_failed',
        );
        continue;
      }
      hashed.push({ ...c, manifest: m, phash: BigInt(m.phash!), quality_score: c.quality_score ?? 0 });
    }
    if (tryList.length > tried) reject('not_needed_spot_full', tryList.length - tried);
    const choice = choosePhotos(hashed, neighbours);
    for (const r of choice.rejected) reject(r.reason);
    if (choice.accepted.length) counters.spots_with_photos++;
    if (choice.accepted.some((a) => a.is_primary && Math.max(a.width, a.height) >= 1000))
      counters.spots_with_hero_primary++;
    for (const a of choice.accepted) {
      counters.accepted++;
      licenceMix[a.license!] = (licenceMix[a.license!] ?? 0) + 1;
      for (const [label, v] of Object.entries(a.manifest.variants!)) {
        const vb = (variantBytes[label] ??= { n: 0, bytes: 0 });
        vb.n++;
        vb.bytes += v.bytes;
      }
      placed.push({ spot: spotId, lat: sc.spot.lat, lng: sc.spot.lng, phash: a.phash });
      acceptedLog.push(
        JSON.stringify({
          spot_id: spotId,
          spot_name: sc.spot.name,
          source: a.source,
          source_id: a.source_id,
          via: a.via,
          license: a.license,
          license_url: a.license_url,
          author: a.author,
          attribution_url: a.attribution_url,
          width: a.width,
          height: a.height,
          quality_score: a.quality_score,
          is_primary: a.is_primary,
          sort_order: a.sort_order,
          variants: Object.fromEntries(Object.entries(a.manifest.variants!).map(([k, v]) => [k, v.key])),
        }),
      );
    }
    const client = await db.connect();
    try {
      const w = await writeSpot(client, spotId, choice.accepted as Accepted[], storage!.name);
      counters.inserted += w.inserted;
      counters.updated += w.updated;
      counters.retired += w.retired;
    } finally {
      client.release();
    }
    if (counters.spots % 20 === 0)
      console.log(
        `  ${counters.spots}/${todo.length} spots, ${counters.accepted} photos, ${counters.downloads} downloads, ${Math.round((Date.now() - started) / 1000)} s`,
      );
  }
  await db.end();

  const wall = (Date.now() - started) / 1000;
  const avg = Object.fromEntries(Object.entries(variantBytes).map(([k, v]) => [k, Math.round(v.bytes / v.n)]));
  const bytesPerPhoto = Object.values(avg).reduce((a, b) => a + b, 0);
  const photosPerSpot = counters.spots ? counters.accepted / counters.spots : 0;
  const summary = {
    mode: APPLY ? 'apply' : 'dry-run',
    scope: scope?.label ?? 'all',
    storage: STORAGE,
    processor: PROCESSOR,
    wall_s: Math.round(wall),
    http_requests: stats.requests,
    ...counters,
    planned_downloads: APPLY ? undefined : plannedDownloads,
    rejections_by_reason: rejections,
    accepted_licence_mix: licenceMix,
    avg_bytes_per_variant: avg,
    avg_bytes_per_photo_all_variants: bytesPerPhoto,
    photos_per_spot: Math.round(photosPerSpot * 100) / 100,
    projection_15000_spots: APPLY
      ? {
          photos: Math.round(photosPerSpot * 15000),
          bytes: Math.round(photosPerSpot * 15000 * bytesPerPhoto),
          gb: Math.round(((photosPerSpot * 15000 * bytesPerPhoto) / 1024 ** 3) * 100) / 100,
          wall_hours_processing_at_this_rate: counters.spots
            ? Math.round(((wall / counters.spots) * 15000) / 360) / 10
            : null,
        }
      : undefined,
  };
  if (APPLY) {
    fs.writeFileSync(path.join(REPORTS_DIR, 'accepted.jsonl'), acceptedLog.join('\n') + '\n');
  }
  fs.writeFileSync(
    path.join(REPORTS_DIR, `process-summary-${APPLY ? 'apply' : 'dry-run'}.json`),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
