#!/usr/bin/env node
// Beta world Phase 3: keep the beta alive. Synthetic travelers act through the real beta API
// (views, likes, saves, follows, cheers, comments, quest proofs reviewed by beta-admin), following
// a Manila day/night rhythm. Reads state from the BETA database; every write goes through the API,
// so the API's in-memory caches, Plaza producers, XP and standings behave exactly as for real users.
//
//   DATABASE_URL=... BETA_JWT_SECRET=... node scripts/beta/pulse.cjs [--api http://127.0.0.1:4150] [--once] [--rate 1]
'use strict';
const crypto = require('node:crypto');
const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const { COMMENTS } = require('./seed-beta-world.cjs');

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const API = arg('--api', 'http://127.0.0.1:4150').replace(/\/$/, '');
const ONCE = process.argv.includes('--once');
const RATE = Number(arg('--rate', '1'));       // multiplies every expected count
const TICK_MS = Number(arg('--tick', '60')) * 1000;
const SECRET = process.env.BETA_JWT_SECRET;

const rand = Math.random;
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
const poisson = (l) => { let k = 0, p = 1; const L = Math.exp(-l); do { k++; p *= rand(); } while (p > L); return k - 1; };
const weighted = (items, w) => { let t = 0; const c = items.map((x) => (t += w(x))); const r = rand() * t; let lo = 0, hi = c.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (c[m] < r) lo = m + 1; else hi = m; } return items[lo]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (lat, lng, m) => { const r = m * Math.sqrt(rand()), t = rand() * 2 * Math.PI; return [lat + (r * Math.cos(t)) / 111320, lng + (r * Math.sin(t)) / (111320 * Math.cos((lat * Math.PI) / 180))]; };

// Expected actions per minute at peak; scaled by the Manila hour curve.
const PER_MIN = { view: 3, like: 1.1, save: 0.45, cheer: 1.8, comment: 0.22, follow: 0.3, quest: 0.14 };
const HOUR_CURVE = [0.18, 0.1, 0.05, 0.04, 0.05, 0.12, 0.3, 0.5, 0.65, 0.75, 0.85, 0.95, 1, 0.9, 0.8, 0.75, 0.8, 0.9, 1, 1, 0.95, 0.8, 0.55, 0.32];
const manilaHour = () => (new Date().getUTCHours() + 8) % 24;

const stats = { since: new Date().toISOString(), ok: {}, fail: {} };
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
const tokens = new Map();
function token(user) {
  const t = tokens.get(user.id);
  if (t && t.exp > Date.now() + 3600000) return t.value;
  const value = jwt.sign({ id: user.id, seed_id: user.seed_id, role: user.role, typ: 'session' }, SECRET, { algorithm: 'HS256', expiresIn: '24h' });
  tokens.set(user.id, { value, exp: Date.now() + 23 * 3600000 });
  return value;
}
async function call(user, method, path, body) {
  const res = await fetch(`${API}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token(user)}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}
async function act(kind, fn) {
  try { const r = await fn(); if (r && r.status >= 200 && r.status < 300) bump(stats.ok, kind); else { bump(stats.fail, `${kind}:${r ? r.status : 'skip'}${r?.json?.error?.code ? `:${r.json.error.code}` : ''}`); } }
  catch (e) { bump(stats.fail, `${kind}:${e.code || e.message}`.slice(0, 60)); }
}

let state;
async function loadState(db) {
  const users = (await db.query("SELECT id, seed_id, role, is_public FROM users WHERE id LIKE 'beta-u-%' ORDER BY id")).rows;
  const activity = new Map((await db.query("SELECT user_id, count(*)::int n FROM spot_interactions WHERE user_id LIKE 'beta-u-%' GROUP BY 1")).rows.map((r) => [r.user_id, r.n]));
  for (const u of users) u.weight = 1 + (activity.get(u.id) || 0);
  const spots = (await db.query(`SELECT s.id, count(i.*)::int n FROM spots s LEFT JOIN spot_interactions i ON i.spot_id = s.id
    WHERE s.status = 'published' AND NOT s.is_test GROUP BY s.id`)).rows;
  const followers = new Map();
  for (const r of (await db.query("SELECT follower_id, following_id FROM user_follows WHERE following_id LIKE 'beta-u-%'")).rows) {
    if (!followers.has(r.following_id)) followers.set(r.following_id, []); followers.get(r.following_id).push(r.follower_id);
  }
  const followerCount = new Map([...followers].map(([k, v]) => [k, v.length]));
  const quests = (await db.query(`SELECT q.id, q.gps_lat, q.gps_lng, q.radius_meters FROM quests q
    WHERE q.is_active AND q.status = 'published' AND NOT q.is_test AND NOT q.funding_required AND q.id NOT LIKE 'qa-%'`)).rows;
  const done = new Set((await db.query("SELECT user_id || '|' || quest_id k FROM submissions WHERE user_id LIKE 'beta-u-%' AND status <> 'rejected'")).rows.map((r) => r.k));
  const admin = (await db.query("SELECT id, seed_id, role FROM users WHERE id = 'beta-admin'")).rows[0];
  state = { users, byId: new Map(users.map((u) => [u.id, u])), spots, followers, followerCount, quests, done, admin, loadedAt: Date.now() };
}
async function recentActivities(db) {
  return (await db.query(`SELECT id, actor_id, created_at FROM social_activities
    WHERE created_at > now() - interval '72 hours' AND actor_id LIKE 'beta-u-%' AND NOT is_test ORDER BY created_at DESC LIMIT 400`)).rows;
}

const user = () => weighted(state.users, (u) => u.weight);
const spot = () => weighted(state.spots, (s) => 1 + s.n);

async function viewSpot() { const u = user(), s = spot(); s.n++; return call(u, 'POST', `/spots/${s.id}/interactions`, { type: 'view' }); }
async function likeSpot() { const u = user(), s = spot(); return call(u, 'PUT', `/spots/${s.id}/like`); }
async function saveSpot() { const u = user(), s = spot(); return call(u, 'PUT', `/spots/${s.id}/save`); }
async function follow() {
  const u = user(); const target = weighted(state.users, (x) => (x.is_public ? 1 + (state.followerCount.get(x.id) || 0) : 0));
  if (target.id === u.id || (state.followers.get(target.id) || []).includes(u.id)) return null;
  const r = await call(u, 'PUT', `/users/${target.id}/follow`);
  if (r.status < 300) { if (!state.followers.has(target.id)) state.followers.set(target.id, []); state.followers.get(target.id).push(u.id); state.followerCount.set(target.id, (state.followerCount.get(target.id) || 0) + 1); }
  return r;
}
// Cheers and comments favour fresh posts and the author's followers.
function audienceFor(acts) {
  const a = weighted(acts, (x) => 1 / (1 + (Date.now() - new Date(x.created_at).getTime()) / 3600000));
  const fans = state.followers.get(a.actor_id) || [];
  const from = fans.length && rand() < 0.75 ? state.byId.get(pick(fans)) : user();
  return from && from.id !== a.actor_id ? { a, from } : null;
}
async function cheer(acts) { const x = acts.length && audienceFor(acts); return x ? call(x.from, 'PUT', `/plaza/activities/${x.a.id}/cheer`) : null; }
async function comment(acts) { const x = acts.length && audienceFor(acts); return x ? call(x.from, 'POST', `/plaza/activities/${x.a.id}/comments`, { body: pick(COMMENTS), idempotency_key: crypto.randomUUID() }) : null; }

const pendingReviews = [];
async function quest() {
  for (let k = 0; k < 20; k++) {
    const u = user(), q = pick(state.quests); if (!q || state.done.has(`${u.id}|${q.id}`)) continue;
    const c = await call(u, 'POST', `/quests/${q.id}/challenge`);
    if (c.status !== 200) return c;
    const [lat, lng] = jitter(q.gps_lat, q.gps_lng, Math.min(40, q.radius_meters * 0.4));
    const s = await call(u, 'POST', '/submissions', { idempotency_key: crypto.randomUUID(), quest_id: q.id, challenge_token: c.json.data.challenge_token, captured_lat: lat, captured_lng: lng, captured_accuracy: int(6, 18) });
    if (s.status < 300) {
      state.done.add(`${u.id}|${q.id}`);
      const id = s.json?.data?.id || s.json?.data?.submission?.id;
      if (id && (s.json?.data?.status || s.json?.data?.submission?.status) !== 'approved') pendingReviews.push({ id, at: Date.now() + int(3, 30) * 60000 });
    }
    return s;
  }
  return null;
}
async function reviewDue() {
  const due = pendingReviews.filter((p) => ONCE || p.at <= Date.now());
  for (const p of due) {
    pendingReviews.splice(pendingReviews.indexOf(p), 1);
    // Admins approve almost everything; a few proofs get bounced like in real moderation.
    const approve = rand() > 0.04;
    await act(approve ? 'approve' : 'reject', () => call(state.admin, 'PATCH', `/admin/submissions/${p.id}`, approve ? { action: 'approve' } : { action: 'reject', rejection_reason: 'Photo does not show the marker clearly. Please try again.' }));
  }
}

async function tick(db) {
  if (Date.now() - state.loadedAt > 15 * 60000) await loadState(db);
  const w = HOUR_CURVE[manilaHour()] * RATE * (TICK_MS / 60000);
  const acts = await recentActivities(db);
  const plan = Object.fromEntries(Object.entries(PER_MIN).map(([k, v]) => [k, poisson(v * w)]));
  const jobs = [];
  for (let i = 0; i < plan.view; i++) jobs.push(['view', viewSpot]);
  for (let i = 0; i < plan.like; i++) jobs.push(['like', likeSpot]);
  for (let i = 0; i < plan.save; i++) jobs.push(['save', saveSpot]);
  for (let i = 0; i < plan.follow; i++) jobs.push(['follow', follow]);
  for (let i = 0; i < plan.cheer; i++) jobs.push(['cheer', () => cheer(acts)]);
  for (let i = 0; i < plan.comment; i++) jobs.push(['comment', () => comment(acts)]);
  for (let i = 0; i < plan.quest; i++) jobs.push(['quest', quest]);
  jobs.sort(() => rand() - 0.5);
  // Spread the tick's actions over the minute so timestamps don't bunch up.
  const gap = jobs.length ? Math.min(8000, (TICK_MS * 0.8) / jobs.length) : 0;
  for (const [kind, fn] of jobs) { await act(kind, fn); if (!ONCE) await sleep(gap * (0.5 + rand())); }
  await reviewDue();
  return { hour: manilaHour(), planned: jobs.length };
}

async function main() {
  if (!SECRET) throw new Error('BETA_JWT_SECRET is required');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(API)) throw new Error(`refusing: ${API} is not a loopback API`);
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const { rows: [{ name }] } = await db.query('SELECT current_database() AS name');
  if (!/^jdq_beta/.test(name)) throw new Error(`refusing: ${name} is not a beta database`);
  await db.query('SET default_transaction_read_only = on');
  // The API must be the beta one: our beta-only secret has to be accepted.
  await loadState(db);
  const probe = await call(state.admin, 'GET', '/auth/me');
  if (probe.status !== 200) throw new Error(`refusing: ${API} rejected a beta session (${probe.status}); is it the beta API?`);
  // Proofs left pending by an earlier run get reviewed too.
  for (const r of (await db.query("SELECT id FROM submissions WHERE user_id LIKE 'beta-u-%' AND status = 'pending'")).rows) pendingReviews.push({ id: r.id, at: Date.now() + int(1, 10) * 60000 });
  if (ONCE) await reviewDue();
  console.log(`${new Date().toISOString()} pulse up: ${state.users.length} travelers, ${state.spots.length} spots, ${state.quests.length} quests, ${pendingReviews.length} pending proofs; api ${API}`);
  let stop = false; process.on('SIGTERM', () => { stop = true; }); process.on('SIGINT', () => { stop = true; });
  do {
    const started = Date.now();
    const t = await tick(db).catch((e) => ({ error: e.message }));
    console.log(`${new Date().toISOString()} h${String(t.hour ?? '?').padStart(2, '0')} planned ${t.planned ?? 0} ok ${JSON.stringify(stats.ok)} fail ${JSON.stringify(stats.fail)} reviews ${pendingReviews.length}${t.error ? ` error ${t.error}` : ''}`);
    if (ONCE) break;
    while (!stop && Date.now() - started < TICK_MS) await sleep(1000);
  } while (!stop);
  await db.end();
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
