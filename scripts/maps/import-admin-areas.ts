import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pool } from 'pg';
import { pointInPolygon, pointInMultiPolygon, computeBbox, distanceMeters } from '../../src/maps/geometry.js';
import { AreaRecord, matchSpotToAreas } from '../../src/maps/areas-service.js';

interface CliArgs {
  dryRun: boolean;
  apply: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dryRun = !apply || args.includes('--dry-run');
  return { dryRun, apply: !dryRun };
}

// Map from KNOWN_AREAS
function loadKnownAreas(): { id: string; name: string }[] {
  const candidates = [
    path.resolve(process.cwd(), '../agy-vector-map-web/src/lib/areas.ts'),
    path.resolve(process.cwd(), '../../web_app/src/lib/areas.ts'),
    path.resolve(__dirname, '../../../../web_app/src/lib/areas.ts'),
    path.resolve(__dirname, '../../../../.local/agy-vector-map-web/src/lib/areas.ts'),
  ];
  const target = candidates.find(c => fs.existsSync(c));
  if (!target) return [];
  const content = fs.readFileSync(target, 'utf8');
  const known: { id: string; name: string }[] = [];
  const regex = /id:\s*['"]([^'"]+)['"],\s*name:\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = regex.exec(content)) !== null) {
    known.push({ id: m[1], name: m[2] });
  }
  return known;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function run() {
  const { dryRun } = parseArgs();
  console.log(`=== Admin Areas Import (${dryRun ? 'DRY RUN' : 'APPLY'}) ===`);

  const homeDir = os.homedir();
  const defaultDir = process.env.JDQ_MAPS_DIR || (
    os.platform() === 'win32'
      ? '\\\\wsl.localhost\\Ubuntu\\home\\kaizo\\jdq-maps\\areas'
      : path.join(homeDir, 'jdq-maps/areas')
  );
  const townsPath = path.join(defaultDir, 'towns.geojson');
  const barangaysPath = path.join(defaultDir, 'barangays.geojson');

  if (!fs.existsSync(townsPath) || !fs.existsSync(barangaysPath)) {
    throw new Error(`GeoJSON files missing at ${defaultDir}. Check JDQ_MAPS_DIR.`);
  }

  const townsGeoJson = JSON.parse(fs.readFileSync(townsPath, 'utf8'));
  const barangaysGeoJson = JSON.parse(fs.readFileSync(barangaysPath, 'utf8'));

  const knownAreas = loadKnownAreas();
  console.log(`Loaded ${knownAreas.length} KNOWN_AREAS for ID retention.`);

  // Province root
  const areas: AreaRecord[] = [];
  const pangasinanProvince: AreaRecord = {
    id: 'pangasinan',
    psgc_code: 105500000,
    level: 'province',
    name: 'Pangasinan',
    display_name: 'Pangasinan',
    parent_id: null,
    osm_relation_id: null,
    has_boundary: true,
    label_lat: 15.9281,
    label_lng: 120.3329,
    bbox: [119.7, 15.6, 120.9, 16.4],
    min_zoom: 7,
    shape_file: null,
    data_version: '2023-psa-namria',
  };
  areas.push(pangasinanProvince);

  // 1. Process Towns
  const townMap = new Map<string, AreaRecord>(); // psgc -> record
  for (const feat of townsGeoJson.features) {
    const p = feat.properties || {};
    const psgc = Number(p.adm3_psgc);
    const rawName = String(p.adm3_en || '');
    const cleanName = rawName.replace(/^City of /i, '');

    // Match existing KNOWN_AREAS id
    let townId = slugify(cleanName);
    const known = knownAreas.find(
      (k) =>
        k.name.toLowerCase() === rawName.toLowerCase() ||
        k.name.toLowerCase() === cleanName.toLowerCase() ||
        k.id === townId
    );
    if (known) {
      townId = known.id;
    }

    const bbox = computeBbox(feat.geometry);
    const labelLng = (bbox[0] + bbox[2]) / 2;
    const labelLat = (bbox[1] + bbox[3]) / 2;

    const townRecord: AreaRecord = {
      id: townId,
      psgc_code: psgc,
      level: 'town',
      name: cleanName,
      display_name: `${cleanName}, Pangasinan`,
      parent_id: 'pangasinan',
      osm_relation_id: null,
      has_boundary: true,
      label_lat: labelLat,
      label_lng: labelLng,
      bbox,
      min_zoom: 9,
      shape_file: 'areas/towns.geojson',
      data_version: '2023-psa-namria',
      geometry: feat.geometry,
    };

    townMap.set(String(psgc), townRecord);
    areas.push(townRecord);
  }

  // 2. Process Barangays
  for (const feat of barangaysGeoJson.features) {
    const p = feat.properties || {};
    const bgyPsgc = Number(p.adm4_psgc);
    const townPsgc = String(p.adm3_psgc);
    const bgyName = String(p.adm4_en || '');
    const parentTown = townMap.get(townPsgc);

    const townId = parentTown ? parentTown.id : `town-${townPsgc}`;
    const bgySlug = slugify(bgyName);
    const bgyId = `${townId}--${bgySlug}`;

    const bbox = computeBbox(feat.geometry);
    const labelLng = (bbox[0] + bbox[2]) / 2;
    const labelLat = (bbox[1] + bbox[3]) / 2;

    const bgyRecord: AreaRecord = {
      id: bgyId,
      psgc_code: bgyPsgc,
      level: 'barangay',
      name: bgyName,
      display_name: parentTown ? `${bgyName}, ${parentTown.name}` : bgyName,
      parent_id: parentTown ? parentTown.id : null,
      osm_relation_id: null,
      has_boundary: true,
      label_lat: labelLat,
      label_lng: labelLng,
      bbox,
      min_zoom: 13,
      shape_file: 'areas/barangays.geojson',
      data_version: '2023-psa-namria',
      geometry: feat.geometry,
    };

    areas.push(bgyRecord);
  }

  console.log(`Parsed total ${areas.length} areas:`);
  console.log(`  Provinces: 1`);
  console.log(`  Towns: ${townMap.size}`);
  console.log(`  Barangays: ${areas.length - townMap.size - 1}`);

  // Connect to Database
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.log('No DATABASE_URL supplied; parsing and validation complete.');
    return;
  }

  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    if (dryRun) {
      console.log('\n--- DRY RUN CHECKS ---');
      const spotRes = await client.query(`SELECT id, name, municipality, gps_lat, gps_lng FROM spots WHERE status = 'published'`);
      console.log(`Found ${spotRes.rows.length} published spots to evaluate.`);

      let matchedTownCount = 0;
      let matchedBgyCount = 0;
      let unassignedCount = 0;

      for (const spot of spotRes.rows) {
        const match = matchSpotToAreas(Number(spot.gps_lat), Number(spot.gps_lng), spot.municipality, areas);
        if (match.townAreaId) matchedTownCount++;
        if (match.barangayAreaId) matchedBgyCount++;
        if (!match.townAreaId && !match.barangayAreaId) {
          unassignedCount++;
          console.log(`  [unassigned] Spot: "${spot.name}" (${spot.municipality}) at [${spot.gps_lat}, ${spot.gps_lng}]`);
        }
      }

      console.log(`\nDry run spot matching summary:`);
      console.log(`  Town matched: ${matchedTownCount} / ${spotRes.rows.length}`);
      console.log(`  Barangay matched: ${matchedBgyCount} / ${spotRes.rows.length}`);
      console.log(`  Unassigned spots: ${unassignedCount}`);
      return;
    }

    // APPLY IN A SINGLE TRANSACTION
    console.log('\nApplying import in a single transaction...');
    await client.query('BEGIN');

    // Upsert admin_areas
    const upsertSql = `
      INSERT INTO admin_areas (
        id, psgc_code, level, name, display_name, parent_id, osm_relation_id,
        has_boundary, label_lat, label_lng, bbox, min_zoom, shape_file, data_version, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
      ON CONFLICT (id) DO UPDATE SET
        psgc_code = EXCLUDED.psgc_code,
        level = EXCLUDED.level,
        name = EXCLUDED.name,
        display_name = EXCLUDED.display_name,
        parent_id = EXCLUDED.parent_id,
        has_boundary = EXCLUDED.has_boundary,
        label_lat = EXCLUDED.label_lat,
        label_lng = EXCLUDED.label_lng,
        bbox = EXCLUDED.bbox,
        min_zoom = EXCLUDED.min_zoom,
        shape_file = EXCLUDED.shape_file,
        data_version = EXCLUDED.data_version,
        updated_at = NOW()
    `;

    for (const a of areas) {
      await client.query(upsertSql, [
        a.id,
        a.psgc_code,
        a.level,
        a.name,
        a.display_name,
        a.parent_id,
        a.osm_relation_id,
        a.has_boundary,
        a.label_lat,
        a.label_lng,
        a.bbox,
        a.min_zoom,
        a.shape_file,
        a.data_version,
      ]);
    }
    console.log(`Upserted ${areas.length} admin_areas.`);

    // Assign spots
    const spotRes = await client.query(`SELECT id, municipality, gps_lat, gps_lng FROM spots`);
    let updatedSpots = 0;

    for (const spot of spotRes.rows) {
      const match = matchSpotToAreas(Number(spot.gps_lat), Number(spot.gps_lng), spot.municipality, areas);
      await client.query(
        `UPDATE spots SET town_area_id = $1, barangay_area_id = $2 WHERE id = $3`,
        [match.townAreaId, match.barangayAreaId, spot.id]
      );
      if (match.townAreaId || match.barangayAreaId) {
        updatedSpots++;
      }
    }
    console.log(`Updated ${updatedSpots} / ${spotRes.rows.length} spots with area associations.`);

    await client.query('COMMIT');
    console.log('Transaction committed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
