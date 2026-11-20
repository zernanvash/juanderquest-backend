// Plan 116 §9: read the catalog shape (tables, columns, primary keys, foreign keys,
// sequences) of one database. Only pg_catalog is read; no table data.
import type { Client } from 'pg';

export interface ColumnInfo {
  name: string;
  type: string; // format_type()
  notNull: boolean;
  generated: boolean; // GENERATED ALWAYS AS (...) STORED
  identity: '' | 'a' | 'd';
  hasDefault: boolean;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  deferrable: boolean;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  uniqueKeys: string[][];
  foreignKeys: ForeignKeyInfo[];
}

export interface SequenceInfo {
  name: string;
  /** Owning table/column when the sequence is OWNED BY / identity / used in a column default. */
  table: string | null;
  column: string | null;
}

export interface SchemaInfo {
  tables: Map<string, TableInfo>;
  sequences: SequenceInfo[];
}

export async function introspect(client: Client, schema = 'public'): Promise<SchemaInfo> {
  const tables = new Map<string, TableInfo>();
  const tableRows = await client.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p') AND NOT c.relispartition
      ORDER BY c.relname`,
    [schema],
  );
  for (const r of tableRows.rows) {
    tables.set(r.relname, { name: r.relname, columns: [], primaryKey: [], uniqueKeys: [], foreignKeys: [] });
  }

  const cols = await client.query(
    `SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull,
            a.attgenerated, a.attidentity, a.atthasdef
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
    [schema],
  );
  for (const r of cols.rows) {
    const t = tables.get(r.relname);
    if (!t) continue;
    t.columns.push({
      name: r.attname,
      type: r.type,
      notNull: r.attnotnull === true || r.attnotnull === 't',
      generated: r.attgenerated === 's',
      identity: r.attidentity || '',
      hasDefault: r.atthasdef === true || r.atthasdef === 't',
    });
  }

  const cons = await client.query(
    `SELECT con.conname, con.contype, c.relname, rc.relname AS ref_table, con.condeferrable,
            ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS cols,
            ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS ref_cols
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_class rc ON rc.oid = con.confrelid
      WHERE n.nspname = $1 AND con.contype IN ('p','u','f')
      ORDER BY c.relname, con.conname`,
    [schema],
  );
  for (const r of cons.rows) {
    const t = tables.get(r.relname);
    if (!t) continue;
    const colsArr = parseTextArray(r.cols);
    if (r.contype === 'p') t.primaryKey = colsArr;
    else if (r.contype === 'u') t.uniqueKeys.push(colsArr);
    else
      t.foreignKeys.push({
        name: r.conname,
        columns: colsArr,
        refTable: r.ref_table,
        refColumns: parseTextArray(r.ref_cols),
        deferrable: r.condeferrable === true || r.condeferrable === 't',
      });
  }
  // Unique indexes that aren't constraints still define ON CONFLICT targets.
  const idx = await client.query(
    `SELECT c.relname,
            ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord) AS cols
       FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND i.indisunique AND NOT i.indisprimary AND i.indpred IS NULL AND i.indexprs IS NULL
        AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)`,
    [schema],
  );
  for (const r of idx.rows) tables.get(r.relname)?.uniqueKeys.push(parseTextArray(r.cols));

  const seqs = await client.query(
    `SELECT s.relname AS seq, t.relname AS tbl, a.attname AS col
       FROM pg_class s
       JOIN pg_namespace n ON n.oid = s.relnamespace
       LEFT JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a','i')
       LEFT JOIN pg_class t ON t.oid = d.refobjid
       LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
      WHERE n.nspname = $1 AND s.relkind = 'S'
      ORDER BY s.relname`,
    [schema],
  );
  const sequences: SequenceInfo[] = seqs.rows.map((r) => ({
    name: r.seq,
    table: r.tbl ?? null,
    column: r.col ?? null,
  }));
  // Sequences only referenced from a column DEFAULT nextval('x') (not OWNED BY).
  const defaults = await client.query(
    `SELECT c.relname AS tbl, a.attname AS col, pg_get_expr(d.adbin, d.adrelid) AS expr
       FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE n.nspname = $1 AND pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%'`,
    [schema],
  );
  for (const r of defaults.rows) {
    const m = /nextval\('(?:[a-z0-9_]+\.)?"?([a-z0-9_]+)"?'::regclass\)/i.exec(r.expr);
    if (!m) continue;
    const seq = sequences.find((s) => s.name === m[1]);
    if (seq && !seq.table) {
      seq.table = r.tbl;
      seq.column = r.col;
    }
  }
  return { tables, sequences };
}

/** Parses a PostgreSQL text[] literal (raw text mode) or passes a JS array through. */
export function parseTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  const inner = value.replace(/^\{/, '').replace(/\}$/, '');
  if (!inner) return [];
  return inner.split(',').map((s) => s.replace(/^"(.*)"$/, '$1'));
}

export async function rowCounts(
  client: Client,
  tables: Iterable<string>,
  schema = 'public',
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const t of tables) {
    const { rows } = await client.query(`SELECT count(*)::bigint AS n FROM "${schema}"."${t}"`);
    out.set(t, Number(rows[0].n));
  }
  return out;
}
