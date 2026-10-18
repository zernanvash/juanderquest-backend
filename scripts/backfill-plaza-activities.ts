import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { closePool, getPool, initPostgres } from '../src/db/pool.js';
import { getExplorerLevel } from '../src/progression/levels.js';

type Verb = 'quest_completed' | 'town_completed' | 'spot_posted' | 'level_up' | 'badge_earned' | 'trail_completed';
interface Candidate {
  eventKey: string; actorId: string; verb: Verb; subjectType: string; subjectId: string;
  subjectTitle: string; subjectHref: string; municipality: string | null;
  payload: Record<string, unknown>; isTest: boolean; createdAt: Date;
}
const VERBS: Verb[] = ['quest_completed', 'town_completed', 'spot_posted', 'level_up', 'badge_earned', 'trail_completed'];
const asDate = (value: unknown) => value instanceof Date ? value : new Date(String(value));
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

/** Collects only reconstructible, currently visible events. No producer is called: producers enqueue pushes. */
export async function collectPlazaCandidates(client: PoolClient): Promise<Candidate[]> {
  const candidates = new Map<string, Candidate>();
  const add = (candidate: Candidate) => {
    if (!candidate.subjectTitle.trim() || !Number.isFinite(candidate.createdAt.getTime())) return;
    const prior = candidates.get(candidate.eventKey);
    if (!prior || candidate.createdAt < prior.createdAt) candidates.set(candidate.eventKey, candidate);
  };

  const { rows: completions } = await client.query(`
    SELECT x.user_id, x.quest_id, x.event_at, q.title, q.is_test,
           COALESCE(s.municipality, q.location_name) AS municipality
      FROM (
        SELECT sub.user_id, sub.quest_id, COALESCE(sub.reviewed_at, pe.earned_at) AS event_at, sub.is_test
          FROM submissions sub
          LEFT JOIN progression_events pe ON pe.source_type = 'submission_approval'
            AND pe.source_id = sub.id AND pe.user_id = sub.user_id AND pe.is_test = sub.is_test
            AND pe.reversal_of IS NULL
         WHERE sub.status = 'approved' AND COALESCE(sub.reviewed_at, pe.earned_at) IS NOT NULL
        UNION ALL
        SELECT qa.user_id, qa.quest_id, qa.completed_at AS event_at, q2.is_test
          FROM quest_attempts qa JOIN quests q2 ON q2.id = qa.quest_id
         WHERE qa.status = 'completed' AND qa.completed_at IS NOT NULL
      ) x
      JOIN quests q ON q.id = x.quest_id
      JOIN users u ON u.id = x.user_id
      LEFT JOIN LATERAL (
        SELECT sp.municipality FROM reviewed_quest_spot_bindings b
          JOIN spots sp ON sp.id = b.spot_id AND sp.status = 'published' AND sp.is_test = q.is_test
         WHERE b.quest_id = q.id AND b.status = 'active' LIMIT 1
      ) s ON TRUE
     WHERE q.status = 'published' AND q.is_active = TRUE
       AND x.event_at IS NOT NULL AND x.is_test = q.is_test AND q.is_test = u.is_test
       AND u.is_public = TRUE AND u.share_activity = TRUE`);
  const completedByUser = new Map<string, Map<string, Date>>();
  for (const row of completions) {
    const eventAt = asDate(row.event_at);
    add({ eventKey: `quest_completed:${row.user_id}:${row.quest_id}`, actorId: row.user_id,
      verb: 'quest_completed', subjectType: 'quest', subjectId: row.quest_id,
      subjectTitle: row.title, subjectHref: `/quests/${row.quest_id}`,
      // Current quest reward_points may differ from the historical payout. Omit
      // the optional badge rather than presenting a fabricated award amount.
      municipality: row.municipality || null, payload: {},
      isTest: row.is_test, createdAt: eventAt });
    const key = `${row.user_id}\u0000${row.is_test}`;
    const byQuest = completedByUser.get(key) ?? new Map<string, Date>();
    const prior = byQuest.get(row.quest_id);
    if (!prior || eventAt < prior) byQuest.set(row.quest_id, eventAt);
    completedByUser.set(key, byQuest);
  }

  const { rows: catalog } = await client.query(`
    SELECT q.id, q.is_test, COALESCE(s.municipality, q.location_name) AS municipality
      FROM quests q
      LEFT JOIN LATERAL (
        SELECT sp.municipality FROM reviewed_quest_spot_bindings b
          JOIN spots sp ON sp.id = b.spot_id AND sp.status = 'published' AND sp.is_test = q.is_test
         WHERE b.quest_id = q.id AND b.status = 'active' LIMIT 1
      ) s ON TRUE
     WHERE q.status = 'published' AND q.is_active = TRUE`);
  const towns = new Map<string, { name: string; test: boolean; quests: string[] }>();
  for (const row of catalog) {
    if (!row.municipality) continue;
    const key = `${row.is_test}\u0000${row.municipality}`;
    const town = towns.get(key) ?? { name: row.municipality, test: row.is_test, quests: [] };
    town.quests.push(row.id);
    towns.set(key, town);
  }
  for (const [userScope, byQuest] of completedByUser) {
    const [userId, test] = userScope.split('\u0000');
    for (const town of towns.values()) {
      if (String(town.test) !== test || town.quests.length < 2 || !town.quests.every(id => byQuest.has(id))) continue;
      const muniSlug = slug(town.name);
      if (!muniSlug) continue;
      const eventAt = new Date(Math.max(...town.quests.map(id => byQuest.get(id)!.getTime())));
      add({ eventKey: `town_completed:${userId}:${muniSlug}`, actorId: userId,
        verb: 'town_completed', subjectType: 'town', subjectId: muniSlug,
        subjectTitle: town.name, subjectHref: `/map?area=${muniSlug}`, municipality: town.name,
        payload: { quests: town.quests.length }, isTest: town.test, createdAt: eventAt });
    }
  }

  const { rows: spots } = await client.query(`
    SELECT s.id, s.slug, s.name, s.municipality, s.created_by, s.created_at
      FROM spots s JOIN users u ON u.id = s.created_by
     WHERE s.status = 'published' AND s.is_test = FALSE AND u.is_test = FALSE
       AND u.is_public = TRUE AND u.share_activity = TRUE`);
  for (const row of spots) add({ eventKey: `spot_posted:${row.id}`, actorId: row.created_by,
    verb: 'spot_posted', subjectType: 'spot', subjectId: row.id, subjectTitle: row.name,
    subjectHref: `/spots/${row.slug || row.id}`, municipality: row.municipality || null,
    payload: {}, isTest: false, createdAt: asDate(row.created_at) });

  const { rows: levels } = await client.query(`
    SELECT p.user_id, p.explorer_xp, u.is_test
      FROM progression_totals p JOIN users u ON u.id = p.user_id
     WHERE u.is_public = TRUE AND u.share_activity = TRUE`);
  const { rows: xpEvents } = await client.query(`
    SELECT e.user_id, e.delta, e.earned_at, e.is_test
      FROM progression_events e JOIN users u ON u.id = e.user_id
     WHERE e.track = 'explorer' AND e.is_test = u.is_test
       AND u.is_public = TRUE AND u.share_activity = TRUE
     ORDER BY e.user_id, e.earned_at, e.created_at, e.id`);
  const xpByUser = new Map<string, typeof xpEvents>();
  for (const event of xpEvents) {
    const list = xpByUser.get(event.user_id) ?? [];
    list.push(event);
    xpByUser.set(event.user_id, list);
  }
  for (const row of levels) {
    const current = getExplorerLevel(Number(row.explorer_xp));
    if (current.level <= 1) continue;
    const threshold = 50 * (current.level - 1) * current.level;
    let running = 0;
    for (const event of xpByUser.get(row.user_id) ?? []) {
      const previous = running;
      running += Number(event.delta);
      if (previous < threshold && running >= threshold) {
        add({ eventKey: `level_up:${row.user_id}:${current.level}`, actorId: row.user_id,
          verb: 'level_up', subjectType: 'level', subjectId: `explorer-${current.level}`,
          subjectTitle: `Level ${current.level} · ${current.title}`, subjectHref: '/profile',
          municipality: null, payload: { level: current.level, title: current.title },
          isTest: row.is_test, createdAt: asDate(event.earned_at) });
        break;
      }
    }
  }

  const { rows: awards } = await client.query(`
    SELECT a.id, a.user_id, a.achievement_id, a.awarded_at, a.is_test,
           a.criteria_snapshot, d.title, d.badge_icon
      FROM achievement_awards a JOIN achievement_definitions d ON d.id = a.achievement_id
      JOIN users u ON u.id = a.user_id
     WHERE a.revoked_at IS NULL AND a.is_test = u.is_test
       AND u.is_public = TRUE AND u.share_activity = TRUE`);
  const { rows: collections } = await client.query(`
    SELECT c.id, c.title, c.badge_id, COUNT(cs.spot_id)::int AS stops
      FROM curated_collections c LEFT JOIN curated_collection_spots cs ON cs.collection_id = c.id
     WHERE c.is_active = TRUE
     GROUP BY c.id, c.title, c.badge_id`);
  for (const row of awards) {
    const matching = collections.filter(col => col.badge_id === row.achievement_id);
    if (matching.length > 1) continue; // Ambiguous collection provenance; do not invent a trail.
    const common = { actorId: row.user_id, municipality: null, isTest: row.is_test,
      createdAt: asDate(row.awarded_at) };
    if (matching.length === 1) {
      const col = matching[0];
      add({ ...common, eventKey: `trail_completed:${row.user_id}:${col.id}`,
        verb: 'trail_completed', subjectType: 'trail', subjectId: col.id,
        subjectTitle: col.title, subjectHref: `/trail?collection=${col.id}`,
        payload: { stops: Number(col.stops) || 5 } });
    } else if (!row.achievement_id.startsWith('weekly_')) {
      const snap = row.criteria_snapshot || {};
      add({ ...common, eventKey: `badge_earned:${row.id}`,
        verb: 'badge_earned', subjectType: 'badge', subjectId: row.achievement_id,
        subjectTitle: row.title || snap.title || row.achievement_id,
        subjectHref: `/profile?badge=${row.achievement_id}`,
        payload: { icon: row.badge_icon || snap.badge_icon || '🏅' } });
    }
  }
  return [...candidates.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.eventKey.localeCompare(b.eventKey));
}

export async function backfillPlazaActivities(client: PoolClient, apply = false) {
  await client.query('BEGIN');
  try {
    // Serializes concurrent invocations without changing any source tables.
    await client.query('SELECT pg_advisory_xact_lock($1)', [52024101]);
    const candidates = await collectPlazaCandidates(client);
    const counts = Object.fromEntries(VERBS.map(verb => [verb, { eligible: 0, inserted: 0, existing: 0 }])) as
      Record<Verb, { eligible: number; inserted: number; existing: number }>;
    for (const row of candidates) {
      const count = counts[row.verb];
      count.eligible++;
      if (apply) {
        const result = await client.query(`INSERT INTO social_activities
          (id, event_key, actor_id, verb, subject_type, subject_id, subject_title, subject_href,
           municipality, payload, is_test, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (event_key) DO NOTHING RETURNING id`,
          [`act_${randomUUID()}`, row.eventKey, row.actorId, row.verb, row.subjectType,
            row.subjectId, row.subjectTitle.trim().slice(0, 200), row.subjectHref,
            row.municipality, JSON.stringify(row.payload), row.isTest, row.createdAt]);
        if (result.rowCount) count.inserted++; else count.existing++;
      } else {
        const result = await client.query('SELECT 1 FROM social_activities WHERE event_key = $1', [row.eventKey]);
        if (result.rowCount) count.existing++; else count.inserted++;
      }
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    return counts;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply' && arg !== '--dry-run') || args.includes('--apply') && args.includes('--dry-run')) {
    throw new Error('Usage: backfill-plaza-activities.ts [--dry-run|--apply]');
  }
  if (process.env.DB_MIGRATION_MODE !== 'verify' || process.env.SEED_DEVELOPMENT_DATA === 'true') {
    throw new Error('Backfill requires DB_MIGRATION_MODE=verify and no development seeding.');
  }
  await initPostgres();
  const pool = getPool();
  if (!pool) throw new Error('PostgreSQL is required for Plaza backfill.');
  const client = await pool.connect();
  try {
    const apply = args.includes('--apply');
    const counts = await backfillPlazaActivities(client, apply);
    console.log(`[plaza-backfill] mode=${apply ? 'apply' : 'dry-run'} (dry-run inserted = would insert)`);
    for (const verb of VERBS) console.log(`[plaza-backfill] ${verb} eligible=${counts[verb].eligible} inserted=${counts[verb].inserted} existing=${counts[verb].existing}`);
    console.log('[plaza-backfill] skipped: undated approved submissions/completed attempts (original event time unknown), historical quest points badge (payout amount not reconstructible), first_photo (photo attribution/timing), JuanChoice/quiz/streak/rank events (source snapshots and historical eligibility not reliable), revoked awards, ambiguous trail badges, private/opted-out actors, hidden or cross-scope subjects.');
  } finally {
    client.release();
    await closePool();
  }
}

if (process.argv[1] && /backfill-plaza-activities\.(ts|js)$/.test(process.argv[1])) {
  main().catch(error => { console.error('[plaza-backfill] failed:', error.message); process.exitCode = 1; });
}
