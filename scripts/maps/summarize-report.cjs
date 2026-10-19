const fs = require('fs');
const os = require('os');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'jdq-maps/detailed-lgu-report.json'), 'utf8'));

let polyLgus = 0;
let pointOnlyLgus = 0;
const entries = Object.entries(data.lguStats);

for (const [name, s] of entries) {
  if (s.hasLguPolygon) polyLgus++;
  else pointOnlyLgus++;
}

console.log('Total LGUs:', entries.length);
console.log('LGUs with Boundary Polygons in OSM:', polyLgus);
console.log('LGUs with Point nodes only:', pointOnlyLgus);

const missing = entries.filter(([n, s]) => !s.hasLguPolygon).map(([n, s]) => n);
console.log('LGUs missing polygon:', missing);

const lgusWithBarangayPolys = entries.filter(([n, s]) => s.barangayPolygonCount > 0);
console.log(`LGUs with at least one barangay boundary polygon (${lgusWithBarangayPolys.length}):`);
for (const [n, s] of lgusWithBarangayPolys) {
  console.log(`  - ${n}: ${s.barangayPolygonCount} barangay polygons, ${s.barangayPointCount} point nodes`);
}

const lgusWithOnlyBarangayPoints = entries.filter(([n, s]) => s.barangayPolygonCount === 0 && s.barangayPointCount > 0);
console.log(`LGUs with ONLY barangay point nodes (${lgusWithOnlyBarangayPoints.length}):`);
for (const [n, s] of lgusWithOnlyBarangayPoints) {
  console.log(`  - ${n}: 0 polygons, ${s.barangayPointCount} point nodes`);
}

const lgusWithNoBarangays = entries.filter(([n, s]) => s.barangayPolygonCount === 0 && s.barangayPointCount === 0);
console.log(`LGUs with no barangay data at all in OSM (${lgusWithNoBarangays.length}):`);
for (const [n, s] of lgusWithNoBarangays) {
  console.log(`  - ${n}`);
}
