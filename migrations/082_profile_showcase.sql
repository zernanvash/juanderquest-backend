-- Profile showcase (owner 2026-11-08: "add bio, 3 badges equipped" + home town,
-- pasaporte, stats, latest journey and a favourite spot). Up to 3 equipped
-- server badges (achievement ids the user has earned) and one favourite spot.
ALTER TABLE users ADD COLUMN IF NOT EXISTS featured_badges TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS favorite_spot_id TEXT NULL REFERENCES spots(id) ON DELETE SET NULL;
