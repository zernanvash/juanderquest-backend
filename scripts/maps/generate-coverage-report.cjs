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
console.log(`Found ${knownLgus.length} cities/municipalities in KNOWN_AREAS.`);

// 2. Scan pangasinan-all.geojson
const geojsonPath = path.join(os.homedir(), 'jdq-maps/pangasinan-all.geojson');
const stream = fs.createReadStream(geojsonPath);
const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

const lguPolygons = new Map(); // name -> feat
const lguPoints = new Map(); // name -> feat
const barangayPolygons = new Map(); // lguName -> list of feats
const barangayPoints = new Map(); // lguName -> list of feats
let pantalFound = null;

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

  // Check Pantal
  if (name.toLowerCase() === 'pantal') {
    if (p['is_in:city'] === 'Dagupan' || p['is_in:town'] === 'Dagupan' || (p.postal_code === '2400')) {
      pantalFound = { geomType, props: p, coords: feat.geometry?.coordinates };
    }
  }

  // City / Municipality detection
  // In PH OSM: admin_level 6 (province or chartered city/independent city) or 7 (municipality/component city)
  // or place=city/town
  if (isPoly && (adminLevel === '6' || adminLevel === '7' || p.boundary === 'administrative')) {
    // Avoid barangay halls or buildings
    if (!p.amenity && !p.building && !p.office) {
      lguPolygons.set(name.toLowerCase(), feat);
    }
  } else if (!isPoly && (place === 'city' || place === 'town' || adminLevel === '6' || adminLevel === '7')) {
    lguPoints.set(name.toLowerCase(), feat);
  }

  // Barangay detection: admin_level 10 or place=village/quarter/suburb
  if (adminLevel === '10' || place === 'village' || place === 'quarter' || p['admin_type:PH'] === 'barangay') {
    const parent = p['is_in:city'] || p['is_in:town'] || p['is_in:municipality'] || p.is_in || '';
    if (isPoly) {
      if (!barangayPolygons.has(parent)) barangayPolygons.set(parent, []);
      barangayPolygons.get(parent).push({ name, geomType, props: p });
    } else {
      if (!barangayPoints.has(parent)) barangayPoints.set(parent, []);
      barangayPoints.get(parent).push({ name, geomType, props: p });
    }
  }
});

rl.on('close', () => {
  console.log('\n=== LGU Coverage Analysis ===');
  console.log(`LGU Polygons extracted: ${lguPolygons.size}`);
  console.log(`LGU Point nodes extracted: ${lguPoints.size}`);

  const matchedLgus = [];
  const missingLgus = [];

  for (const lgu of knownLgus) {
    const normName = lgu.name.toLowerCase().replace(/ city$/, '');
    let found = false;
    for (const [osmName, feat] of lguPolygons.entries()) {
      if (osmName === normName || osmName === lgu.name.toLowerCase() || osmName.includes(normName)) {
        matchedLgus.push({ lgu, osmName, hasPoly: true });
        found = true;
        break;
      }
    }
    if (!found) {
      for (const [osmName, feat] of lguPoints.entries()) {
        if (osmName === normName || osmName === lgu.name.toLowerCase() || osmName.includes(normName)) {
          matchedLgus.push({ lgu, osmName, hasPoly: false });
          found = true;
          break;
        }
      }
    }
    if (!found) {
      missingLgus.push(lgu);
    }
  }

  console.log(`Matched LGUs from KNOWN_AREAS: ${matchedLgus.length} / ${knownLgus.length}`);
  console.log(`Unmatched / Missing LGUs: ${missingLgus.length}`);
  if (missingLgus.length > 0) {
    console.log('Missing LGUs:', missingLgus.map(l => l.name));
  }

  console.log('\n=== Pantal (Dagupan City) Status ===');
  console.log(JSON.stringify(pantalFound, null, 2));

  console.log('\n=== Barangay Coverage Samples ===');
  console.log('Barangay polygon groups:', Array.from(barangayPolygons.keys()).slice(0, 15));
  console.log('Barangay point groups:', Array.from(barangayPoints.keys()).slice(0, 15));
});
