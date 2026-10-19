import { Pool } from 'pg';
import { generateTrail } from '../src/trails/generate.js';

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['127.0.0.1','localhost'].includes(url.hostname) || url.pathname !== '/jdq_preview_codex_dev') {
    throw new Error('Refusing trail preview unless DATABASE_URL targets loopback jdq_preview_codex_dev.');
  }
  const pool = new Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 3000 });
  try {
    const identity = await pool.query('SELECT current_database() AS name');
    if (identity.rows[0]?.name !== 'jdq_preview_codex_dev') throw new Error('Preview database identity mismatch.');
    const migrations = await pool.query(`SELECT 1 FROM schema_migrations WHERE filename='055_trail_engine.sql'`);
    const spots = await pool.query(`SELECT count(*)::int AS count FROM spots WHERE status='published' AND COALESCE(is_test,FALSE)=FALSE`);
    if (!migrations.rowCount || Number(spots.rows[0]?.count) < 3) throw new Error('Preview DB must have migration 055 and at least 3 published non-test spots.');
    const result = await generateTrail(pool, { kind:'benchmark', theme:'Pangasinan discoveries', tier:'starter', budgetMin:600, minStops:3, maxStops:6, maxLegMin:180, maxPerCategory:6, seed:20261019 });
    console.log(JSON.stringify({ trail: {
      id:result.trail.id,slug:result.trail.slug,title:result.trail.title,tier:result.trail.tier,status:result.trail.status,
      municipalities:result.trail.municipalities,total_minutes:result.trail.total_minutes,total_km:result.trail.total_km,
      story:result.trail.story,stops:result.solution.stops,
    }, solver:result.generation.solver, solver_ms:result.generation.solver_ms, objective:result.generation.objective, ai_used:false },null,2));
  } finally { await pool.end(); }
}

main().catch(error => { console.error(`[trail-preview] ${error instanceof Error ? error.message : 'generation failed'}`); process.exitCode=1; });
