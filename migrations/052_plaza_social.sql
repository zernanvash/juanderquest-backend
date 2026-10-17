-- Plan 41: Plaza social hub (activities, cheers, comments, weekly standings, privacy)

ALTER TABLE users ADD COLUMN IF NOT EXISTS share_activity BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS social_activities (
  id TEXT PRIMARY KEY,                                   -- 'act_' || uuid
  event_key TEXT NOT NULL UNIQUE CHECK (length(event_key) BETWEEN 1 AND 240),
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verb TEXT NOT NULL CHECK (verb IN (
    'quest_completed','trail_completed','town_completed',
    'badge_earned','level_up','streak_milestone',
    'rank_top10','weekly_champion',
    'spot_posted','first_photo','juanchoice_voted','quiz_aced')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('quest','trail','town','badge','level','streak','rank','spot','campaign','quiz')),
  subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 200),
  subject_title TEXT NOT NULL CHECK (length(subject_title) BETWEEN 1 AND 200),   -- snapshot at creation
  subject_href TEXT NOT NULL CHECK (subject_href LIKE '/%' AND subject_href NOT LIKE '//%' AND length(subject_href) <= 300),
  municipality TEXT,                                     -- for "nearby" matching; may be NULL
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,            -- small, verb-specific (see §5.3)
  cheer_count INTEGER NOT NULL DEFAULT 0 CHECK (cheer_count >= 0),
  comment_count INTEGER NOT NULL DEFAULT 0 CHECK (comment_count >= 0),
  hidden_at TIMESTAMPTZ,                                 -- owner removal or moderation
  hidden_reason TEXT,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_social_activities_feed ON social_activities (is_test, created_at DESC, id DESC) WHERE hidden_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_social_activities_actor ON social_activities (actor_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_social_activities_town ON social_activities (municipality, created_at DESC) WHERE hidden_at IS NULL;

CREATE TABLE IF NOT EXISTS social_cheers (
  activity_id TEXT NOT NULL REFERENCES social_activities(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (activity_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_social_cheers_user ON social_cheers (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS social_comments (
  id TEXT PRIMARY KEY,                                   -- 'cmt_' || uuid
  activity_id TEXT NOT NULL REFERENCES social_activities(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 280),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  report_count INTEGER NOT NULL DEFAULT 0 CHECK (report_count >= 0),
  deleted_at TIMESTAMPTZ,                                -- by author or activity owner
  hidden_at TIMESTAMPTZ,                                 -- by moderation (auto or admin)
  hidden_by TEXT,                                        -- 'auto' or admin user id
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (author_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_social_comments_thread ON social_comments (activity_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS social_comment_reports (
  comment_id TEXT NOT NULL REFERENCES social_comments(id) ON DELETE CASCADE,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('spam','harassment','hate','sexual','misinformation','other')),
  note TEXT CHECK (note IS NULL OR length(note) <= 300),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('hidden','restored','dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (comment_id, reporter_id)
);

CREATE TABLE IF NOT EXISTS plaza_weekly_scores (
  week_start DATE NOT NULL,                              -- Monday (Manila date)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
  quests INTEGER NOT NULL DEFAULT 0 CHECK (quests >= 0),
  home_town TEXT,
  rank INTEGER,                                          -- everyone-board rank this run
  prev_rank INTEGER,                                     -- rank at previous run (for overtakes / ▲▼)
  top10_announced BOOLEAN NOT NULL DEFAULT FALSE,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (week_start, user_id)
);
CREATE INDEX IF NOT EXISTS idx_plaza_weekly_rank ON plaza_weekly_scores (week_start, is_test, rank);

CREATE TABLE IF NOT EXISTS plaza_job_runs (                -- idempotency for weekly finalize / recap
  job_key TEXT PRIMARY KEY,                              -- e.g. 'finalize:2026-W42', 'recap:2026-W42'
  finished_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Weekly league badges (season = week id, e.g. '2026-W42').
INSERT INTO achievement_definitions (id, track, title, description, badge_icon, category, threshold, criteria_version)
VALUES
  ('weekly_champion', 'explorer', 'Weekly Champion', 'Finished #1 on the Plaza weekly board.', '🏆', 'weekly', 1, 'v1'),
  ('weekly_podium',   'explorer', 'Weekly Podium',   'Finished #2 or #3 on the Plaza weekly board.', '🥈', 'weekly', 1, 'v1')
ON CONFLICT (id) DO NOTHING;
