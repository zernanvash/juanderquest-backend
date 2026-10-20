const fs = require('fs');
const readline = require('readline');

const rl = readline.createInterface({
  input: fs.createReadStream('/home/kaizo/jdq-maps/pangasinan-all.geojson'),
  crlfDelay: Infinity,
});

const townFeatures = [];
const barangayFeatures = [];

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
  const isPoly = feat.geometry?.type === 'Polygon' || feat.geometry?.type === 'MultiPolygon';
  if (!isPoly) return;

  const adminLevel = String(p.admin_level || '');
  if (adminLevel === '6' || adminLevel === '7') {
    if (!p.amenity && !p.building && !p.office) {
      townFeatures.push(feat);
    }
  } else if (adminLevel === '10' || p['admin_type:PH'] === 'barangay') {
    barangayFeatures.push(feat);
  }
});

rl.on('close', () => {
  fs.writeFileSync(
    '/home/kaizo/jdq-maps/areas/towns.geojson',
    JSON.stringify({ type: 'FeatureCollection', features: townFeatures })
  );
  fs.writeFileSync(
    '/home/kaizo/jdq-maps/areas/barangays.geojson',
    JSON.stringify({ type: 'FeatureCollection', features: barangayFeatures })
  );
  console.log(`Towns polygons: ${townFeatures.length}, Barangays polygons: ${barangayFeatures.length}`);
});
