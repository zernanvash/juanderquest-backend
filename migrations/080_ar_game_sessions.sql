-- Plan 77: AR mini-game sessions ("Laro ng Lahi"). A game is one more way to
-- finish an AR task; a finished, passed session lets the task's evidence in.
-- Scores feed the per-place (all-time) and Pangasinan weekly boards. No rewards.
CREATE TABLE IF NOT EXISTS ar_game_sessions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  game TEXT NOT NULL CHECK (game IN ('tumbang_preso','shooting_hoop','pana','pabitin_palayok','sipa')),
  seed INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','finished','rejected')),
  score INTEGER,                        -- Palayok: ms to break (lower is better)
  passed BOOLEAN,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_test BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS ar_game_sessions_board ON ar_game_sessions (quest_id, task_key, game, status, score);
CREATE INDEX IF NOT EXISTS ar_game_sessions_week ON ar_game_sessions (game, finished_at) WHERE status = 'finished' AND NOT is_test;
CREATE INDEX IF NOT EXISTS ar_game_sessions_user ON ar_game_sessions (user_id, started_at DESC);
