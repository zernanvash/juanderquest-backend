const fs = require('fs');
const readline = require('readline');
const os = require('os');
const path = require('path');

const filePath = path.join(os.homedir(), 'jdq-maps/pangasinan-all.geojson');
console.log('Streaming analysis of:', filePath);

const fileStream = fs.createReadStream(filePath);
const rl = readline.createInterface({
  input: fileStream,
  crlfDelay: Infinity,
});

let totalFeatures = 0;
const pantalMatches = [];
const adminCounts = {};
const placeCounts = {};
const townMatches = new Map();

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{"type":"Feature"') && !trimmed.startsWith('{"geometry"')) {
    return;
  }
  totalFeatures++;

  let feat;
  try {
    const jsonStr = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
    feat = JSON.parse(jsonStr);
  } catch (e) {
    return;
  }

  const p = feat.properties || {};
  const name = String(p.name || '');
  const lowerName = name.toLowerCase();

  if (p.admin_level) {
    adminCounts[p.admin_level] = (adminCounts[p.admin_level] || 0) + 1;
  }
  if (p.place) {
    placeCounts[p.place] = (placeCounts[p.place] || 0) + 1;
  }

  if (lowerName.includes('pantal')) {
    pantalMatches.push({
      name: p.name,
      admin_level: p.admin_level,
      place: p.place,
      boundary: p.boundary,
      geometryType: feat.geometry?.type,
      allProps: p,
    });
  }

  // Check if admin_level 6 or 7
  if (p.admin_level === '6' || p.admin_level === '7' || p.boundary === 'administrative') {
    if (feat.geometry?.type === 'Polygon' || feat.geometry?.type === 'MultiPolygon') {
      townMatches.set(name, (townMatches.get(name) || 0) + 1);
    }
  }
});

rl.on('close', () => {
  console.log('Analysis complete!');
  console.log('Total features:', totalFeatures);
  console.log('Admin level counts:', adminCounts);
  console.log('Place counts:', placeCounts);
  console.log('\nPantal matches count:', pantalMatches.length);
  console.log('Pantal matches detail:', JSON.stringify(pantalMatches, null, 2));
  console.log('\nTown polygon matches count:', townMatches.size);
  console.log('Town polygon samples:', Array.from(townMatches.entries()).slice(0, 30));
});
