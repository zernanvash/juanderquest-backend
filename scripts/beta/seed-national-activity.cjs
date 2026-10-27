#!/usr/bin/env node
// Beta world Phase 2: synthetic travelers view, like and save the imported national destinations.
// BETA database only; refuses a second run (looks for existing events on spot-wd-* spots).
//
//   DATABASE_URL=... node scripts/beta/seed-national-activity.cjs [--dry-run]
'use strict';
const { Client } = require('pg');

const DRY = process.argv.includes('--dry-run');
const NOW = Date.now();
const DAY = 86400000;
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = mulberry32(Number(process.env.BETA_SEED || 20261027) + 4646);
const chance = (p) => rand() < p;
const pareto = () => Math.min(40, 1 / Math.pow(1 - rand() * 0.999, 1 / 1.3));

async function insertMany(db, table, cols, rows, conflict = '') {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const params = []; const tuples = chunk.map((r) => `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(',')})`);
    await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')} ${conflict}`, params);
  }
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const { rows: [{ name }] } = await db.query('SELECT current_database() AS name');
  if (!/^jdq_beta/.test(name)) throw new Error(`refusing: ${name} is not a beta database`);
  const { rows: [{ n }] } = await db.query("SELECT count(*)::int AS n FROM spot_activity_events WHERE (spot_id LIKE 'spot-wd-%' OR spot_id LIKE 'spot-osm-%')");
  if (n > 0) throw new Error(`refusing: ${n} national spot events already exist`);

  const spots = (await db.query("SELECT id, created_at FROM spots WHERE (id LIKE 'spot-wd-%' OR id LIKE 'spot-osm-%') AND status = 'published'")).rows;
  // Weight travelers by how active they already are, so power users stay power users.
  const users = (await db.query(`SELECT u.id, count(i.*)::int AS acts FROM users u LEFT JOIN spot_interactions i ON i.user_id = u.id
    WHERE u.id LIKE 'beta-u-%' GROUP BY u.id ORDER BY u.id`)).rows;
  const cumulative = []; let total = 0;
  for (const u of users) { total += 1 + u.acts; cumulative.push(total); }
  const pickUser = () => { const x = rand() * total; let lo = 0, hi = cumulative.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cumulative[m] < x) lo = m + 1; else hi = m; } return users[lo].id; };

  const interactions = []; const events = []; let sae = 0;
  for (const s of spots) {
    const from = Math.max(new Date(s.created_at).getTime(), NOW - 120 * DAY);
    const viewers = new Set(); const want = Math.round(pareto() * 2.2);
    for (let k = 0; k < want * 3 && viewers.size < want; k++) viewers.add(pickUser());
    for (const uid of viewers) {
      const t = new Date(Math.min(NOW - 20 * 60000, NOW - (NOW - from) * Math.pow(rand(), 1.3)));
      interactions.push([uid, s.id, 'view', t]); events.push([`beta-nae-${++sae}`, uid, s.id, 'view', t]);
      if (chance(0.35)) interactions.push([uid, s.id, 'like', new Date(t.getTime() + 60000)]);
      if (chance(0.15)) { const ts = new Date(t.getTime() + 120000); interactions.push([uid, s.id, 'save', ts]); events.push([`beta-nae-${++sae}`, uid, s.id, 'save', ts]); }
    }
  }
  console.log(`national spots ${spots.length}; travelers ${users.length}; interactions ${interactions.length}; events ${events.length}; spots with no views ${spots.length - new Set(interactions.map((r) => r[1])).size}`);
  if (DRY) { console.log('dry run: nothing written'); await db.end(); return; }
  await db.query('BEGIN');
  try {
    await insertMany(db, 'spot_interactions', ['user_id', 'spot_id', 'interaction_type', 'created_at'], interactions, 'ON CONFLICT DO NOTHING');
    await insertMany(db, 'spot_activity_events', ['id', 'user_id', 'spot_id', 'activity_type', 'created_at'], events);
    await db.query('COMMIT'); console.log('committed');
  } catch (e) { await db.query('ROLLBACK'); throw e; } finally { await db.end(); }
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
