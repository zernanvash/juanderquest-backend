-- Initial Database Migration for JuanderQuest Prototype
-- NOTE: id/idempotency_key columns are TEXT (not UUID) so seeded demo ids
-- like 'q1111111-1111-1111-1111-111111111111' work verbatim.

CREATE TYPE user_role AS ENUM ('user', 'admin');
CREATE TYPE quest_category AS ENUM ('eco', 'cultural', 'food_trade');
CREATE TYPE submission_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    seed_id VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    avatar_url TEXT,
    role user_role NOT NULL DEFAULT 'user',
    demo_points INT NOT NULL DEFAULT 0 CHECK (demo_points >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_seed_id ON users(seed_id);

CREATE TABLE IF NOT EXISTS quests (
    id TEXT PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    category quest_category NOT NULL,
    location_name VARCHAR(200) NOT NULL,
    gps_lat DOUBLE PRECISION NOT NULL,
    gps_lng DOUBLE PRECISION NOT NULL,
    radius_meters INT NOT NULL DEFAULT 200,
    reward_points INT NOT NULL DEFAULT 50,
    marker_code VARCHAR(100) UNIQUE NOT NULL,
    marker_image_url TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quests_category ON quests(category);
CREATE INDEX IF NOT EXISTS idx_quests_active ON quests(is_active) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
    scanned_marker_code VARCHAR(100) NOT NULL,
    captured_lat DOUBLE PRECISION NOT NULL,
    captured_lng DOUBLE PRECISION NOT NULL,
    captured_accuracy DOUBLE PRECISION NOT NULL,
    status submission_status NOT NULL DEFAULT 'pending',
    rejection_reason TEXT,
    reviewed_by TEXT REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_submissions_quest ON submissions(quest_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_unique_approved
ON submissions(user_id, quest_id)
WHERE status = 'approved';
