// Plan 116 §11 step 8: 24-hour rollback helper. Copies accounts created or changed on the
// NEW database since the cutover back into the OLD database, users/auth tables only, so a
// rollback (env revert + pm2 restart) doesn't lose sign-ups. Same engine and the manifest's
// "reverse" section: explicit column subsets (points/reputation/wallet/badges/favourite spot
// are never written back), FK closure, existing rows updated (new DB wins for the listed
// columns), unique-key collisions abort the whole run (fail-closed).
//   REVERSE_SOURCE_URL=<new db> REVERSE_TARGET_URL=<old db> \
//     npx tsx scripts/prod-cutover/reverse-carry.ts --since <cutover ISO ts> [--dry-run|--apply]
//       [--source-schema public] [--target-schema public] [--out <dir>]
// Dry-run (default) runs everything in one transaction and rolls back.
// Writing into live production (db juanderquest_alpha / port 55433) additionally needs
// JDQ_OWNER_APPROVED_REVERSE_CARRY=yes (owner OK at that moment). jdq_old_copy is always refused.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Client } from 'pg';
import { loadManifest, parseTimestamp } from './carry.js';
import { FORBIDDEN_TARGET_DATABASES, FORBIDDEN_TARGET_PORTS, connect, currentDatabase, urlFacts } from './lib/db.js';
import { runEngine, type EngineResult } from './lib/engine.js';
import { introspect } from './lib/introspect.js';
import { type Manifest, type TableSpec, sha256, transferOrder, validateCarriedTable } from './lib/manifest.js';

/** Only account tables may ever be written back. */
export const REVERSE_ALLOWED_TABLES = [
  'users',
  'auth_identities',
  'password_credentials',
  'account_emails',
  'discovery_preferences',
  'user_engagement_preferences',
  'user_notification_preferences',
];
/** Columns sanitised by the forward carry; writing them back would clobber old-DB values. */
export const REVERSE_FORBIDDEN_COLUMNS: Record<string, string[]> = {
  users: ['demo_points', 'scout_reputation', 'wallet_address', 'featured_badges', 'favorite_spot_id'],
};

export function reverseTables(manifest: Manifest): Record<string, TableSpec> {
  const out: Record<string, TableSpec> = {};
  for (const [name, r] of Object.entries(manifest.reverse.tables)) {
    if (!REVERSE_ALLOWED_TABLES.includes(name)) throw new Error(`reverse: table ${name} is not an account table`);
    const bad = (REVERSE_FORBIDDEN_COLUMNS[name] ?? []).filter((c) => r.columns.includes(c));
    if (bad.length) throw new Error(`reverse: ${name} must not write back ${bad.join(', ')}`);
    if (!r.filter.includes('{{since}}')) throw new Error(`reverse: ${name} filter must be limited by {{since}}`);
    out[name] = {
      mode: 'carry-filtered',
      group: 'reverse',
      reason: 'reverse carry (24 h rollback)',
      columns: r.columns,
      filter: r.filter,
      existing: 'update',
      onParentMissing: r.onParentMissing,
    };
  }
  return out;
}

export function assertReverseTarget(targetUrl: string, sourceUrl: string, sourceSchema: string, targetSchema: string) {
  const t = urlFacts(targetUrl);
  const s = urlFacts(sourceUrl);
  if (t.database === 'jdq_old_copy') throw new Error('Refusing jdq_old_copy (restored backup, read-only by rule).');
  const live = FORBIDDEN_TARGET_DATABASES.includes(t.database) || FORBIDDEN_TARGET_PORTS.includes(t.port);
  if (live && process.env.JDQ_OWNER_APPROVED_REVERSE_CARRY !== 'yes')
    throw new Error('Target is live production; set JDQ_OWNER_APPROVED_REVERSE_CARRY=yes only with the owner OK.');
  if (!['127.0.0.1', 'localhost'].includes(t.host)) throw new Error('Refusing non-loopback target host.');
  if (s.host === t.host && s.port === t.port && s.database === t.database && sourceSchema === targetSchema)
    throw new Error('Source and target are the same schema.');
}

export async function runReverse(opts: {
  source: Client;
  target: Client;
  manifest: Manifest;
  manifestText: string;
  since: string;
  apply: boolean;
  sourceSchema?: string;
  targetSchema?: string;
  out?: string;
  log?: (line: string) => void;
}): Promise<{ engine: EngineResult; report: Record<string, unknown> }> {
  const started = Date.now();
  const sourceSchema = opts.sourceSchema ?? 'public';
  const targetSchema = opts.targetSchema ?? 'public';
  const tables = reverseTables(opts.manifest);
  const sourceInfo = await introspect(opts.source, sourceSchema);
  const targetInfo = await introspect(opts.target, targetSchema);
  const errors: string[] = [];
  for (const [name, spec] of Object.entries(tables)) {
    const src = sourceInfo.tables.get(name);
    const tgt = targetInfo.tables.get(name);
    if (!src || !tgt) errors.push(`table ${name}: missing in ${src ? 'target' : 'source'}`);
    else errors.push(...validateCarriedTable(name, spec, src, tgt, ['reverse'], { requireFullCoverage: false }));
  }
  if (errors.length) throw new Error(`reverse manifest does not match the databases:\n  - ${errors.join('\n  - ')}`);
  const order = transferOrder(tables, ['reverse'], targetInfo);
  const engine = await runEngine({
    source: opts.source,
    target: opts.target,
    sourceSchema,
    targetSchema,
    sourceInfo,
    targetInfo,
    tables,
    order,
    apply: opts.apply,
    deltaSince: opts.since,
    confirm: {},
    log: opts.log,
  });
  const report = {
    plan: 'Plan 116 §11 step 8 reverse carry',
    manifestSha256: sha256(opts.manifestText),
    source: `${await currentDatabase(opts.source)}.${sourceSchema}`,
    target: `${await currentDatabase(opts.target)}.${targetSchema}`,
    mode: opts.apply ? 'apply' : 'dry-run',
    since: opts.since,
    order: order.map((t) => t.name),
    tables: engine.tables,
    totals: engine.totals,
    run: {
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      committedGroups: engine.committedGroups,
    },
  };
  if (opts.out) {
    mkdirSync(join(opts.out, 'runs'), { recursive: true });
    const text = JSON.stringify(report, null, 2) + '\n';
    writeFileSync(join(opts.out, 'reverse-report.json'), text);
    writeFileSync(
      join(opts.out, 'runs', `${report.run.startedAt.replace(/[:.]/g, '-')}-reverse-${report.mode}.json`),
      text,
    );
  }
  return { engine, report };
}

async function main() {
  const argv = process.argv.slice(2);
  let apply = false;
  let since: string | null = null;
  let sourceSchema = 'public';
  let targetSchema = 'public';
  let out = join(homedir(), 'jdq-seed', 'national-116', 'carry', 'reverse');
  let manifestPath = join(__dirname, 'carry-manifest.json');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--apply') apply = true;
    else if (a === '--dry-run') apply = false;
    else if (a === '--since') since = parseTimestamp(next());
    else if (a === '--source-schema') sourceSchema = next();
    else if (a === '--target-schema') targetSchema = next();
    else if (a === '--out') out = resolve(next());
    else if (a === '--manifest') manifestPath = resolve(next());
    else throw new Error(`unknown argument ${a}`);
  }
  if (!since) throw new Error('--since <cutover timestamp> is required');
  const sourceUrl = process.env.REVERSE_SOURCE_URL;
  const targetUrl = process.env.REVERSE_TARGET_URL;
  if (!sourceUrl || !targetUrl) throw new Error('Set REVERSE_SOURCE_URL (new DB) and REVERSE_TARGET_URL (old DB).');
  assertReverseTarget(targetUrl, sourceUrl, sourceSchema, targetSchema);
  const { manifest, text } = loadManifest(manifestPath);
  const source = await connect(sourceUrl, 'jdq-reverse-carry-source');
  const target = await connect(targetUrl, 'jdq-reverse-carry-target');
  try {
    await source.query('SET default_transaction_read_only = on');
    const { report, engine } = await runReverse({
      source,
      target,
      manifest,
      manifestText: text,
      since,
      apply,
      sourceSchema,
      targetSchema,
      out,
      log: (l) => console.log(l.replace('[carry]', '[reverse]')),
    });
    const t = engine.totals;
    console.log(
      `[reverse] ${report.mode} done: staged=${t.staged} inserted=${t.inserted} updated=${t.updated} ` +
        `fkDropped=${t.fkDropped} changes=${t.changes}; report ${join(out, 'reverse-report.json')}`,
    );
  } finally {
    await source.end();
    await target.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[reverse] REFUSED/FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
