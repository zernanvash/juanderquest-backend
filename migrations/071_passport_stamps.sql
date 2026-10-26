-- Migration 071: Passport Stamps, Daily Rewards, Streaks and Question of the Day
-- Append-only stamp ledger with a transactional balance cache. Stamps are earned
-- only, non-transferable, and never touch governance_ledger or points_accounts.
-- QotD uses its own curated pool so rewarded cultural quizzes never leak answers.

CREATE TABLE IF NOT EXISTS stamp_ledger (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta INT NOT NULL,
    source TEXT NOT NULL,
    source_key TEXT NOT NULL,
    manila_date DATE NOT NULL,
    week_id TEXT NOT NULL,
    reason TEXT,
    is_test BOOLEAN NOT NULL DEFAULT FALSE,
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

-- Curated QotD pool. Never draws from cultural_quiz_questions, which belong to
-- rewarded quiz runs.
CREATE TABLE IF NOT EXISTS qotd_questions (
    id TEXT PRIMARY KEY,
    question_text TEXT NOT NULL,
    explanation TEXT NOT NULL,
    source_url TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qotd_questions_active ON qotd_questions (active, created_at);

CREATE TABLE IF NOT EXISTS qotd_options (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL REFERENCES qotd_questions(id) ON DELETE CASCADE,
    ordinal SMALLINT NOT NULL CHECK (ordinal BETWEEN 1 AND 4),
    option_text TEXT NOT NULL,
    is_correct BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT uq_qotd_option_ordinal UNIQUE (question_id, ordinal)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_qotd_one_correct
    ON qotd_options (question_id) WHERE is_correct;

CREATE TABLE IF NOT EXISTS question_of_the_day (
    manila_date DATE PRIMARY KEY,
    question_id TEXT NOT NULL REFERENCES qotd_questions(id) ON DELETE CASCADE,
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

INSERT INTO qotd_questions (id, question_text, explanation, source_url, active) VALUES
    ('qotd-seed-capital', 'Which town is the capital of Pangasinan?',
     'Lingayen is the provincial capital of Pangasinan; Dagupan City is the province''s largest city in population.', NULL, TRUE),
    ('qotd-seed-hundred-islands', 'Which city administers the Hundred Islands National Park?',
     'Alaminos City administers the Hundred Islands National Park off its coast.', NULL, TRUE),
    ('qotd-seed-patar', 'Patar Beach is located in which municipality?',
     'Patar Beach is a well-known white-sand beach in Bolinao, Pangasinan.', NULL, TRUE),
    ('qotd-seed-calasiao', 'Which Pangasinan town is known for its sweet rice cakes called puto?',
     'Calasiao is famous for its soft, sweet rice cakes sold in the town market.', NULL, TRUE),
    ('qotd-seed-bangus', 'Which city is widely called the Bangus Capital of the Philippines?',
     'Dagupan City is widely known for its bangus (milkfish) industry and dishes.', NULL, TRUE),
    ('qotd-seed-agno', 'Which major river flows through Pangasinan?',
     'The Agno River rises in the Cordillera and flows through Pangasinan to Lingayen Gulf.', NULL, TRUE),
    ('qotd-seed-manaoag', 'Which town is home to the Our Lady of Manaoag shrine?',
     'Manaoag is a major pilgrimage town in Pangasinan, centered on the Manaoag shrine.', NULL, TRUE),
    ('qotd-seed-capitol', 'The Pangasinan Provincial Capitol stands in which town?',
     'The neoclassical Pangasinan Provincial Capitol is in Lingayen, facing Lingayen Gulf.', NULL, TRUE),
    ('qotd-seed-lighthouse', 'Cape Bolinao Lighthouse is located in which municipality?',
     'Cape Bolinao Lighthouse stands on Punta Piedra in Bolinao, Pangasinan.', NULL, TRUE),
    ('qotd-seed-salt', 'The name Pangasinan is commonly translated as which phrase?',
     'Pangasinan is commonly rendered as "place where salt is made", reflecting its salt-making heritage.', NULL, TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO qotd_options (id, question_id, ordinal, option_text, is_correct) VALUES
    ('qotd-seed-capital-a', 'qotd-seed-capital', 1, 'Lingayen', TRUE),
    ('qotd-seed-capital-b', 'qotd-seed-capital', 2, 'Dagupan City', FALSE),
    ('qotd-seed-capital-c', 'qotd-seed-capital', 3, 'Alaminos City', FALSE),
    ('qotd-seed-capital-d', 'qotd-seed-capital', 4, 'Urdaneta City', FALSE),
    ('qotd-seed-hundred-islands-a', 'qotd-seed-hundred-islands', 1, 'Dagupan City', FALSE),
    ('qotd-seed-hundred-islands-b', 'qotd-seed-hundred-islands', 2, 'Alaminos City', TRUE),
    ('qotd-seed-hundred-islands-c', 'qotd-seed-hundred-islands', 3, 'San Carlos City', FALSE),
    ('qotd-seed-hundred-islands-d', 'qotd-seed-hundred-islands', 4, 'Urdaneta City', FALSE),
    ('qotd-seed-patar-a', 'qotd-seed-patar', 1, 'Anda', FALSE),
    ('qotd-seed-patar-b', 'qotd-seed-patar', 2, 'Agno', FALSE),
    ('qotd-seed-patar-c', 'qotd-seed-patar', 3, 'Bolinao', TRUE),
    ('qotd-seed-patar-d', 'qotd-seed-patar', 4, 'Sual', FALSE),
    ('qotd-seed-calasiao-a', 'qotd-seed-calasiao', 1, 'Binalonan', FALSE),
    ('qotd-seed-calasiao-b', 'qotd-seed-calasiao', 2, 'Villasis', FALSE),
    ('qotd-seed-calasiao-c', 'qotd-seed-calasiao', 3, 'Rosales', FALSE),
    ('qotd-seed-calasiao-d', 'qotd-seed-calasiao', 4, 'Calasiao', TRUE),
    ('qotd-seed-bangus-a', 'qotd-seed-bangus', 1, 'Alaminos City', FALSE),
    ('qotd-seed-bangus-b', 'qotd-seed-bangus', 2, 'Dagupan City', TRUE),
    ('qotd-seed-bangus-c', 'qotd-seed-bangus', 3, 'San Carlos City', FALSE),
    ('qotd-seed-bangus-d', 'qotd-seed-bangus', 4, 'Urdaneta City', FALSE),
    ('qotd-seed-agno-a', 'qotd-seed-agno', 1, 'Agno River', TRUE),
    ('qotd-seed-agno-b', 'qotd-seed-agno', 2, 'Cagayan River', FALSE),
    ('qotd-seed-agno-c', 'qotd-seed-agno', 3, 'Pasig River', FALSE),
    ('qotd-seed-agno-d', 'qotd-seed-agno', 4, 'Bicol River', FALSE),
    ('qotd-seed-manaoag-a', 'qotd-seed-manaoag', 1, 'Bayambang', FALSE),
    ('qotd-seed-manaoag-b', 'qotd-seed-manaoag', 2, 'Mangaldan', FALSE),
    ('qotd-seed-manaoag-c', 'qotd-seed-manaoag', 3, 'Manaoag', TRUE),
    ('qotd-seed-manaoag-d', 'qotd-seed-manaoag', 4, 'Mapandan', FALSE),
    ('qotd-seed-capitol-a', 'qotd-seed-capitol', 1, 'Dagupan City', FALSE),
    ('qotd-seed-capitol-b', 'qotd-seed-capitol', 2, 'Alaminos City', FALSE),
    ('qotd-seed-capitol-c', 'qotd-seed-capitol', 3, 'San Carlos City', FALSE),
    ('qotd-seed-capitol-d', 'qotd-seed-capitol', 4, 'Lingayen', TRUE),
    ('qotd-seed-lighthouse-a', 'qotd-seed-lighthouse', 1, 'Anda', FALSE),
    ('qotd-seed-lighthouse-b', 'qotd-seed-lighthouse', 2, 'Bolinao', TRUE),
    ('qotd-seed-lighthouse-c', 'qotd-seed-lighthouse', 3, 'Sual', FALSE),
    ('qotd-seed-lighthouse-d', 'qotd-seed-lighthouse', 4, 'Infanta', FALSE),
    ('qotd-seed-salt-a', 'qotd-seed-salt', 1, 'Place where salt is made', TRUE),
    ('qotd-seed-salt-b', 'qotd-seed-salt', 2, 'Land of gold', FALSE),
    ('qotd-seed-salt-c', 'qotd-seed-salt', 3, 'River of rice', FALSE),
    ('qotd-seed-salt-d', 'qotd-seed-salt', 4, 'Home of the brave', FALSE)
ON CONFLICT (id) DO NOTHING;
