CREATE TABLE IF NOT EXISTS spots (
  id TEXT PRIMARY KEY,
  slug VARCHAR(180) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  category VARCHAR(50) NOT NULL,
  subcategory VARCHAR(50) NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  municipality VARCHAR(100) NOT NULL,
  address TEXT NOT NULL,
  gps_lat DOUBLE PRECISION NOT NULL,
  gps_lng DOUBLE PRECISION NOT NULL,
  price_level SMALLINT NOT NULL DEFAULT 0 CHECK (price_level BETWEEN 0 AND 4),
  hours JSONB NOT NULL DEFAULT '{}'::jsonb,
  amenities JSONB NOT NULL DEFAULT '[]'::jsonb,
  image_url TEXT NOT NULL DEFAULT '',
  source_type VARCHAR(30) NOT NULL,
  source_name VARCHAR(150) NOT NULL,
  source_url TEXT,
  trust_level VARCHAR(30) NOT NULL DEFAULT 'community',
  status VARCHAR(30) NOT NULL DEFAULT 'published',
  quest_id TEXT REFERENCES quests(id) ON DELETE SET NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_spots_location ON spots(gps_lat, gps_lng);
CREATE INDEX IF NOT EXISTS idx_spots_category ON spots(category, subcategory);
CREATE INDEX IF NOT EXISTS idx_spots_status ON spots(status);

CREATE TABLE IF NOT EXISTS discovery_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  occasions JSONB NOT NULL DEFAULT '[]'::jsonb,
  price_levels JSONB NOT NULL DEFAULT '[]'::jsonb,
  radius_km INT NOT NULL DEFAULT 25,
  onboarding_state VARCHAR(20) NOT NULL DEFAULT 'pending',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS spot_interactions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spot_id TEXT NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  interaction_type VARCHAR(30) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, spot_id, interaction_type)
);
CREATE INDEX IF NOT EXISTS idx_spot_interactions_recent ON spot_interactions(spot_id, created_at DESC);
