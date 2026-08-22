CREATE TABLE IF NOT EXISTS spot_assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_provider VARCHAR(30) NOT NULL,
  object_key TEXT NOT NULL,
  url TEXT NOT NULL,
  mime_type VARCHAR(50) NOT NULL,
  width INT NOT NULL DEFAULT 0,
  height INT NOT NULL DEFAULT 0,
  size_bytes INT NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  spot_id TEXT REFERENCES spots(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_spot_assets_user ON spot_assets(user_id);
CREATE INDEX IF NOT EXISTS idx_spot_assets_spot ON spot_assets(spot_id);
CREATE INDEX IF NOT EXISTS idx_spot_assets_status ON spot_assets(status);
