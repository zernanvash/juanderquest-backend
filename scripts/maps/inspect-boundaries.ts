import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const jsonPath = path.join(os.homedir(), 'jdq-maps/admin-boundaries.geojson');
console.log('Loading GeoJSON from:', jsonPath);

const raw = fs.readFileSync(jsonPath, 'utf8');
const data = JSON.parse(raw);

const levels: Record<string, number> = {};
const pantal: any[] = [];
const pangasinan: any[] = [];

for (const f of data.features || []) {
  const p = f.properties || {};
  const lvl = String(p.admin_level || 'undefined');
  levels[lvl] = (levels[lvl] || 0) + 1;

  const name = String(p.name || '');
  if (name.toLowerCase().includes('pantal')) {
    pantal.push(p);
  }

  // Check if Pangasinan is mentioned anywhere in properties
  let inPang = false;
  for (const val of Object.values(p)) {
    if (typeof val === 'string' && val.toLowerCase().includes('pangasinan')) {
      inPang = true;
      break;
    }
  }
  if (inPang) {
    pangasinan.push(p);
  }
}

console.log('Total features:', data.features?.length);
console.log('Admin level distribution:', levels);
console.log('Pangasinan-related features count:', pangasinan.length);
console.log('Pantal matches:', pantal);

// Sample Pangasinan admin_levels
const pangLevels: Record<string, number> = {};
for (const p of pangasinan) {
  const lvl = String(p.admin_level || 'undefined');
  pangLevels[lvl] = (pangLevels[lvl] || 0) + 1;
}
console.log('Pangasinan features by admin_level:', pangLevels);
