import fs from 'node:fs';
import readline from 'node:readline';
import { pointInMultiPolygon, pointInPolygon } from '../../src/maps/geometry.js';

const arg = (key: string) => process.argv.find((value) => value.startsWith(`${key}=`))?.slice(key.length + 1) ??
  (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined);

async function main() {
  const input = arg('--input'), areaFile = arg('--area'), areaId = arg('--area-id'), output = arg('--output');
  if (!input || !areaFile || !areaId || !output) throw new Error('Usage: filter-candidates-by-area.ts --input <jsonl> --area <geojson> --area-id <id> --output <jsonl>');
  const collection = JSON.parse(fs.readFileSync(areaFile, 'utf8'));
  const feature = collection.features.find((item: any) => String(item.properties?.id || item.id) === areaId);
  if (!feature?.geometry) throw new Error(`Area feature ${areaId} was not found or has no polygon geometry.`);
  const out = fs.createWriteStream(output, { flags: 'w' });
  let seen = 0, kept = 0;
  for await (const line of readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    seen++;
    const candidate = JSON.parse(line);
    const inside = feature.geometry.type === 'Polygon'
      ? pointInPolygon(candidate.gps_lng, candidate.gps_lat, feature.geometry.coordinates)
      : feature.geometry.type === 'MultiPolygon'
        ? pointInMultiPolygon(candidate.gps_lng, candidate.gps_lat, feature.geometry.coordinates)
        : false;
    if (inside) { out.write(`${JSON.stringify(candidate)}\n`); kept++; }
  }
  await new Promise<void>((resolve, reject) => { out.once('error', reject); out.end(resolve); });
  process.stdout.write(`AREA_FILTER=${areaId} INPUT=${seen} KEPT=${kept} OUTPUT=${output}\n`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
