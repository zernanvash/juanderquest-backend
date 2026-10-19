const fs = require('fs');
const readline = require('readline');
const path = require('path');
const os = require('os');

const filePath = path.join(os.homedir(), 'jdq-maps/pangasinan-all.geojson');
const fileStream = fs.createReadStream(filePath);
const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

const results = [];

rl.on('line', (line) => {
  if (line.includes('"name":"Pantal"') || line.includes('"Pantal"')) {
    try {
      const trimmed = line.trim();
      const jsonStr = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
      const feat = JSON.parse(jsonStr);
      if (feat.properties && feat.properties.name === 'Pantal') {
        results.push(feat);
      }
    } catch (e) {}
  }
});

rl.on('close', () => {
  console.log('Exact Pantal features:', JSON.stringify(results, null, 2));
});
