// Plan 116 §9: carry manifest types, fail-closed validation and transfer ordering.
// Pure functions only (no database access) so they are unit-tested directly.
import { createHash } from 'node:crypto';
import type { ForeignKeyInfo, SchemaInfo, TableInfo } from './introspect.js';

export type Mode = 'carry' | 'carry-filtered' | 'regenerate' | 'empty' | 'ignore';
export const MODES: Mode[] = ['carry', 'carry-filtered', 'regenerate', 'empty', 'ignore'];
export type ExistingPolicy = 'error' | 'update' | 'keep';

export interface TableSpec {
  mode: Mode;
  reason: string;
  /** Transaction group (carry modes only). */
  group?: string;
  /** Explicit target columns to write (source ∩ target unless transformed). */
  columns?: string[];
  /** Columns present in source and target that are deliberately not written, with the reason. */
  omit?: Record<string, string>;
  /** column -> SQL expression evaluated on the source row (alias `s`). */
  transform?: Record<string, string>;
  /** SQL predicate on the source row (alias `s`); may use {{confirm:<group>}} and {{since}}. */
  filter?: string;
  /**
   * What to do when a carried key already exists in the target:
   * error (default; the table must be empty before a full run), update (source wins for the
   * carried columns; for migration-seeded rows), keep (target wins; e.g. admin areas re-imported).
   */
  existing?: ExistingPolicy;
  /** Single-column FKs set to NULL (instead of dropping the row) when the parent isn't carried. */
  onParentMissing?: Record<string, 'null'>;
  /** FK columns written after every group (breaks FK cycles); must also be in onParentMissing. */
  deferred?: string[];
}

export interface ConfirmGroup {
  table: string;
  description: string;
  /** SQL predicate on the source row (alias `s`): rows the owner may confirm. */
  eligible: string;
  /** Owner-facing CSV columns: name -> SQL expression on alias `s` (never full emails/names of people). */
  list: Record<string, string>;
}

export interface OwnerList {
  table: string;
  description: string;
  list: Record<string, string>;
  orderBy: string;
}

export interface ReverseSpec {
  description: string;
  /** Tables in reverse order of processing is computed; columns are the explicit subset written back. */
  tables: Record<string, { columns: string[]; filter: string; onParentMissing?: Record<string, 'null'> }>;
}

export interface Manifest {
  version: number;
  plan: string;
  groups: string[];
  confirmGroups: Record<string, ConfirmGroup>;
  ownerLists: Record<string, OwnerList>;
  tables: Record<string, TableSpec>;
  reverse: ReverseSpec;
}

export const CARRY_MODES: Mode[] = ['carry', 'carry-filtered'];
export const isCarried = (spec: TableSpec | undefined) => !!spec && CARRY_MODES.includes(spec.mode);

export interface ValidateOptions {
  /** Every source∩target column must be listed in columns or omit (forward carry). */
  requireFullCoverage?: boolean;
  /** Every table in source or target must be in the manifest (forward carry). */
  requireAllTables?: boolean;
}

/** Returns every problem found; an empty list means the manifest matches both schemas. */
export function validateManifest(
  manifest: Pick<Manifest, 'groups' | 'tables' | 'confirmGroups'>,
  source: SchemaInfo,
  target: SchemaInfo,
  options: ValidateOptions = { requireFullCoverage: true, requireAllTables: true },
): string[] {
  const errors: string[] = [];
  const names = new Set([...source.tables.keys(), ...target.tables.keys()]);
  if (options.requireAllTables) {
    for (const n of [...names].sort()) {
      if (!manifest.tables[n])
        errors.push(`table ${n}: present in ${where(n, source, target)} but not in the manifest`);
    }
  }
  for (const [name, spec] of Object.entries(manifest.tables).sort(([a], [b]) => a.localeCompare(b))) {
    const src = source.tables.get(name);
    const tgt = target.tables.get(name);
    if (!src && !tgt) {
      errors.push(`table ${name}: in the manifest but in neither database`);
      continue;
    }
    if (!MODES.includes(spec.mode)) errors.push(`table ${name}: unknown mode "${spec.mode}"`);
    if (!spec.reason || !spec.reason.trim()) errors.push(`table ${name}: missing reason`);
    if (!isCarried(spec)) {
      for (const k of ['columns', 'transform', 'filter', 'onParentMissing', 'deferred', 'group'] as const) {
        if (spec[k] !== undefined) errors.push(`table ${name}: "${k}" is only allowed for carry modes`);
      }
      continue;
    }
    if (!src || !tgt) {
      errors.push(
        `table ${name}: carry mode needs the table in both databases (missing in ${src ? 'target' : 'source'})`,
      );
      continue;
    }
    errors.push(...validateCarriedTable(name, spec, src, tgt, manifest.groups, options));
    for (const m of (spec.filter ?? '').matchAll(/\{\{confirm:([a-z_]+)\}\}/g)) {
      if (!manifest.confirmGroups[m[1]]) errors.push(`table ${name}: filter uses unknown confirm group "${m[1]}"`);
    }
  }
  for (const [g, cg] of Object.entries(manifest.confirmGroups)) {
    const spec = manifest.tables[cg.table];
    if (!spec || spec.mode !== 'carry-filtered')
      errors.push(`confirm group ${g}: table ${cg.table} must be carry-filtered`);
    else if (!(spec.filter ?? '').includes(`{{confirm:${g}}}`))
      errors.push(`confirm group ${g}: the filter of ${cg.table} does not use {{confirm:${g}}}`);
    if (!cg.list.id) errors.push(`confirm group ${g}: list must include an "id" column`);
  }
  return errors;
}

function where(n: string, source: SchemaInfo, target: SchemaInfo) {
  return [source.tables.has(n) ? 'source' : '', target.tables.has(n) ? 'target' : ''].filter(Boolean).join('+');
}

export function validateCarriedTable(
  name: string,
  spec: TableSpec,
  src: TableInfo,
  tgt: TableInfo,
  groups: string[],
  options: ValidateOptions,
): string[] {
  const errors: string[] = [];
  const e = (msg: string) => errors.push(`table ${name}: ${msg}`);
  if (!spec.group || !groups.includes(spec.group)) e(`group "${spec.group}" is not one of ${groups.join(', ')}`);
  const cols = spec.columns ?? [];
  if (!cols.length) e('carry mode needs an explicit column list');
  if (new Set(cols).size !== cols.length) e('duplicate columns');
  const tcol = new Map(tgt.columns.map((c) => [c.name, c]));
  const scol = new Set(src.columns.map((c) => c.name));
  const transform = spec.transform ?? {};
  for (const c of cols) {
    const t = tcol.get(c);
    if (!t) e(`column ${c} does not exist in the target`);
    else if (t.generated) e(`column ${c} is generated in the target`);
    if (!scol.has(c) && !(c in transform)) e(`column ${c} does not exist in the source and has no transform`);
  }
  for (const c of Object.keys(transform)) if (!cols.includes(c)) e(`transform for ${c} which is not in columns`);
  const omit = spec.omit ?? {};
  for (const c of Object.keys(omit)) {
    if (cols.includes(c)) e(`column ${c} is both carried and omitted`);
    if (!tcol.has(c) || !scol.has(c)) e(`omitted column ${c} is not in both databases`);
  }
  if (options.requireFullCoverage) {
    for (const c of tgt.columns) {
      if (c.generated || !scol.has(c.name)) continue;
      if (!cols.includes(c.name) && !(c.name in omit))
        e(`column ${c.name} exists in source and target but is neither carried nor omitted`);
    }
  }
  const deferred = new Set(spec.deferred ?? []);
  for (const c of tgt.columns) {
    const written = cols.includes(c.name) && !deferred.has(c.name);
    if (c.notNull && !c.hasDefault && !c.generated && !c.identity && !written)
      e(`target column ${c.name} is NOT NULL without default but is not written`);
  }
  if (!tgt.primaryKey.length) e('target table has no primary key');
  for (const k of tgt.primaryKey) if (!cols.includes(k)) e(`primary key column ${k} is not carried`);
  for (const [c, rule] of Object.entries(spec.onParentMissing ?? {})) {
    if (rule !== 'null') e(`onParentMissing.${c} must be "null"`);
    if (!cols.includes(c)) e(`onParentMissing column ${c} is not carried`);
    if (tcol.get(c)?.notNull) e(`onParentMissing column ${c} is NOT NULL in the target`);
    if (!tgt.foreignKeys.some((fk) => fk.columns.length === 1 && fk.columns[0] === c))
      e(`onParentMissing column ${c} is not a single-column foreign key in the target`);
  }
  for (const c of deferred) {
    if (!spec.onParentMissing?.[c]) e(`deferred column ${c} must also be onParentMissing: "null"`);
    if (spec.existing === 'keep') e(`deferred column ${c} is not allowed with existing: "keep"`);
  }
  if (spec.existing && !['error', 'update', 'keep'].includes(spec.existing))
    e(`unknown existing policy ${spec.existing}`);
  return errors;
}

export interface OrderedTable {
  name: string;
  group: string;
}

/**
 * Transfer order: groups in manifest order, tables inside a group in FK (parent-first)
 * order computed from the target's pg_constraint. Deferred columns don't create edges.
 * Throws on a cycle or when a parent is placed in a later group than its child.
 */
export function transferOrder(
  tables: Record<string, Pick<TableSpec, 'mode' | 'group' | 'columns' | 'deferred'>>,
  groups: string[],
  target: SchemaInfo,
): OrderedTable[] {
  const carried = Object.keys(tables)
    .filter((n) => isCarried(tables[n] as TableSpec))
    .sort();
  const set = new Set(carried);
  const parents = new Map<string, Set<string>>();
  for (const n of carried) {
    const spec = tables[n];
    const deferred = new Set(spec.deferred ?? []);
    const ps = new Set<string>();
    for (const fk of target.tables.get(n)?.foreignKeys ?? []) {
      if (fk.refTable === n || !set.has(fk.refTable)) continue;
      if (!fk.columns.every((c) => (spec.columns ?? []).includes(c))) continue;
      if (fk.columns.some((c) => deferred.has(c))) continue;
      ps.add(fk.refTable);
    }
    parents.set(n, ps);
  }
  const groupIndex = (n: string) => groups.indexOf(tables[n].group ?? '');
  for (const n of carried) {
    for (const p of parents.get(n) ?? []) {
      if (groupIndex(p) > groupIndex(n))
        throw new Error(
          `table ${n} (group ${tables[n].group}) references ${p} in later group ${tables[p].group}; reorder groups or defer the column`,
        );
    }
  }
  // Kahn's algorithm with a stable (group, name) tie-break for deterministic output.
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < carried.length) {
    const ready = carried
      .filter((n) => !done.has(n) && [...(parents.get(n) ?? [])].every((p) => done.has(p)))
      .sort((a, b) => groupIndex(a) - groupIndex(b) || a.localeCompare(b));
    if (!ready.length) {
      const stuck = carried.filter((n) => !done.has(n));
      throw new Error(`foreign-key cycle among: ${stuck.join(', ')} (mark one column as deferred)`);
    }
    order.push(ready[0]);
    done.add(ready[0]);
  }
  return groups.flatMap((g) => order.filter((n) => tables[n].group === g).map((name) => ({ name, group: g })));
}

export interface BoundSql {
  text: string;
  params: unknown[];
}

/**
 * Replaces {{confirm:<group>}} with a text[] parameter and {{since}} with a timestamptz
 * parameter. Unknown placeholders throw (fail-closed).
 */
export function bindPlaceholders(
  sql: string,
  values: { confirm?: Record<string, string[]>; since?: string | null },
  firstParam = 1,
): BoundSql {
  const params: unknown[] = [];
  const text = sql.replace(/\{\{([a-z]+)(?::([a-z_]+))?\}\}/g, (_m, kind: string, arg?: string) => {
    if (kind === 'confirm' && arg) {
      const ids = values.confirm?.[arg];
      if (!ids) throw new Error(`no confirm list for group ${arg}`);
      params.push(ids);
      return `$${firstParam + params.length - 1}::text[]`;
    }
    if (kind === 'since' && !arg) {
      if (!values.since) throw new Error('{{since}} used without a since timestamp');
      params.push(values.since);
      return `$${firstParam + params.length - 1}::timestamptz`;
    }
    throw new Error(`unknown placeholder {{${kind}${arg ? ':' + arg : ''}}}`);
  });
  return { text, params };
}

/** D2 default, mirrored by the users filter in carry-manifest.json (tests keep them equal). */
export function isCarriedUser(u: { role: string; email: string; is_test: boolean }): boolean {
  if (u.is_test || u.role === 'qa') return false;
  if (u.role === 'admin') return true;
  const domain = emailDomain(u.email);
  if (['guest.invalid', 'simulation.invalid', 'example.test'].includes(domain)) return false;
  if (domain === 'local' || domain.endsWith('.local')) return false;
  return domain.length > 0;
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0
    ? ''
    : email
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function csv(rows: Record<string, unknown>[], columns: string[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

/** Validates an owner confirm file: {"<group>": ["id", ...]} with only known groups. */
export function parseConfirmFile(raw: unknown, groups: string[]): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('confirm file must be a JSON object');
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.startsWith('_')) continue; // comments
    if (!groups.includes(k)) throw new Error(`confirm file: unknown group "${k}" (known: ${groups.join(', ')})`);
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.length > 0))
      throw new Error(`confirm file: "${k}" must be an array of ids`);
    if (new Set(v).size !== v.length) throw new Error(`confirm file: "${k}" has duplicate ids`);
    out[k] = [...v].sort();
  }
  return out;
}

export function fkLabel(fk: ForeignKeyInfo): string {
  return `${fk.columns.join('+')}->${fk.refTable}`;
}
