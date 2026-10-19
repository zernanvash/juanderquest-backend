const fs = require('fs');
const os = require('os');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'jdq-maps/admin-boundaries.geojson'), 'utf8'));
const missing = ['Asingan', 'Bani', 'Burgos', 'Dasol', 'Lingayen', 'Mabini', 'Mangaldan', 'Natividad', 'Pozorrubio', 'San Fabian', 'San Jacinto', 'San Quintin', 'Santa Barbara', 'Sison', 'Umingan'];
const found = {};

for (const f of data.features || []) {
  const p = f.properties || {};
  const name = String(p.name || '');
  const isPoly = f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon');
  if (isPoly) {
    for (const m of missing) {
      if (name.toLowerCase() === m.toLowerCase() || name.toLowerCase().includes(m.toLowerCase())) {
        found[m] = found[m] || [];
        found[m].push({ name, admin_level: p.admin_level, props: p });
      }
    }
  }
}

console.log('Search in Philippines-wide admin-boundaries.geojson:');
console.log(JSON.stringify(found, null, 2));
