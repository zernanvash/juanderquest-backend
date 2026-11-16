-- Plan 100 WP-7: GPS-derived home town with spoofing guards and user opt-out switch.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS home_town_source TEXT NULL,
  ADD COLUMN IF NOT EXISTS home_town_gps BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE users
SET home_town_source = 'manual'
WHERE home_municipality IS NOT NULL
  AND home_town_source IS NULL;

CREATE TABLE IF NOT EXISTS home_town_sightings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  town_area_id TEXT NOT NULL,
  town_name TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  accuracy_m DOUBLE PRECISION NOT NULL,
  day DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, town_area_id, day)
);

CREATE INDEX IF NOT EXISTS idx_home_town_sightings_user_day
  ON home_town_sightings (user_id, day DESC);
