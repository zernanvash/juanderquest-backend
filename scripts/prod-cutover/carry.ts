// Plan 116 §9 / §11 step 4: carry the legit data from the old production database into
// the new one, fail-closed. Run in WSL:
//   CARRY_SOURCE_URL=<old db, read-only> CARRY_TARGET_URL=<new db, jdq_owner> \
//     npx tsx scripts/prod-cutover/carry.ts [--dry-run|--apply] [--delta-since <ISO ts>] \
//       [--confirm-file <json>] [--out <dir>] [--manifest <json>]
// --dry-run (default) does everything inside one target transaction and rolls it back.
// --apply commits one transaction per manifest group, then sequences, then ANALYZE.
// Refuses: tables/columns not covered by the manifest, a target that already holds carried
// rows (unless --delta-since), live production (juanderquest_alpha / port 55433), a target
// whose migrations don't verify. URLs, full emails and names are never printed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Client } from 'pg';
import { verifyMigrations } from '../../src/db/migrations.js';
import { assertWritableTarget, connect, currentDatabase, quoteIdent as q } from './lib/db.js';
import { carriedRowsPresent, runEngine, type EngineResult } from './lib/engine.js';
import { introspect, rowCounts } from './lib/introspect.js';
import {
  type Manifest,
  bindPlaceholders,
  csv,
  isCarried,
  parseConfirmFile,
  sha256,
  transferOrder,
  validateManifest,
} from './lib/manifest.js';

const here = __dirname;

export interface CarryArgs {
  apply: boolean;
  deltaSince: string | null;
  confirmFile: string | null;
  out: string;
  manifestPath: string;
}

export function parseArgs(argv: string[]): CarryArgs {
  const args: CarryArgs = {
    apply: false,
    deltaSince: null,
    confirmFile: null,
    out: join(homedir(), 'jdq-seed', 'national-116', 'carry'),
    manifestPath: join(here, 'carry-manifest.json'),
  };
  let sawDry = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') sawDry = true;
    else if (a === '--delta-since') args.deltaSince = parseTimestamp(next());
    else if (a === '--confirm-file') args.confirmFile = resolve(next());
    else if (a === '--out') args.out = resolve(next());
    else if (a === '--manifest') args.manifestPath = resolve(next());
    else throw new Error(`unknown argument ${a}`);
  }
  if (args.apply && sawDry) throw new Error('--apply and --dry-run are exclusive');
  return args;
}

export function parseTimestamp(v: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v))
    throw new Error('--delta-since must be an ISO timestamp with a zone, e.g. 2026-11-20T08:00:00Z');
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error('--delta-since is not a valid timestamp');
  return d.toISOString();
}

export interface CarryRunResult {
  report: CarryReport;
  engine: EngineResult;
}

export interface CarryReport {
  plan: string;
  manifestSha256: string;
  source: string;
  target: string;
  mode: 'dry-run' | 'apply';
  deltaSince: string | null;
  confirm: Record<string, { provided: boolean; ids: number; idsDigest: string }>;
  skippedConfirmGroups: string[];
  order: string[];
  tables: Record<string, unknown>;
  sequences: EngineResult['sequences'];
  totals: EngineResult['totals'];
  warnings: string[];
  run: { startedAt: string; finishedAt: string; durationMs: number; committedGroups: string[] };
}

export async function runCarry(opts: {
  source: Client;
  target: Client;
  manifest: Manifest;
  manifestText: string;
  args: Pick<CarryArgs, 'apply' | 'deltaSince' | 'out'>;
  confirmRaw: unknown | null;
  sourceSchema?: string;
  targetSchema?: string;
  skipVerifyMigrations?: boolean;
  log?: (line: string) => void;
}): Promise<CarryRunResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const started = Date.now();
  const sourceSchema = opts.sourceSchema ?? 'public';
  const targetSchema = opts.targetSchema ?? 'public';
  const { manifest, args } = opts;

  const sourceInfo = await introspect(opts.source, sourceSchema);
  const targetInfo = await introspect(opts.target, targetSchema);
  const errors = validateManifest(manifest, sourceInfo, targetInfo);
  if (errors.length) throw new Error(`manifest does not match the databases:\n  - ${errors.join('\n  - ')}`);
  if (!opts.skipVerifyMigrations) await verifyMigrations(opts.target);

  const groups = Object.keys(manifest.confirmGroups).sort();
  const provided = opts.confirmRaw === null ? {} : parseConfirmFile(opts.confirmRaw, groups);
  const confirm: Record<string, string[]> = {};
  const skippedConfirmGroups: string[] = [];
  for (const g of groups) {
    confirm[g] = provided[g] ?? [];
    if (!provided[g]) skippedConfirmGroups.push(g);
  }
  await checkConfirmEligibility(opts.source, sourceSchema, manifest, confirm);

  const present = await carriedRowsPresent(opts.target, targetSchema, manifest.tables);
  if (!args.deltaSince && Object.keys(present).length)
    throw new Error(
      `target already holds carried rows (${Object.entries(present)
        .map(([t, n]) => `${t}=${n}`)
        .join(', ')}); use --delta-since <rehearsal run start> for the final cutover run`,
    );
  if (args.deltaSince && !Object.keys(present).length)
    throw new Error('--delta-since given but the target holds no carried rows; run a full carry instead');

  const order = transferOrder(manifest.tables, manifest.groups, targetInfo);
  log(
    `[carry] ${args.apply ? 'APPLY' : 'dry-run'}${args.deltaSince ? ` delta-since=${args.deltaSince}` : ''}: ` +
      `${order.length} carried tables in ${manifest.groups.length} groups; confirm groups without a list: ${
        skippedConfirmGroups.join(', ') || 'none'
      }`,
  );
  const engine = await runEngine({
    source: opts.source,
    target: opts.target,
    sourceSchema,
    targetSchema,
    sourceInfo,
    targetInfo,
    tables: manifest.tables,
    order,
    apply: args.apply,
    deltaSince: args.deltaSince,
    confirm,
    log,
  });

  // Owner-facing lists (CSV) and warnings.
  mkdirSync(args.out, { recursive: true });
  const warnings: string[] = [];
  for (const [name, list] of Object.entries(manifest.ownerLists)) {
    const spec = manifest.tables[list.table];
    const rows = await selectList(
      opts.source,
      sourceSchema,
      list.table,
      list.list,
      list.orderBy,
      {
        selected: spec.filter ?? 'TRUE',
      },
      confirm,
    );
    writeFileSync(join(args.out, `${name}.csv`), csv(rows, [...Object.keys(list.list), 'selected']));
    if (name === 'users') {
      const noLogin = rows.filter((r) => isTrue(r.selected) && !isTrue(r.has_email_login));
      if (noLogin.length)
        warnings.push(`${noLogin.length} carried user(s) have no email/password login (wallet links are not carried)`);
    }
    log(`[carry] wrote ${name}.csv (${rows.length} rows, ${rows.filter((r) => isTrue(r.selected)).length} selected)`);
  }
  for (const [g, cg] of Object.entries(manifest.confirmGroups)) {
    const rows = await selectList(
      opts.source,
      sourceSchema,
      cg.table,
      cg.list,
      's.id',
      {
        eligible: cg.eligible,
        confirmed: `s.id::text = ANY({{confirm:${g}}})`,
      },
      confirm,
    );
    writeFileSync(join(args.out, `confirm-${g}.csv`), csv(rows, [...Object.keys(cg.list), 'eligible', 'confirmed']));
    log(
      `[carry] wrote confirm-${g}.csv (${rows.length} rows, ${rows.filter((r) => isTrue(r.eligible)).length} eligible)`,
    );
  }

  // Non-carried tables: counts only (target rows are migration seeds or importer output).
  const others = Object.keys(manifest.tables).filter((n) => !isCarried(manifest.tables[n]));
  const scounts = await rowCounts(
    opts.source,
    others.filter((n) => sourceInfo.tables.has(n)),
    sourceSchema,
  );
  const tcounts = await rowCounts(
    opts.target,
    others.filter((n) => targetInfo.tables.has(n)),
    targetSchema,
  );
  const tables: Record<string, unknown> = {};
  for (const name of Object.keys(manifest.tables).sort()) {
    const spec = manifest.tables[name];
    tables[name] = isCarried(spec)
      ? { reason: spec.reason, ...engine.tables[name] }
      : {
          mode: spec.mode,
          reason: spec.reason,
          sourceRows: scounts.get(name) ?? null,
          targetRows: tcounts.get(name) ?? null,
        };
  }
  for (const [n, r] of Object.entries(engine.tables))
    if (r.outsideDeltaWindow)
      warnings.push(`${n}: ${r.outsideDeltaWindow} new/changed row(s) older than --delta-since`);

  const report: CarryReport = {
    plan: manifest.plan,
    manifestSha256: sha256(opts.manifestText),
    source: await currentDatabase(opts.source),
    target: await currentDatabase(opts.target),
    mode: args.apply ? 'apply' : 'dry-run',
    deltaSince: args.deltaSince,
    confirm: Object.fromEntries(
      groups.map((g) => [
        g,
        { provided: !!provided[g], ids: confirm[g].length, idsDigest: sha256(confirm[g].join('\n')) },
      ]),
    ),
    skippedConfirmGroups,
    order: order.map((t) => `${t.group}/${t.name}`),
    tables,
    sequences: engine.sequences,
    totals: engine.totals,
    warnings,
    run: {
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      committedGroups: engine.committedGroups,
    },
  };
  const stamp = report.run.startedAt.replace(/[:.]/g, '-');
  mkdirSync(join(args.out, 'runs'), { recursive: true });
  const text = JSON.stringify(report, null, 2) + '\n';
  writeFileSync(join(args.out, 'carry-report.json'), text);
  writeFileSync(join(args.out, 'runs', `${stamp}-${report.mode}${args.deltaSince ? '-delta' : ''}.json`), text);
  return { report, engine };
}

const isTrue = (v: unknown) => v === true || v === 't' || v === 'true';

async function selectList(
  source: Client,
  schema: string,
  table: string,
  list: Record<string, string>,
  orderBy: string,
  flags: Record<string, string>,
  confirm: Record<string, string[]>,
) {
  const parts = [
    ...Object.entries(list).map(([k, expr]) => `(${expr}) AS ${q(k)}`),
    ...Object.entries(flags).map(([k, expr]) => `(${expr}) AS ${q(k)}`),
  ].join(', ');
  const bound = bindPlaceholders(`SELECT ${parts} FROM ${q(schema)}.${q(table)} s ORDER BY ${orderBy}`, { confirm });
  return (await source.query(bound.text, bound.params)).rows as Record<string, unknown>[];
}

async function checkConfirmEligibility(
  source: Client,
  schema: string,
  manifest: Manifest,
  confirm: Record<string, string[]>,
) {
  for (const [g, cg] of Object.entries(manifest.confirmGroups)) {
    if (!confirm[g].length) continue;
    const { rows } = await source.query(
      `SELECT x.id FROM unnest($1::text[]) AS x(id)
        WHERE NOT EXISTS (SELECT 1 FROM ${q(schema)}.${q(cg.table)} s WHERE s.id::text = x.id AND (${cg.eligible}))`,
      [confirm[g]],
    );
    if (rows.length)
      throw new Error(
        `confirm file: ${g} lists ${rows.length} id(s) that are missing or not eligible: ${rows.map((r) => r.id).join(', ')}`,
      );
  }
}

export function loadManifest(path: string): { manifest: Manifest; text: string } {
  const text = readFileSync(path, 'utf8');
  return { manifest: JSON.parse(text) as Manifest, text };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceUrl = process.env.CARRY_SOURCE_URL;
  const targetUrl = process.env.CARRY_TARGET_URL;
  if (!sourceUrl || !targetUrl)
    throw new Error('Set CARRY_SOURCE_URL (old DB, read-only) and CARRY_TARGET_URL (new DB).');
  assertWritableTarget(targetUrl, sourceUrl);
  const { manifest, text } = loadManifest(args.manifestPath);
  const confirmRaw = args.confirmFile ? JSON.parse(readFileSync(args.confirmFile, 'utf8')) : null;
  const source = await connect(sourceUrl, 'jdq-carry-source');
  const target = await connect(targetUrl, 'jdq-carry-target');
  try {
    await source.query('SET default_transaction_read_only = on');
    const db = await currentDatabase(target);
    if (db === 'juanderquest_alpha') throw new Error('Refusing target database juanderquest_alpha.');
    const { report } = await runCarry({ source, target, manifest, manifestText: text, args, confirmRaw });
    const t = report.totals;
    console.log(
      `[carry] ${report.mode} done in ${report.run.durationMs} ms: staged=${t.staged} inserted=${t.inserted} ` +
        `updated=${t.updated} fkDropped=${t.fkDropped} fkNulled=${t.fkNulled} changes=${t.changes}`,
    );
    for (const w of report.warnings) console.log(`[carry] WARNING ${w}`);
    console.log(`[carry] report: ${join(args.out, 'carry-report.json')}`);
  } finally {
    await source.end();
    await target.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[carry] REFUSED/FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
