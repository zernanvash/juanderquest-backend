import { randomInt, randomUUID } from 'crypto';
import { getPool } from '../db/pool.js';
import { nextWeekStartUtc, weekStartUtc } from '../social/time.js';

// Plan 77: AR mini-games ("Laro ng Lahi"). A game is one more way to finish an
// AR task; winning gives the task's normal reward and nothing else (owner:
// "no badges for those"). Scores only feed the leaderboards.

export const AR_GAMES = ['tumbang_preso', 'shooting_hoop', 'pana', 'pabitin_palayok', 'sipa'] as const;
export type ArGame = (typeof AR_GAMES)[number];

/** Palayok is ranked by time to break: lower is better. */
export const lowerIsBetter = (game: string) => game === 'pabitin_palayok';

/** A passed session lets the task's evidence in for this long. */
export const SESSION_EVIDENCE_WINDOW_MS = 30 * 60 * 1000;

export interface ArGameSession {
  id: string;
  user_id: string;
  quest_id: string;
  task_key: string;
  game: ArGame;
  seed: number;
  started_at: Date;
  finished_at: Date | null;
  status: 'open' | 'finished' | 'rejected';
  score: number | null;
  passed: boolean | null;
  stats: Record<string, unknown>;
  is_test: boolean;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

/**
 * Is this result possible? Returns a reason when it is not. Server elapsed time
 * is the only clock trusted; the limits are the AR Lab rules the owner tested.
 */
export function implausibleReason(
  game: ArGame,
  elapsedMs: number,
  score: number,
  passed: boolean,
  stats: Record<string, unknown>,
): string | null {
  if (!Number.isInteger(score) || score < 0) return 'score_invalid';
  switch (game) {
    case 'tumbang_preso': {
      const knocks = num(stats.knocks);
      if (elapsedMs < 8000) return 'too_fast';
      if (score > 325) return 'score_cap';
      if (!(knocks >= 0 && knocks <= 10)) return 'stats_invalid';
      return passed === knocks >= 4 ? null : 'passed_mismatch';
    }
    case 'shooting_hoop': {
      const baskets = num(stats.baskets);
      if (elapsedMs < 8000) return 'too_fast';
      if (score > 30) return 'score_cap';
      if (!(baskets >= 0 && baskets <= 10)) return 'stats_invalid';
      return passed === baskets >= 4 ? null : 'passed_mismatch';
    }
    case 'pana':
      // Plan 77b: 6 arrows, at most 15 each (the golden bangus); 28 passes.
      if (elapsedMs < 6000) return 'too_fast';
      if (score > 90) return 'score_cap';
      return passed === score >= 28 ? null : 'passed_mismatch';
    case 'pabitin_palayok':
      if (!passed) return 'passed_mismatch';
      if (score < 1500) return 'too_fast';
      return score <= elapsedMs ? null : 'score_after_elapsed';
    case 'sipa':
      if (score > Math.floor(elapsedMs / 1200)) return 'too_fast';
      return passed === score >= 5 ? null : 'passed_mismatch';
  }
}

// ---------------------------------------------------------------- store

const memory = new Map<string, ArGameSession>();

function mapRow(r: any): ArGameSession {
  return {
    id: r.id,
    user_id: r.user_id,
    quest_id: r.quest_id,
    task_key: r.task_key,
    game: r.game,
    seed: Number(r.seed),
    started_at: new Date(r.started_at),
    finished_at: r.finished_at ? new Date(r.finished_at) : null,
    status: r.status,
    score: r.score == null ? null : Number(r.score),
    passed: r.passed == null ? null : Boolean(r.passed),
    stats: r.stats ?? {},
    is_test: Boolean(r.is_test),
  };
}

export async function startSession(input: {
  userId: string;
  questId: string;
  taskKey: string;
  game: ArGame;
  isTest: boolean;
}): Promise<ArGameSession> {
  const seed = randomInt(1, 2 ** 31 - 1);
  const pool = getPool();
  if (!pool) {
    const s: ArGameSession = {
      id: randomUUID(),
      user_id: input.userId,
      quest_id: input.questId,
      task_key: input.taskKey,
      game: input.game,
      seed,
      started_at: new Date(),
      finished_at: null,
      status: 'open',
      score: null,
      passed: null,
      stats: {},
      is_test: input.isTest,
    };
    memory.set(s.id, s);
    return s;
  }
  const { rows } = await pool.query(
    `INSERT INTO ar_game_sessions (user_id, quest_id, task_key, game, seed, is_test)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.userId, input.questId, input.taskKey, input.game, seed, input.isTest],
  );
  return mapRow(rows[0]);
}

export async function findSession(id: string): Promise<ArGameSession | null> {
  const pool = getPool();
  if (!pool) return memory.get(id) ?? null;
  const { rows } = await pool.query('SELECT * FROM ar_game_sessions WHERE id = $1', [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Closes an open session; false when it was not open any more (a race). */
export async function closeSession(
  id: string,
  result: { status: 'finished' | 'rejected'; score: number; passed: boolean; stats: Record<string, unknown> },
): Promise<boolean> {
  const pool = getPool();
  if (!pool) {
    const s = memory.get(id);
    if (!s || s.status !== 'open') return false;
    Object.assign(s, result, { finished_at: new Date() });
    return true;
  }
  const res = await pool.query(
    `UPDATE ar_game_sessions
        SET status = $2, score = $3, passed = $4, stats = $5::jsonb, finished_at = now()
      WHERE id = $1 AND status = 'open'`,
    [id, result.status, result.score, result.passed, JSON.stringify(result.stats)],
  );
  return (res.rowCount ?? 0) === 1;
}

// ---------------------------------------------------------------- boards

export type BoardScope =
  { kind: 'place'; questId: string; taskKey: string } | { kind: 'week'; game: ArGame; now?: Date };

export interface BoardEntry {
  rank: number;
  user_id: string | null;
  display_name: string;
  handle: string | null;
  score: number;
  game: string;
  finished_at: string;
  is_self: boolean;
}

interface BestRow {
  user_id: string;
  game: string;
  score: number;
  finished_at: Date;
  display_name: string;
  handle: string | null;
  is_public: boolean;
}

/** Each player's best finished score in the scope, best first; ties go to the earlier finish. */
async function bestRows(scope: BoardScope): Promise<BestRow[]> {
  const pool = getPool();
  const where: string[] = ["s.status = 'finished'", 'NOT s.is_test'];
  const params: unknown[] = [];
  if (scope.kind === 'place') {
    params.push(scope.questId, scope.taskKey);
    where.push('s.quest_id = $1', 's.task_key = $2');
  } else {
    const now = scope.now ?? new Date();
    params.push(scope.game, weekStartUtc(now), nextWeekStartUtc(now));
    where.push('s.game = $1', 's.finished_at >= $2', 's.finished_at < $3');
  }
  if (!pool) {
    const rows = [...memory.values()].filter(
      (s) =>
        s.status === 'finished' &&
        !s.is_test &&
        s.finished_at &&
        (scope.kind === 'place'
          ? s.quest_id === scope.questId && s.task_key === scope.taskKey
          : s.game === scope.game &&
            s.finished_at >= weekStartUtc(scope.now ?? new Date()) &&
            s.finished_at < nextWeekStartUtc(scope.now ?? new Date())),
    );
    return pickBest(
      rows.map((s) => ({
        user_id: s.user_id,
        game: s.game,
        score: s.score ?? 0,
        finished_at: s.finished_at!,
        display_name: 'Explorer',
        handle: null,
        is_public: true,
      })),
    );
  }
  // A place's task has one game, but read it from the rows so a task whose
  // game was changed later ranks each game on its own terms.
  const { rows } = await pool.query(
    `SELECT s.user_id, s.game, s.score, s.finished_at, u.display_name, u.handle, u.is_public
       FROM ar_game_sessions s
       JOIN users u ON u.id = s.user_id AND NOT COALESCE(u.is_test, false)
      WHERE ${where.join(' AND ')}`,
    params,
  );
  const mapped: BestRow[] = rows.map((r: any) => ({
    user_id: r.user_id,
    game: r.game,
    score: Number(r.score),
    finished_at: new Date(r.finished_at),
    display_name: r.display_name,
    handle: r.handle ?? null,
    is_public: Boolean(r.is_public),
  }));
  return pickBest(mapped);
}

function better(a: BestRow, b: BestRow): number {
  if (a.score !== b.score) return lowerIsBetter(a.game) ? a.score - b.score : b.score - a.score;
  return a.finished_at.getTime() - b.finished_at.getTime();
}

function pickBest(rows: BestRow[]): BestRow[] {
  const best = new Map<string, BestRow>();
  for (const r of rows) {
    const cur = best.get(r.user_id);
    if (!cur || better(r, cur) < 0) best.set(r.user_id, r);
  }
  return [...best.values()].sort(better);
}

export async function getBoard(scope: BoardScope, viewerId: string | null, limit = 20) {
  const all = await bestRows(scope);
  const entry = (r: BestRow, i: number): BoardEntry => {
    const self = r.user_id === viewerId;
    const shown = r.is_public || self;
    return {
      rank: i + 1,
      user_id: shown ? r.user_id : null,
      display_name: shown ? r.display_name : 'Anonymous Explorer',
      handle: shown ? r.handle : null,
      score: r.score,
      game: r.game,
      finished_at: r.finished_at.toISOString(),
      is_self: self,
    };
  };
  const meIndex = viewerId ? all.findIndex((r) => r.user_id === viewerId) : -1;
  return {
    entries: all.slice(0, limit).map(entry),
    me: meIndex >= 0 ? entry(all[meIndex], meIndex) : null,
    total: all.length,
    lower_is_better: scope.kind === 'week' ? lowerIsBetter(scope.game) : all.length > 0 && lowerIsBetter(all[0].game),
  };
}

/**
 * The latest finished, passed session for this player's task, if it ended
 * within the evidence window. The evidence route needs it for a game task.
 */
export async function passedSessionFor(
  sessionId: string,
  userId: string,
  questId: string,
  taskKey: string,
  game: string,
  now = new Date(),
): Promise<ArGameSession | null> {
  const s = await findSession(sessionId);
  if (!s || s.user_id !== userId || s.quest_id !== questId || s.task_key !== taskKey || s.game !== game) return null;
  if (s.status !== 'finished' || s.passed !== true || !s.finished_at) return null;
  return now.getTime() - s.finished_at.getTime() <= SESSION_EVIDENCE_WINDOW_MS ? s : null;
}
