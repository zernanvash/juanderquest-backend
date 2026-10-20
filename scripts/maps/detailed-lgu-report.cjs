const fs = require('fs');
const readline = require('readline');
const path = require('path');
const os = require('os');

// 1. Read KNOWN_AREAS
const areasPath = '/mnt/c/Users/HP/Desktop/Code/JuanderQuest/web_app/src/lib/areas.ts';
const areasContent = fs.readFileSync(areasPath, 'utf8');
const knownLgus = [];
const areaRegex = /id:\s*['"]([^'"]+)['"],\s*name:\s*['"]([^'"]+)['"],\s*type:\s*['"](city|municipality)['"]/g;
let m;
while ((m = areaRegex.exec(areasContent)) !== null) {
  knownLgus.push({ id: m[1], name: m[2], type: m[3] });
}

// 2. Scan pangasinan-all.geojson
const geojsonPath = path.join(os.homedir(), 'jdq-maps/pangasinan-all.geojson');
const stream = fs.createReadStream(geojsonPath);
const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

const lguStats = {};
for (const lgu of knownLgus) {
  lguStats[lgu.name] = {
    id: lgu.id,
    type: lgu.type,
    hasLguPolygon: false,
    osmAdminLevel: null,
    barangayPolygonCount: 0,
    barangayPointCount: 0,
    sampleBarangays: [],
  };
}

let totalBarangayPolysInPang = 0;
let totalBarangayPointsInPang = 0;
let pantalDetails = null;

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{"type":"Feature"') && !trimmed.startsWith('{"geometry"')) return;

  let feat;
  try {
    const jsonStr = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
    feat = JSON.parse(jsonStr);
  } catch (e) {
    return;
  }

  const p = feat.properties || {};
  const name = String(p.name || '').trim();
  const adminLevel = String(p.admin_level || '');
  const place = String(p.place || '');
  const geomType = feat.geometry?.type;
  const isPoly = geomType === 'Polygon' || geomType === 'MultiPolygon';

  // Match LGU boundary
  if (isPoly && (adminLevel === '6' || adminLevel === '7' || p.boundary === 'administrative')) {
    if (!p.amenity && !p.building && !p.office) {
      for (const lgu of knownLgus) {
        const norm = lgu.name.toLowerCase().replace(/ city$/, '');
        if (name.toLowerCase() === lgu.name.toLowerCase() || name.toLowerCase() === norm || name.toLowerCase() === `municipality of ${norm}`) {
          lguStats[lgu.name].hasLguPolygon = true;
          lguStats[lgu.name].osmAdminLevel = adminLevel;
        }
      }
    }
  }

  // Check Pantal
  if (name.toLowerCase() === 'pantal') {
    if (p['is_in:city'] === 'Dagupan' || (p.postal_code === '2400') || p.is_in?.includes('Dagupan')) {
      pantalDetails = {
        name: p.name,
        geomType,
        admin_level: p.admin_level,
        place: p.place,
        postal_code: p.postal_code,
        coords: feat.geometry?.coordinates,
      };
    }
  }

  // Check Barangays
  if (adminLevel === '10' || place === 'village' || place === 'quarter' || p['admin_type:PH'] === 'barangay') {
    const parent = p['is_in:city'] || p['is_in:town'] || p['is_in:municipality'] || p.is_in || '';
    for (const lgu of knownLgus) {
      const norm = lgu.name.toLowerCase().replace(/ city$/, '');
      if (parent.toLowerCase().includes(norm) || (p['addr:city'] && p['addr:city'].toLowerCase().includes(norm))) {
        if (isPoly) {
          lguStats[lgu.name].barangayPolygonCount++;
          totalBarangayPolysInPang++;
        } else {
          lguStats[lgu.name].barangayPointCount++;
          totalBarangayPointsInPang++;
        }
        if (lguStats[lgu.name].sampleBarangays.length < 5) {
          lguStats[lgu.name].sampleBarangays.push(`${name} (${isPoly ? 'poly' : 'pt'})`);
        }
        break;
      }
    }
  }
});

rl.on('close', () => {
  console.log(JSON.stringify({
    totalLgus: knownLgus.length,
    totalBarangayPolysInPang,
    totalBarangayPointsInPang,
    pantalDetails,
    lguStats,
  }, null, 2));
});
