import fs from 'node:fs';
import readline from 'node:readline';
import { normalizeOsmFeature } from '../../src/seed/normalize.js';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

async function main() {
  const input = arg('--input'), output = arg('--output'), wave = arg('--wave', 'national-preview');
  if (!input || !output) throw new Error('Usage: extract-osm-to-candidates.ts --input <geojsonseq> --output <jsonl> [--wave <name>]');
  const out = fs.createWriteStream(output, { flags: 'w' });
  let seen = 0, kept = 0;
  for await (const line of readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity })) {
    const text = line.replace(/^\u001e/, '').trim();
    if (!text) continue;
    seen++;
    let feature: unknown;
    try { feature = JSON.parse(text); } catch { continue; }
    const candidate = normalizeOsmFeature(feature as any, wave);
    if (candidate) { out.write(`${JSON.stringify(candidate)}\n`); kept++; }
  }
  await new Promise<void>((resolve, reject) => { out.once('error', reject); out.end(resolve); });
  process.stdout.write(`OSM_FEATURES=${seen} DESTINATION_CANDIDATES=${kept} OUTPUT=${output}\n`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
