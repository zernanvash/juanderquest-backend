const fs = require('fs');
const https = require('https');
const path = require('path');

const townsFile = '/home/kaizo/jdq-maps/pangasinan-faeldon-towns.json';
const towns = JSON.parse(fs.readFileSync(townsFile, 'utf8')).features;
console.log(`Processing ${towns.length} towns in Pangasinan...`);

const outputDir = '/home/kaizo/jdq-maps/faeldon-bgys';
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function run() {
  const allBarangays = [];
  let downloadedCount = 0;

  for (const t of towns) {
    const psgc = t.properties.adm3_psgc;
    const name = t.properties.adm3_en;
    const url = `https://raw.githubusercontent.com/faeldon/philippines-json-maps/master/2023/geojson/municities/hires/bgysubmuns-municity-${psgc}.0.1.json`;
    try {
      const geojson = await fetchJson(url);
      if (geojson.features) {
        allBarangays.push(...geojson.features);
        downloadedCount++;
        process.stdout.write(`\rDownloaded ${downloadedCount}/${towns.length} towns (${allBarangays.length} barangays total)`);
      }
    } catch (err) {
      console.error(`\nFailed for ${name} (${psgc}):`, err.message);
    }
  }

  console.log(`\nDone! Total barangay polygon features gathered: ${allBarangays.length}`);
  const combined = {
    type: 'FeatureCollection',
    features: allBarangays,
  };
  fs.writeFileSync('/home/kaizo/jdq-maps/pangasinan-psa-barangays-raw.json', JSON.stringify(combined));
  console.log('Saved raw combined barangays to /home/kaizo/jdq-maps/pangasinan-psa-barangays-raw.json');
}

run().catch(console.error);
