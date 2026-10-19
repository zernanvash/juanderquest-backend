const fs = require('fs');
const readline = require('readline');
const os = require('os');
const path = require('path');

const stream = fs.createReadStream(path.join(os.homedir(), 'jdq-maps/pangasinan-all.geojson'));
const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

const lingayenTown = [];

rl.on('line', (line) => {
  if (line.includes('"name":"Lingayen"')) {
    try {
      const trimmed = line.trim();
      const jsonStr = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
      const feat = JSON.parse(jsonStr);
      if (feat.properties && feat.properties.name === 'Lingayen') {
        lingayenTown.push({
          type: feat.geometry?.type,
          coords: feat.geometry?.coordinates,
          props: feat.properties,
        });
      }
    } catch (e) {}
  }
});

rl.on('close', () => {
  console.log('Lingayen exact features:');
  console.log(JSON.stringify(lingayenTown, null, 2));
});
