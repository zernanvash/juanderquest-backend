import { newDb, DataType, IMemoryDb } from 'pg-mem';
import { Pool } from 'pg';
import { applyMigrations } from './pool.js';
import { randomUUID } from 'crypto';

export interface TestDbInstance {
  memDb?: IMemoryDb;
  pool: Pool;
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDbInstance> {
  if (process.env.JDQ_REAL_PG_URL) {
    const url = new URL(process.env.JDQ_REAL_PG_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/jdq_reliability_test') {
      throw new Error('Real integration harness only accepts loopback jdq_reliability_test');
    }
    const schema = `jdq_test_${randomUUID().replace(/-/g, '')}`;
    const admin = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 3000 });
    try { await admin.query(`CREATE SCHEMA ${schema}`); }
    catch (error) { await admin.end(); throw error; }
    const pool = new Pool({ connectionString: url.toString(), options: `-c search_path=${schema}`, max: 5, connectionTimeoutMillis: 3000 });
    try { await applyMigrations(pool); }
    catch (error) {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      throw error;
    }
    return { pool, close: async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    } };
  }
  const memDb = newDb();

  memDb.public.registerFunction({
    name: 'clock_timestamp', args: [], returns: DataType.timestamptz,
    implementation: () => new Date(),
    impure: true,
  });

  memDb.public.registerFunction({
    name: 'version',
    args: [],
    returns: DataType.text,
    implementation: () => 'PostgreSQL 15.0 (pg-mem)',
  });

  memDb.public.registerFunction({
    name: 'char_length',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (val: string) => (val ? val.length : 0),
  });

  memDb.public.registerFunction({
    name: 'length',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (val: string) => (val ? val.length : 0),
  });

  memDb.registerLanguage('plpgsql', ({ code }) => () => {
    const ifExistsMatch = code.match(/IF\s+EXISTS\s*\(\s*([\s\S]+?)\s*\)\s*THEN\s*RAISE\s+EXCEPTION\s+['"]([\s\S]+?)['"]/i);
    if (ifExistsMatch) {
      const checkQuery = ifExistsMatch[1];
      const errorMsg = ifExistsMatch[2];
      const result = memDb.public.query(checkQuery);
      const rows = result ? (result.rows || (Array.isArray(result) ? result : [])) : [];
      if (rows.length > 0) {
        throw new Error(errorMsg);
      }
      return;
    }

    const hasDuplicateObjectHandler = /WHEN\s+duplicate_object/i.test(code);
    const hasOthersHandler = /WHEN\s+OTHERS/i.test(code);
    const match = code.match(/BEGIN\s+([\s\S]+?)\s+(?:EXCEPTION|END)/i);
    const body = match ? match[1] : code;
    const statements = body.split(';').map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      try {
        memDb.public.query(stmt);
      } catch (err: any) {
        if (hasOthersHandler) {
          continue;
        }
        if (hasDuplicateObjectHandler) {
          const msg = (err?.message || '').toLowerCase();
          const isDuplicate =
            msg.includes('already exists') ||
            msg.includes('duplicate') ||
            msg.includes('unique constraint');
          if (isDuplicate) {
            continue;
          }
        }
        throw err;
      }
    }
  });

  // Intercept CREATE TABLE IF NOT EXISTS schema_migrations if table already exists,
  // preventing pg-mem unread AST error on idempotent re-runs
  memDb.public.interceptQueries((sql) => {
    if (sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) {
      try {
        const exists = memDb.public.getTable('schema_migrations', true);
        if (exists) {
          return [];
        }
      } catch {
        // table does not exist yet
      }
    }
    if (sql.includes('SKIP LOCKED')) {
      const res = memDb.public.query(sql.replace(/SKIP\s+LOCKED/gi, ''));
      return res && typeof res === 'object' && 'rows' in res ? (res as any).rows : (Array.isArray(res) ? res : []);
    }
    return null;
  });

  const { Pool: MemPool } = memDb.adapters.createPg();
  const pool = new MemPool() as unknown as Pool;

  await applyMigrations(pool);

  return {
    memDb,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
