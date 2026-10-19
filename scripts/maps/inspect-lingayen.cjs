const fs = require('fs');
const readline = require('readline');
const os = require('os');
const path = require('path');

const stream = fs.createReadStream(path.join(os.homedir(), 'jdq-maps/pangasinan-all.geojson'));
const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

const lingayen = [];

rl.on('line', (line) => {
  if (line.toLowerCase().includes('lingayen')) {
    try {
      const trimmed = line.trim();
      const jsonStr = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
      const feat = JSON.parse(jsonStr);
      const name = String(feat.properties?.name || '');
      if (name.toLowerCase().includes('lingayen')) {
        lingayen.push({
          geom: feat.geometry?.type,
          name,
          place: feat.properties?.place,
          admin_level: feat.properties?.admin_level,
          boundary: feat.properties?.boundary,
          other: feat.properties,
        });
      }
    } catch (e) {}
  }
});

rl.on('close', () => {
  console.log(`Lingayen matches (${lingayen.length}):`);
  console.log(JSON.stringify(lingayen, null, 2));
});
