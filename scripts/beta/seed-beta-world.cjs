#!/usr/bin/env node
/*
 * Beta world seeder: about 1,000 synthetic Filipino travelers who follow, visit, complete quests,
 * earn badges, cheer and comment, spread over recent weeks so the beta site feels lived-in.
 *
 * Runs ONLY against a database whose name starts with `jdq_beta` (the separate beta copy of
 * production, never jdq-alpha-postgres). Deterministic for a given BETA_SEED.
 * Users get no credentials, wallets, chain records or tJDQ. Avatars are generated illustrations.
 *
 * Derived rows mirror what the backend writes for real play:
 *   approved submission -> verified_visit -> explorer +50 XP (submission_approval, explorer-v1)
 *   -> quest_completed activity (points = quest reward) -> first_footstep / pangasinan_pioneer
 *   badges with badge_earned activities; totals and cheer/comment counts are kept consistent.
 *
 * Usage: DATABASE_URL=postgres://.../jdq_beta node scripts/beta/seed-beta-world.cjs [--users 1000] [--dry-run]
 */
'use strict';
const { Client } = require('pg');
const { randomUUID } = require('crypto');

const args = process.argv.slice(2);
const argVal = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const USER_COUNT = Number(argVal('--users', '1000'));
const DRY_RUN = args.includes('--dry-run');
const SEED = Number(process.env.BETA_SEED || 20261027);
const NOW = Date.now();
const DAY = 86400000;

// ---------- deterministic randomness ----------
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = mulberry32(SEED);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const chance = (p) => rand() < p;
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const weighted = (items, w) => { const total = w.reduce((a, b) => a + b, 0); let r = rand() * total; for (let i = 0; i < items.length; i++) { r -= w[i]; if (r <= 0) return items[i]; } return items[items.length - 1]; };
const sample = (xs, n) => { const a = xs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, Math.max(0, n)); };
const pareto = () => 1 / Math.pow(1 - rand() * 0.999, 0.6); // heavy tail, >= 1
// A time between `from` and now, skewed toward recent days so the feed looks active.
// Never inside the last 20 minutes, and spread so a few posts land per hour on recent days rather than in one burst.
const recentBetween = (from) => new Date(Math.min(NOW - 20 * 60000, NOW - (NOW - from) * Math.pow(rand(), 1.4) - int(20, 360) * 60000));

// A follow-up moment up to `maxMinutes` after `t`, scaled into whatever time is left before now
// (clamping instead would stack every recent follow-up on the same minute).
const after = (t, minMinutes, maxMinutes) => {
  const room = NOW - 5 * 60000 - t.getTime();
  const want = int(minMinutes, maxMinutes) * 60000;
  return new Date(t.getTime() + (want < room ? want : Math.max(1000, room * rand())));
};

// ---------- Filipino name pools ----------
const FIRST_F = ['Maria', 'Ana', 'Kristine', 'Jasmine', 'Angelica', 'Camille', 'Patricia', 'Nicole', 'Bea', 'Andrea', 'Joanna', 'Rica', 'Lovely', 'Princess', 'Mae', 'Kaye', 'Joy', 'Grace', 'Liza', 'Rowena', 'Marites', 'Rosalie', 'Cherry', 'Janelle', 'Trisha', 'Alyssa', 'Ella', 'Sofia', 'Hannah', 'Bianca', 'Clarisse', 'Danica', 'Erika', 'Frances', 'Gwen', 'Hazel', 'Isabel', 'Jessa', 'Katrina', 'Lea', 'Mika', 'Nina', 'Pia', 'Queenie', 'Rhea', 'Shiela', 'Tin', 'Vina', 'Ysabel', 'Zia', 'Aira', 'Divine', 'Mylene', 'Charmaine', 'Arlene', 'Jonalyn', 'Ruby', 'Lorna', 'Mariel', 'Abegail'];
const FIRST_M = ['Juan', 'Jose', 'Mark', 'John Paul', 'Christian', 'Carlo', 'Paolo', 'Miguel', 'Rafael', 'Joshua', 'Kevin', 'Ryan', 'Jerome', 'Bryan', 'Arvin', 'Rommel', 'Ramon', 'Ernesto', 'Dante', 'Rodel', 'Jun', 'Jayson', 'Renz', 'Kyle', 'Gab', 'Enzo', 'Lance', 'Nathan', 'Angelo', 'Bernard', 'Cedric', 'Dominic', 'Emman', 'Francis', 'Gerald', 'Harold', 'Ivan', 'Jericho', 'Kenneth', 'Leo', 'Marco', 'Noel', 'Oscar', 'Patrick', 'Rey', 'Sam', 'Teodoro', 'Vincent', 'Wilson', 'Zandro', 'Aldrin', 'Benjie', 'Ronnie', 'Edgar', 'Raymart', 'Jomar', 'Tristan', 'Ely', 'Joel', 'Manuel'];
const SURNAMES = ['Santos', 'Reyes', 'Cruz', 'Bautista', 'Ocampo', 'Garcia', 'Mendoza', 'Torres', 'Tomas', 'Andrada', 'Castillo', 'Flores', 'Villanueva', 'Ramos', 'Castro', 'Rivera', 'Aquino', 'Navarro', 'Salazar', 'Mercado', 'Domingo', 'Gonzales', 'Lopez', 'Dela Cruz', 'De Guzman', 'Pascual', 'Soriano', 'Aguilar', 'Manalo', 'Valdez', 'Fernandez', 'Del Rosario', 'Sison', 'Tan', 'Lim', 'Co', 'Sy', 'Dizon', 'Gutierrez', 'Mateo', 'Bernardo', 'Padilla', 'Lacson', 'Macaraeg', 'Fabia', 'Caguioa', 'Abalos', 'Rosario', 'Estrada', 'Perez', 'Javier', 'Galang', 'Manzano', 'Samson', 'Ignacio', 'Corpuz', 'Cayabyab', 'Datuin', 'Ferrer', 'Quinto', 'Saldivar', 'Velasco', 'Ventura', 'Zamora', 'Agbayani', 'Aban', 'Bacani', 'Caramat', 'Doria', 'Erfe', 'Gamboa', 'Lomboy', 'Mamaril', 'Nisperos', 'Oblena', 'Palisoc', 'Rabago', 'Siapno', 'Tamayo', 'Untalan'];
const NICK = { 'John Paul': 'JP', Christian: 'Chris', Patricia: 'Pat', Kristine: 'Tin', Angelica: 'Gel', Jasmine: 'Jas', Nicole: 'Nikki', Joshua: 'Josh', Francis: 'Kiko', Rafael: 'Raf', Gabriel: 'Gab', Emmanuel: 'Emman', Benjamin: 'Benjie', Princess: 'Cess', Isabel: 'Isay' };
const OTHER_HOMETOWNS = ['Quezon City', 'Manila', 'Makati', 'Pasig', 'Taguig', 'Caloocan', 'Baguio', 'San Fernando, La Union', 'Tarlac City', 'Angeles City', 'Olongapo', 'Vigan', 'Laoag', 'Cabanatuan', 'Malolos', 'Antipolo', 'Batangas City', 'Lucena', 'Naga', 'Legazpi', 'Iloilo City', 'Bacolod', 'Cebu City', 'Tagbilaran', 'Tacloban', 'Dumaguete', 'Cagayan de Oro', 'Davao City', 'General Santos', 'Zamboanga City', 'Puerto Princesa', 'Tuguegarao'];

const BIO = [
  'Weekend wanderer. Bangus lover. 🐟', 'Pangasinense at heart, lakwatsero by choice.', 'Collecting sunsets around Lingayen Gulf 🌅',
  'Mahilig sa beach at kape ☕', 'Nurse by day, explorer by weekend.', 'Student. Trying every falls in the province 💦',
  'Food trip > everything. Puto Calasiao supremacy.', 'Solo traveler from {home}.', 'Proud taga-{home} 🇵🇭',
  'Hiking, heritage churches, and halo-halo.', 'Teacher who brings the class to the field 🗺️', 'Motorcycle rides every Sunday 🏍️',
  'Photographer wannabe. Hundred Islands is my happy place.', 'Balikbayan rediscovering home.', 'Family trips with the kids every month.',
  'Tara, gala! 🚌', 'OFW on vacation, sulitin ang bakasyon!', 'Just here for the quests and the badges 🏅', '', '', '',
];
const STATUS = ['Nasa beach 🏖️', 'Next stop: Bolinao', 'Planning a food trip', 'Sana umaraw bukas ☀️', null, null, null, null];
const COMMENTS = [
  'Ang ganda! 😍', 'Congrats! 🎉', 'Sana all nakapunta na!', 'Tara next weekend?', 'Grabe ang view diyan!', 'Nice one, idol!',
  'Isama mo ako next time 😅', 'Ilang oras ang byahe from Dagupan?', 'Ang init ba diyan ngayon?', 'Worth it ba? Plano namin pumunta.',
  'Galing! Ilang quests na lang sa akin.', 'Love this place ❤️', 'Saan kayo kumain after?', 'Congrats sa badge! 🏅', 'Uy, nandun din kami last week!',
  'Ang bilis mo, pre!', 'Must try ang bangus diyan!', 'Beautiful! 📸', 'Next target ko yan!', 'Ingat sa byahe!', 'Solid! 🔥',
  'Pa-share naman ng itinerary 🙏', 'Super worth it talaga diyan.', 'Ang aga mo nakarating ah!', 'Congrats, kapatid!',
];

// ---------- helpers ----------
const slugify = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
const pad = (n, w = 4) => String(n).padStart(w, '0');
const iso = (d) => new Date(d).toISOString();
const jitter = (lat, lng, meters) => { const r = meters * Math.sqrt(rand()); const t = rand() * 2 * Math.PI; return [lat + (r * Math.cos(t)) / 111320, lng + (r * Math.sin(t)) / (111320 * Math.cos((lat * Math.PI) / 180))]; };

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
  const { rows: [{ name: dbName }] } = await db.query('SELECT current_database() AS name');
  if (!/^jdq_beta/.test(dbName)) throw new Error(`refusing: database ${dbName} is not a beta database (must start with jdq_beta)`);
  const existing = await db.query("SELECT count(*)::int AS n FROM users WHERE id LIKE 'beta-u-%'");
  if (existing.rows[0].n > 0) throw new Error(`beta users already present (${existing.rows[0].n}); restore a fresh beta copy before reseeding`);
  const admin = await db.query("SELECT id FROM users WHERE id = 'beta-admin'");
  if (!admin.rows.length) throw new Error('beta-admin missing: run .local/beta-scrub-real-users.sql first');

  // ---------- load real content ----------
  const munis = (await db.query("SELECT id, name FROM municipalities WHERE is_active IS NOT FALSE")).rows;
  const muniIdByName = new Map(munis.map((m) => [m.name, m.id]));
  const spots = (await db.query("SELECT id, name, municipality, category FROM spots WHERE status = 'published' AND NOT is_test AND id NOT LIKE 'qa-%'")).rows;
  const quests = (await db.query(`
    SELECT q.id, q.title, q.reward_points, q.marker_code, q.gps_lat, q.gps_lng, b.id AS binding_id, b.binding_version, s.id AS spot_id, s.municipality
      FROM quests q JOIN reviewed_quest_spot_bindings b ON b.quest_id = q.id AND b.status = 'active' JOIN spots s ON s.id = b.spot_id
     WHERE q.status = 'published' AND q.is_active AND NOT q.is_test AND q.id NOT LIKE 'qa-%'`)).rows;
  const defs = new Map((await db.query('SELECT id, title, badge_icon, criteria_version FROM achievement_definitions')).rows.map((d) => [d.id, d]));
  console.log(`content: ${spots.length} spots, ${quests.length} quests, ${munis.length} municipalities`);

  // ---------- users ----------
  const usedHandles = new Set((await db.query('SELECT handle FROM users WHERE handle IS NOT NULL')).rows.map((r) => r.handle));
  const users = [];
  for (let i = 1; i <= USER_COUNT; i++) {
    const female = chance(0.52);
    const first = pick(female ? FIRST_F : FIRST_M);
    const last = pick(SURNAMES);
    const useNick = chance(0.25) && NICK[first];
    const display = `${useNick ? NICK[first] : first} ${last}`;
    let base = `${slugify(first).slice(0, 10)}${pick(['', '_', '.'])}${slugify(last).slice(0, 10)}`.replace(/\./g, '_');
    let handle = base;
    while (usedHandles.has(handle) || handle.length < 3) handle = `${base}${int(1, 99)}`;
    usedHandles.add(handle);
    const fromPangasinan = chance(0.62);
    const home = fromPangasinan ? pick(munis).name : pick(OTHER_HOMETOWNS);
    const tierRoll = rand();
    const tier = tierRoll < 0.08 ? 'power' : tierRoll < 0.45 ? 'regular' : 'casual';
    const created = NOW - DAY * (3 + 150 * Math.pow(rand(), 1.4));
    users.push({
      id: `beta-u-${pad(i)}`, display, handle, home, tier, created, popularity: pareto() * (tier === 'power' ? 4 : tier === 'regular' ? 1.6 : 1),
      bio: pick(BIO).replace('{home}', home), status: pick(STATUS), isPublic: chance(0.95), points: 0, xp: 0, visits: [],
    });
  }

  // ---------- follows (hometown clusters + popular accounts, some reciprocity) ----------
  const byHome = new Map(); for (const u of users) { if (!byHome.has(u.home)) byHome.set(u.home, []); byHome.get(u.home).push(u); }
  const popW = users.map((u) => u.popularity);
  const follows = new Map(); // "a|b" -> time
  const followersOf = new Map(users.map((u) => [u.id, []]));
  const addFollow = (a, b, t) => { if (a.id === b.id) return; const k = `${a.id}|${b.id}`; if (follows.has(k)) return; follows.set(k, t); followersOf.get(b.id).push(a); };
  for (const u of users) {
    const k = Math.min(160, Math.round(Math.exp(Math.log(u.tier === 'power' ? 40 : u.tier === 'regular' ? 14 : 5) + (rand() - 0.5) * 1.2)));
    const local = byHome.get(u.home) || [];
    for (let j = 0; j < k; j++) {
      const target = chance(0.45) && local.length > 1 ? pick(local) : weighted(users, popW);
      addFollow(u, target, recentBetween(Math.max(u.created, target.created)));
    }
  }
  const userById = new Map(users.map((u) => [u.id, u]));
  for (const [k, t] of [...follows]) {
    if (!chance(0.35)) continue;
    const [a, b] = k.split('|');
    addFollow(userById.get(b), userById.get(a), after(t, 60, 72 * 60)); // follow-back
  }

  // ---------- spot interactions ----------
  const spotPop = spots.map(() => pareto());
  const interactions = []; const spotEvents = []; let sae = 0;
  for (const u of users) {
    const n = u.tier === 'power' ? int(15, Math.min(45, spots.length)) : u.tier === 'regular' ? int(5, 18) : int(1, 6);
    const seen = new Set();
    for (let j = 0; j < n; j++) {
      const s = weighted(spots, spotPop); if (seen.has(s.id)) continue; seen.add(s.id);
      const t = recentBetween(u.created);
      interactions.push([u.id, s.id, 'view', t]); spotEvents.push([`beta-sae-${++sae}`, u.id, s.id, 'view', t]);
      if (chance(0.4)) interactions.push([u.id, s.id, 'like', new Date(t.getTime() + 60000)]);
      if (chance(0.2)) { const ts = new Date(t.getTime() + 120000); interactions.push([u.id, s.id, 'save', ts]); spotEvents.push([`beta-sae-${++sae}`, u.id, s.id, 'save', ts]); }
      if (chance(0.1)) { const td = new Date(t.getTime() + 180000); interactions.push([u.id, s.id, 'directions', td]); spotEvents.push([`beta-sae-${++sae}`, u.id, s.id, 'directions', td]); }
    }
  }

  // ---------- quest completions -> visits -> XP -> feed -> badges ----------
  const submissions = []; const visits = []; const progression = []; const activities = []; const awards = [];
  let subN = 0;
  for (const u of users) {
    const p = u.tier === 'power' ? 0.75 : u.tier === 'regular' ? 0.28 : 0.06;
    const done = quests.filter(() => chance(p));
    const timed = done.map((q) => ({ q, t: recentBetween(u.created + DAY) })).sort((a, b) => a.t - b.t);
    for (const { q, t } of timed) {
      const id = `beta-sub-${pad(++subN, 5)}`;
      const reviewed = after(t, 60, 20 * 60);
      const [lat, lng] = jitter(Number(q.gps_lat), Number(q.gps_lng), 40);
      submissions.push([id, id, u.id, q.id, q.marker_code || 'BETA', lat, lng, int(5, 25), 'approved', 'beta-admin', reviewed, t, reviewed, false]);
      visits.push([randomUUID(), u.id, q.spot_id, q.binding_id, muniIdByName.get(q.municipality) || null, id, t, reviewed, q.binding_version || 'v1', false, t]);
      progression.push([randomUUID(), u.id, 'explorer', 50, 'submission_approval', id, 'xp', 'explorer-v1', reviewed, false, reviewed]);
      u.xp += 50; u.points += Number(q.reward_points) || 0; u.visits.push({ spot: q.spot_id, at: reviewed, sub: id });
      activities.push({ id: `beta-act-${activities.length + 1}`, key: `quest_completed:${u.id}:${q.id}`, actor: u, verb: 'quest_completed', type: 'quest', subject: q.id, title: q.title, href: `/quests/${q.id}`, muni: q.municipality, payload: { points: Number(q.reward_points) || 0 }, at: reviewed });
    }
    const badge = (achId, evidence, at) => {
      const d = defs.get(achId); if (!d) return;
      const awardId = randomUUID();
      awards.push([awardId, u.id, achId, 'all_time', evidence, 'v1', d.criteria_version || 'v1', JSON.stringify({ title: d.title, badge_icon: d.badge_icon }), at, false, at]);
      activities.push({ id: `beta-act-${activities.length + 1}`, key: `badge_earned:${awardId}`, actor: u, verb: 'badge_earned', type: 'badge', subject: achId, title: d.title, href: `/profile?badge=${achId}`, muni: null, payload: { icon: d.badge_icon || '🏅' }, at: new Date(at.getTime() + 1000) });
    };
    if (u.visits.length >= 1) badge('first_footstep', `submission_${u.visits[0].sub}`, u.visits[0].at);
    const distinct = [...new Set(u.visits.map((v) => v.spot))];
    if (distinct.length >= 5) { const v5 = u.visits[4]; badge('pangasinan_pioneer', `unique_spots_5_${v5.spot}`, v5.at); }
  }

  // ---------- cheers and comments (mostly from followers) ----------
  const cheers = []; const comments = []; let cmt = 0;
  for (const a of activities) {
    const fans = followersOf.get(a.actor.id);
    const nCheer = Math.min(fans.length + 3, Math.round(pareto() * (1 + fans.length * 0.25)));
    const cheerers = new Set();
    for (let j = 0; j < nCheer; j++) { const c = fans.length && chance(0.85) ? pick(fans) : pick(users); if (c.id !== a.actor.id) cheerers.add(c); }
    for (const c of cheerers) { const t = after(a.at, 2, 2880); cheers.push([a.id, c.id, false, t]); }
    a.cheers = cheerers.size;
    const nComments = chance(0.22) ? int(1, 4) : 0;
    for (let j = 0; j < nComments; j++) {
      const author = fans.length && chance(0.8) ? pick(fans) : pick(users); if (author.id === a.actor.id && j > 0) continue;
      const body = author.id === a.actor.id ? pick(['Salamat! 🙏', 'Tara na next time!', 'Thank you! 😊', 'Sulit talaga!']) : pick(COMMENTS);
      const t = after(a.at, 5, 4320);
      comments.push([`beta-cmt-${++cmt}`, a.id, author.id, body, `beta-cmt-${cmt}`, false, t]);
    }
    a.comments = comments.filter((c) => c[1] === a.id).length;
  }

  const summary = { users: users.length, follows: follows.size, interactions: interactions.length, spotEvents: spotEvents.length, submissions: submissions.length, visits: visits.length, xpEvents: progression.length, badges: awards.length, activities: activities.length, cheers: cheers.length, comments: comments.length };
  console.log('plan:', JSON.stringify(summary));
  if (DRY_RUN) { await db.end(); return; }

  // ---------- write, all or nothing ----------
  await db.query('BEGIN');
  try {
    await insertMany(db, 'users', ['id', 'seed_id', 'display_name', 'email', 'avatar_url', 'role', 'demo_points', 'created_at', 'updated_at', 'is_public', 'handle', 'bio', 'status_text', 'is_test', 'age_eligibility_declared', 'age_declared_at', 'share_activity', 'scout_reputation'],
      users.map((u) => [u.id, u.id, u.display, `${u.handle}@beta.juanderquest.test`, `https://api.dicebear.com/9.x/notionists/svg?seed=${encodeURIComponent(u.handle)}`, 'user', u.points, iso(u.created), iso(NOW), u.isPublic, u.handle, u.bio || null, u.status, false, true, iso(u.created), true, u.visits.length * 20 + (u.visits.length ? int(0, 15) : 0)]));  // 20 rep per verified quest, as the leaderboard's default metric
    await insertMany(db, 'user_engagement_preferences', ['user_id', 'share_achievements'], users.map((u) => [u.id, true]), 'ON CONFLICT DO NOTHING');
    await insertMany(db, 'user_follows', ['follower_id', 'following_id', 'created_at'], [...follows].map(([k, t]) => [...k.split('|'), t]), 'ON CONFLICT DO NOTHING');
    await insertMany(db, 'spot_interactions', ['user_id', 'spot_id', 'interaction_type', 'created_at'], interactions, 'ON CONFLICT DO NOTHING');
    await insertMany(db, 'spot_activity_events', ['id', 'user_id', 'spot_id', 'activity_type', 'created_at'], spotEvents);
    await insertMany(db, 'submissions', ['id', 'idempotency_key', 'user_id', 'quest_id', 'scanned_marker_code', 'captured_lat', 'captured_lng', 'captured_accuracy', 'status', 'reviewed_by', 'reviewed_at', 'created_at', 'updated_at', 'is_test'], submissions);
    await insertMany(db, 'verified_visits', ['id', 'user_id', 'spot_id', 'binding_id', 'municipality_id', 'source_submission_id', 'occurred_at', 'verified_at', 'evidence_version', 'is_test', 'created_at'], visits);
    await insertMany(db, 'progression_events', ['id', 'user_id', 'track', 'delta', 'source_type', 'source_id', 'award_kind', 'rule_version', 'earned_at', 'is_test', 'created_at'], progression);
    await insertMany(db, 'progression_totals', ['user_id', 'explorer_xp', 'civic_xp', 'civic_stamps', 'last_event_at', 'updated_at'],
      users.filter((u) => u.xp > 0).map((u) => [u.id, u.xp, 0, 0, u.visits[u.visits.length - 1].at, iso(NOW)]));
    await insertMany(db, 'achievement_awards', ['id', 'user_id', 'achievement_id', 'season', 'source_evidence_id', 'evidence_version', 'criteria_version', 'criteria_snapshot', 'awarded_at', 'is_test', 'created_at'], awards);
    await insertMany(db, 'social_activities', ['id', 'event_key', 'actor_id', 'verb', 'subject_type', 'subject_id', 'subject_title', 'subject_href', 'municipality', 'payload', 'cheer_count', 'comment_count', 'is_test', 'created_at'],
      activities.map((a) => [a.id, a.key, a.actor.id, a.verb, a.type, a.subject, a.title, a.href, a.muni, JSON.stringify(a.payload), a.cheers, a.comments, false, a.at]));
    await insertMany(db, 'social_cheers', ['activity_id', 'user_id', 'is_test', 'created_at'], cheers, 'ON CONFLICT DO NOTHING');
    await insertMany(db, 'social_comments', ['id', 'activity_id', 'author_id', 'body', 'idempotency_key', 'is_test', 'created_at'], comments);
    // Recount from what actually landed (cheer duplicates were skipped by ON CONFLICT).
    await db.query(`UPDATE social_activities a SET cheer_count = (SELECT count(*) FROM social_cheers c WHERE c.activity_id = a.id),
                    comment_count = (SELECT count(*) FROM social_comments c WHERE c.activity_id = a.id AND c.deleted_at IS NULL) WHERE a.id LIKE 'beta-act-%'`);
    await db.query('COMMIT');
  } catch (err) { await db.query('ROLLBACK'); throw err; }
  console.log('seeded:', JSON.stringify(summary));
  await db.end();
}

if (require.main === module) main().catch((err) => { console.error(err.message || err); process.exit(1); });
module.exports = { COMMENTS, STATUS };
