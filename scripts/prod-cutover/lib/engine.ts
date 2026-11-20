// Plan 116 §9: the carry engine. Streams explicit columns from a source schema into
// temp staging tables on the target connection, enforces FK closure there (drop + count,
// or NULL only where the manifest says so), then writes each group in one transaction.
// Used forward (old DB -> new DB, carry.ts) and backward (reverse-carry.ts).
import type { Client } from 'pg';
import { quoteIdent as q } from './db.js';
import type { SchemaInfo, TableInfo } from './introspect.js';
import {
  type ExistingPolicy,
  type OrderedTable,
  type TableSpec,
  bindPlaceholders,
  fkLabel,
  isCarried,
  sha256,
} from './manifest.js';

export interface EngineOptions {
  source: Client;
  target: Client;
  sourceSchema: string;
  targetSchema: string;
  sourceInfo: SchemaInfo;
  targetInfo: SchemaInfo;
  tables: Record<string, TableSpec>;
  order: OrderedTable[];
  apply: boolean;
  /** Delta run: existing rows are compared and updated instead of refused. */
  deltaSince: string | null;
  confirm: Record<string, string[]>;
  batchSize?: number;
  log?: (line: string) => void;
}

export interface TableReport {
  mode: string;
  group: string;
  existingPolicy: ExistingPolicy;
  sourceRows: number;
  filteredOut: number;
  staged: number;
  fkDropped: Record<string, number>;
  fkNulled: Record<string, number>;
  carried: number;
  inserted: number;
  updated: number;
  unchanged: number;
  keptDifferent: number;
  deferredUpdated: number;
  outsideDeltaWindow: number;
  targetRowsBefore: number;
  targetRowsAfter: number;
  keyDigest: string;
  rowDigest: string;
}

export interface EngineResult {
  tables: Record<string, TableReport>;
  sequences: Record<string, { before: string | null; after: string | null }>;
  committedGroups: string[];
  totals: {
    sourceRows: number;
    filteredOut: number;
    staged: number;
    fkDropped: number;
    fkNulled: number;
    inserted: number;
    updated: number;
    changes: number;
  };
}

const stg = (t: string) => q(`carry_stg_${t}`);

export async function runEngine(o: EngineOptions): Promise<EngineResult> {
  const log = o.log ?? (() => undefined);
  const batchSize = o.batchSize ?? 1000;
  const S = q(o.sourceSchema);
  const T = q(o.targetSchema);
  const result: EngineResult = {
    tables: {},
    sequences: {},
    committedGroups: [],
    totals: {
      sourceRows: 0,
      filteredOut: 0,
      staged: 0,
      fkDropped: 0,
      fkNulled: 0,
      inserted: 0,
      updated: 0,
      changes: 0,
    },
  };

  // One consistent snapshot of the source for every table.
  await o.source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let inTargetTx = false;
  const beginTarget = async () => {
    if (!inTargetTx) {
      await o.target.query('BEGIN');
      inTargetTx = true;
    }
  };
  try {
    if (!o.apply) await beginTarget(); // dry-run: everything in one transaction, rolled back.
    const groups = [...new Set(o.order.map((t) => t.group))];
    for (const group of groups) {
      await beginTarget();
      for (const { name } of o.order.filter((t) => t.group === group)) {
        const r = await processTable(o, name, S, T, batchSize);
        result.tables[name] = r;
        log(
          `[carry] ${group}/${name}: source=${r.sourceRows} filtered=${r.filteredOut} staged=${r.staged} ` +
            `fkDropped=${sum(r.fkDropped)} fkNulled=${sum(r.fkNulled)} inserted=${r.inserted} updated=${r.updated} unchanged=${r.unchanged}`,
        );
      }
      if (o.apply) {
        await o.target.query('COMMIT');
        inTargetTx = false;
        result.committedGroups.push(group);
      }
    }

    // Deferred FK columns (cycle breakers), sequences: one final transaction.
    await beginTarget();
    for (const { name } of o.order) {
      const spec = o.tables[name];
      for (const col of spec.deferred ?? []) {
        const r = result.tables[name];
        const { updated, nulled } = await applyDeferred(o, name, col, T);
        r.deferredUpdated += updated;
        r.fkNulled[col] = (r.fkNulled[col] ?? 0) + nulled;
        log(`[carry] deferred ${name}.${col}: updated=${updated} nulled=${nulled}`);
      }
    }
    result.sequences = await bumpSequences(o.target, o.targetSchema, o.targetInfo);
    for (const [name, r] of Object.entries(result.tables)) {
      const { rows } = await o.target.query(`SELECT count(*)::bigint AS n FROM ${T}.${q(name)}`);
      r.targetRowsAfter = Number(rows[0].n);
    }
    if (o.apply) {
      await o.target.query('COMMIT');
      inTargetTx = false;
      result.committedGroups.push('deferred+sequences');
    } else {
      await o.target.query('ROLLBACK');
      inTargetTx = false;
    }
  } catch (error) {
    if (inTargetTx) await o.target.query('ROLLBACK').catch(() => undefined);
    const committed = result.committedGroups.length
      ? ` (already committed groups: ${result.committedGroups.join(', ')})`
      : '';
    throw new Error(`${error instanceof Error ? error.message : String(error)}${committed}`);
  } finally {
    await o.source.query('ROLLBACK').catch(() => undefined);
    for (const { name } of o.order)
      await o.target.query(`DROP TABLE IF EXISTS pg_temp.${stg(name)}`).catch(() => undefined);
  }

  if (o.apply) for (const { name } of o.order) await o.target.query(`ANALYZE ${T}.${q(name)}`);

  for (const r of Object.values(result.tables)) {
    const t = result.totals;
    t.sourceRows += r.sourceRows;
    t.filteredOut += r.filteredOut;
    t.staged += r.staged;
    t.fkDropped += sum(r.fkDropped);
    t.fkNulled += sum(r.fkNulled);
    t.inserted += r.inserted;
    t.updated += r.updated;
    t.changes += r.inserted + r.updated + r.deferredUpdated;
  }
  return result;
}

const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);

function policyFor(spec: TableSpec, delta: boolean): ExistingPolicy {
  const p = spec.existing ?? 'error';
  if (delta && p === 'error') return 'update';
  return p;
}

async function processTable(
  o: EngineOptions,
  name: string,
  S: string,
  T: string,
  batchSize: number,
): Promise<TableReport> {
  const spec = o.tables[name];
  const tgt = o.targetInfo.tables.get(name) as TableInfo;
  const cols = spec.columns as string[];
  const deferred = new Set(spec.deferred ?? []);
  const mainCols = cols.filter((c) => !deferred.has(c));
  const key = tgt.primaryKey;
  const transform = spec.transform ?? {};
  const policy = policyFor(spec, !!o.deltaSince);
  const report: TableReport = {
    mode: spec.mode,
    group: spec.group as string,
    existingPolicy: policy,
    sourceRows: 0,
    filteredOut: 0,
    staged: 0,
    fkDropped: {},
    fkNulled: {},
    carried: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    keptDifferent: 0,
    deferredUpdated: 0,
    outsideDeltaWindow: 0,
    targetRowsBefore: 0,
    targetRowsAfter: 0,
    keyDigest: '',
    rowDigest: '',
  };
  const tq = `${T}.${q(name)}`;
  report.targetRowsBefore = Number((await o.target.query(`SELECT count(*)::bigint AS n FROM ${tq}`)).rows[0].n);
  report.sourceRows = Number((await o.source.query(`SELECT count(*)::bigint AS n FROM ${S}.${q(name)}`)).rows[0].n);

  // 1. Stage: same column types as the target, no constraints.
  const colList = cols.map(q).join(', ');
  await o.target.query(`DROP TABLE IF EXISTS pg_temp.${stg(name)}`);
  await o.target.query(`CREATE TEMP TABLE ${stg(name)} AS SELECT ${colList} FROM ${tq} WITH NO DATA`);
  const jsonCols = new Set(tgt.columns.filter((c) => c.type === 'json' || c.type === 'jsonb').map((c) => c.name));

  const where = bindPlaceholders(spec.filter ?? 'TRUE', { confirm: o.confirm, since: o.deltaSince });
  const selectList = cols.map((c) => `${c in transform ? `(${transform[c]})` : `s.${q(c)}`} AS ${q(c)}`).join(', ');
  const orderBy = key.map((k) => `s.${q(k)}`).join(', ');
  const cursor = q(`carry_cur_${name}`);
  await o.source.query(
    `DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT ${selectList} FROM ${S}.${q(name)} s WHERE (${where.text}) ORDER BY ${orderBy}`,
    where.params,
  );
  for (;;) {
    const { rows } = await o.source.query(`FETCH ${batchSize} FROM ${cursor}`);
    if (!rows.length) break;
    for (const row of rows) for (const c of jsonCols) if (typeof row[c] === 'string') row[c] = JSON.parse(row[c]);
    await o.target.query(
      `INSERT INTO ${stg(name)} (${colList}) SELECT ${colList} FROM json_populate_recordset(NULL::pg_temp.${stg(name)}, $1::json)`,
      [JSON.stringify(rows)],
    );
    report.staged += rows.length;
  }
  await o.source.query(`CLOSE ${cursor}`);
  report.filteredOut = report.sourceRows - report.staged;

  // 2. FK closure against what the target now holds (parents were carried earlier).
  for (let pass = 0; pass < 100; pass++) {
    let changed = 0;
    for (const fk of tgt.foreignKeys) {
      if (!fk.columns.every((c) => cols.includes(c))) continue;
      if (fk.columns.some((c) => deferred.has(c))) continue;
      const parent = `${T}.${q(fk.refTable)}`;
      const match = fk.columns.map((c, i) => `p.${q(fk.refColumns[i])} = x.${q(c)}`).join(' AND ');
      const self = fk.refTable === name ? ` OR EXISTS (SELECT 1 FROM pg_temp.${stg(name)} p WHERE ${match})` : '';
      const exists = `(EXISTS (SELECT 1 FROM ${parent} p WHERE ${match})${self})`;
      const notNull = fk.columns.map((c) => `x.${q(c)} IS NOT NULL`).join(' AND ');
      const nullRule = fk.columns.length === 1 && spec.onParentMissing?.[fk.columns[0]] === 'null';
      if (nullRule) {
        const c = fk.columns[0];
        const r = await o.target.query(
          `UPDATE pg_temp.${stg(name)} x SET ${q(c)} = NULL WHERE ${notNull} AND NOT ${exists}`,
        );
        if (r.rowCount) report.fkNulled[c] = (report.fkNulled[c] ?? 0) + r.rowCount;
        changed += r.rowCount ?? 0;
      } else {
        const r = await o.target.query(`DELETE FROM pg_temp.${stg(name)} x WHERE ${notNull} AND NOT ${exists}`);
        const label = fkLabel(fk);
        if (r.rowCount) report.fkDropped[label] = (report.fkDropped[label] ?? 0) + r.rowCount;
        changed += r.rowCount ?? 0;
      }
    }
    if (!changed) break;
    if (pass === 99) throw new Error(`${name}: FK closure did not converge`);
  }
  report.carried = Number((await o.target.query(`SELECT count(*)::bigint AS n FROM pg_temp.${stg(name)}`)).rows[0].n);

  // 3. Deterministic digests of what is carried (key columns, and key + full carried row).
  const keyExpr = `concat_ws('|', ${key.map((k) => `x.${q(k)}::text`).join(', ')})`;
  const rowExpr = `ROW(${cols.map((c) => `x.${q(c)}`).join(', ')})::text`;
  const { rows: dig } = await o.target.query(
    `SELECT coalesce(string_agg(${keyExpr}, E'\\n' ORDER BY ${keyExpr} COLLATE "C"), '') AS keys,
            coalesce(string_agg(${keyExpr} || ' ' || md5(${rowExpr}), E'\\n' ORDER BY ${keyExpr} COLLATE "C"), '') AS rowsig
       FROM pg_temp.${stg(name)} x`,
  );
  report.keyDigest = sha256(dig[0].keys);
  report.rowDigest = sha256(dig[0].rowsig);

  // 4. Write.
  const keyMatch = key.map((k) => `t.${q(k)} = x.${q(k)}`).join(' AND ');
  const existsInTarget = `EXISTS (SELECT 1 FROM ${tq} t WHERE ${keyMatch})`;
  const distinct = `ROW(${mainCols.map((c) => `t.${q(c)}`).join(', ')}) IS DISTINCT FROM ROW(${mainCols
    .map((c) => `x.${q(c)}`)
    .join(', ')})`;
  const { rows: cls } = await o.target.query(
    `SELECT count(*) FILTER (WHERE t.${q(key[0])} IS NOT NULL)::bigint AS existing,
            count(*) FILTER (WHERE t.${q(key[0])} IS NOT NULL AND ${distinct})::bigint AS different
       FROM pg_temp.${stg(name)} x LEFT JOIN ${tq} t ON ${keyMatch}`,
  );
  const existing = Number(cls[0].existing);
  const different = Number(cls[0].different);
  if (policy === 'error' && existing > 0)
    throw new Error(`${name}: ${existing} carried keys already exist in the target (existing: "error")`);
  if (o.deltaSince)
    report.outsideDeltaWindow = await countOutsideWindow(o, name, tgt, mainCols, distinct, keyMatch, tq);
  if (policy === 'update' && different > 0) {
    const set = mainCols.filter((c) => !key.includes(c)).map((c) => `${q(c)} = x.${q(c)}`);
    if (set.length) {
      const r = await o.target.query(
        `UPDATE ${tq} t SET ${set.join(', ')} FROM pg_temp.${stg(name)} x WHERE ${keyMatch} AND ${distinct}`,
      );
      report.updated = r.rowCount ?? 0;
    }
  }
  report.unchanged = existing - different;
  if (policy === 'keep') report.keptDifferent = different;
  const mainList = mainCols.map(q).join(', ');
  const ins = await o.target.query(
    `INSERT INTO ${tq} (${mainList}) SELECT ${mainCols.map((c) => `x.${q(c)}`).join(', ')}
       FROM pg_temp.${stg(name)} x WHERE NOT ${existsInTarget} ORDER BY ${key.map((k) => `x.${q(k)}`).join(', ')}`,
  );
  report.inserted = ins.rowCount ?? 0;
  return report;
}

/** Delta runs: changed/new rows whose own timestamps are older than --delta-since (should be 0). */
async function countOutsideWindow(
  o: EngineOptions,
  name: string,
  tgt: TableInfo,
  mainCols: string[],
  distinct: string,
  keyMatch: string,
  tq: string,
): Promise<number> {
  const stamps = ['updated_at', 'created_at'].filter((c) => mainCols.includes(c));
  if (!stamps.length) return 0;
  const newest = stamps.length === 2 ? `GREATEST(x.updated_at, x.created_at)` : `x.${q(stamps[0])}`;
  const { rows } = await o.target.query(
    `SELECT count(*)::bigint AS n FROM pg_temp.${stg(name)} x LEFT JOIN ${tq} t ON ${keyMatch}
      WHERE (t.${q(tgt.primaryKey[0])} IS NULL OR ${distinct}) AND ${newest} < $1::timestamptz`,
    [o.deltaSince],
  );
  return Number(rows[0].n);
}

async function applyDeferred(o: EngineOptions, name: string, col: string, T: string) {
  const tgt = o.targetInfo.tables.get(name) as TableInfo;
  const fk = tgt.foreignKeys.find((f) => f.columns.length === 1 && f.columns[0] === col);
  if (!fk) throw new Error(`${name}.${col}: deferred column has no FK`);
  const tq = `${T}.${q(name)}`;
  const keyMatch = tgt.primaryKey.map((k) => `t.${q(k)} = x.${q(k)}`).join(' AND ');
  const parentExists = `EXISTS (SELECT 1 FROM ${T}.${q(fk.refTable)} p WHERE p.${q(fk.refColumns[0])} = x.${q(col)})`;
  const nulled = Number(
    (
      await o.target.query(
        `SELECT count(*)::bigint AS n FROM pg_temp.${stg(name)} x WHERE x.${q(col)} IS NOT NULL AND NOT ${parentExists}`,
      )
    ).rows[0].n,
  );
  const r = await o.target.query(
    `UPDATE ${tq} t SET ${q(col)} = CASE WHEN x.${q(col)} IS NULL OR ${parentExists} THEN x.${q(col)} END
       FROM pg_temp.${stg(name)} x
      WHERE ${keyMatch} AND t.${q(col)} IS DISTINCT FROM CASE WHEN x.${q(col)} IS NULL OR ${parentExists} THEN x.${q(col)} END`,
  );
  return { updated: r.rowCount ?? 0, nulled };
}

/** setval for every sequence of the target schema: never lowered, raised to the column max. */
export async function bumpSequences(target: Client, schema: string, info: SchemaInfo) {
  const out: Record<string, { before: string | null; after: string | null }> = {};
  for (const seq of info.sequences) {
    const sq = `${q(schema)}.${q(seq.name)}`;
    const { rows } = await target.query(`SELECT last_value::text AS v, is_called FROM ${sq}`);
    const current =
      rows[0].is_called === true || rows[0].is_called === 't' ? BigInt(rows[0].v) : BigInt(rows[0].v) - 1n;
    let max = 0n;
    if (seq.table && seq.column) {
      const m = await target.query(`SELECT max(${q(seq.column)})::text AS m FROM ${q(schema)}.${q(seq.table)}`);
      if (m.rows[0].m !== null) max = BigInt(m.rows[0].m);
    }
    const before = current > 0n ? current.toString() : null;
    if (max > current) {
      await target.query(`SELECT setval($1::regclass, $2::bigint, true)`, [`${schema}.${seq.name}`, max.toString()]);
      out[seq.name] = { before, after: max.toString() };
    } else out[seq.name] = { before, after: before };
  }
  return out;
}

/** Rows already present in tables whose policy is "error" (a previous carry ran). */
export async function carriedRowsPresent(
  target: Client,
  schema: string,
  tables: Record<string, TableSpec>,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [name, spec] of Object.entries(tables)) {
    if (!isCarried(spec) || (spec.existing ?? 'error') !== 'error') continue;
    const { rows } = await target.query(`SELECT count(*)::bigint AS n FROM ${q(schema)}.${q(name)}`);
    if (Number(rows[0].n) > 0) out[name] = Number(rows[0].n);
  }
  return out;
}
