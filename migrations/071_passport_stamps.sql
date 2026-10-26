-- Migration 071: Passport Stamps, Daily Rewards, Streaks and Question of the Day
-- Append-only stamp ledger with a transactional balance cache. Stamps are earned
-- only, non-transferable, and never touch governance_ledger or points_accounts.

CREATE TABLE IF NOT EXISTS stamp_ledger (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta INT NOT NULL,
    source TEXT NOT NULL,
    source_key TEXT NOT NULL,
    manila_date DATE NOT NULL,
    week_id TEXT NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_stamp_ledger_source UNIQUE (user_id, source, source_key)
);

CREATE INDEX IF NOT EXISTS idx_stamp_ledger_user ON stamp_ledger (user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_stamp_ledger_week ON stamp_ledger (user_id, week_id) WHERE delta > 0;

CREATE TABLE IF NOT EXISTS stamp_balances (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance INT NOT NULL DEFAULT 0 CHECK (balance >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daily_claims (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    manila_date DATE NOT NULL,
    cycle_day SMALLINT NOT NULL CHECK (cycle_day BETWEEN 1 AND 7),
    stamps INT NOT NULL CHECK (stamps >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, manila_date)
);

CREATE TABLE IF NOT EXISTS daily_missions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    stamps INT NOT NULL CHECK (stamps BETWEEN 1 AND 100),
    on_site BOOLEAN NOT NULL DEFAULT FALSE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_daily_missions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    manila_date DATE NOT NULL,
    mission_id TEXT NOT NULL REFERENCES daily_missions(id) ON DELETE CASCADE,
    progress INT NOT NULL DEFAULT 0 CHECK (progress >= 0),
    target INT NOT NULL DEFAULT 1 CHECK (target >= 1),
    completed_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, manila_date, mission_id)
);

CREATE INDEX IF NOT EXISTS idx_user_daily_missions_day ON user_daily_missions (user_id, manila_date);

CREATE TABLE IF NOT EXISTS user_streaks (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    current_streak INT NOT NULL DEFAULT 0 CHECK (current_streak >= 0),
    best_streak INT NOT NULL DEFAULT 0 CHECK (best_streak >= 0),
    last_claim_date DATE,
    shields_held SMALLINT NOT NULL DEFAULT 0 CHECK (shields_held >= 0 AND shields_held <= 10),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS streak_shield_events (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    source_key TEXT NOT NULL,
    delta SMALLINT NOT NULL,
    manila_date DATE NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_streak_shield_event UNIQUE (user_id, kind, source_key)
);

CREATE INDEX IF NOT EXISTS idx_streak_shield_events_user ON streak_shield_events (user_id, id DESC);

CREATE TABLE IF NOT EXISTS question_of_the_day (
    manila_date DATE PRIMARY KEY,
    question_id TEXT NOT NULL REFERENCES cultural_quiz_questions(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS qotd_answers (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    manila_date DATE NOT NULL,
    selected_option_id TEXT NOT NULL,
    correct BOOLEAN NOT NULL,
    answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, manila_date)
);

INSERT INTO daily_missions (id, kind, title, stamps, on_site, active) VALUES
    ('mission-qotd', 'qotd', 'Answer the Question of the Day', 5, FALSE, TRUE),
    ('mission-cheer', 'cheer_post', 'Cheer a Plaza post', 5, FALSE, TRUE),
    ('mission-story', 'read_story', 'Read a destination story', 5, FALSE, TRUE),
    ('mission-checkin', 'check_in', 'Check in at a destination', 10, TRUE, TRUE),
    ('mission-quest-step', 'quest_step', 'Complete a quest step', 10, TRUE, TRUE)
ON CONFLICT (kind) DO NOTHING;
