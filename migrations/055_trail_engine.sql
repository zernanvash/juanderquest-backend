-- Plan 44: additive unlockable trail engine foundation. Existing curated IDs
-- remain stable so progression activity keys and collection URLs do not change.
CREATE TABLE IF NOT EXISTS trail_generations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('weekly_batch','admin','personal','benchmark')),
  requested_by TEXT REFERENCES users(id),
  input JSONB NOT NULL,
  constraints JSONB NOT NULL,
  solver TEXT NOT NULL CHECK (solver IN ('local','cuopt','exact')),
  solver_ms INTEGER NOT NULL CHECK (solver_ms >= 0),
  objective NUMERIC NOT NULL,
  result JSONB NOT NULL,
  ai_model TEXT,
  ai_used BOOLEAN NOT NULL DEFAULT FALSE,
  ai_fallback_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trails (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 80),
  tagline TEXT NOT NULL DEFAULT '' CHECK (length(tagline) <= 160),
  tier TEXT NOT NULL CHECK (tier IN ('starter','explorer','signature','legendary','personal')),
  theme TEXT NOT NULL DEFAULT 'mixed',
  municipalities TEXT[] NOT NULL DEFAULT '{}',
  unlock_rule JSONB NOT NULL,
  costing TEXT NOT NULL DEFAULT 'auto' CHECK (costing IN ('auto','pedestrian','bicycle','motorcycle')),
  total_minutes INTEGER NOT NULL CHECK (total_minutes > 0),
  total_km NUMERIC(8,2) NOT NULL CHECK (total_km >= 0),
  story JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','published','retired','rejected')),
  source TEXT NOT NULL CHECK (source IN ('curated','engine','personal')),
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  generation_id TEXT REFERENCES trail_generations(id),
  available_from TIMESTAMPTZ,
  available_until TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  reviewed_by TEXT REFERENCES users(id),
  published_at TIMESTAMPTZ,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((tier = 'personal') = (owner_user_id IS NOT NULL)),
  CHECK ((tier = 'personal') = (source = 'personal'))
);
CREATE INDEX IF NOT EXISTS idx_trails_catalog ON trails (status, tier, is_test) WHERE owner_user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_trails_owner ON trails (owner_user_id, created_at DESC) WHERE owner_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS trail_stops (
  trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  position SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 12),
  spot_id TEXT NOT NULL REFERENCES spots(id) ON DELETE RESTRICT,
  arrive_offset_min INTEGER NOT NULL CHECK (arrive_offset_min >= 0),
  dwell_min INTEGER NOT NULL CHECK (dwell_min BETWEEN 10 AND 240),
  leg_minutes INTEGER NOT NULL DEFAULT 0,
  leg_km NUMERIC(7,2) NOT NULL DEFAULT 0,
  narration TEXT NOT NULL DEFAULT '' CHECK (length(narration) <= 400),
  checkin_radius_m INTEGER NOT NULL DEFAULT 100 CHECK (checkin_radius_m BETWEEN 30 AND 500),
  PRIMARY KEY (trail_id, position),
  UNIQUE (trail_id, spot_id)
);

CREATE TABLE IF NOT EXISTS trail_unlocks (
  trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('free','level','badge','points','owner')),
  price_points INTEGER NOT NULL DEFAULT 0 CHECK (price_points >= 0),
  ledger_group_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (trail_id, user_id)
);

CREATE TABLE IF NOT EXISTS trail_checkins (
  trail_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position SMALLINT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  distance_m INTEGER NOT NULL,
  accuracy_m INTEGER,
  PRIMARY KEY (trail_id, user_id, position),
  FOREIGN KEY (trail_id, position) REFERENCES trail_stops(trail_id, position) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS trail_completions (
  trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trail_version INTEGER NOT NULL,
  reward_points INTEGER NOT NULL,
  ledger_group_id TEXT,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (trail_id, user_id)
);

CREATE TABLE IF NOT EXISTS travel_time_matrix (
  costing TEXT NOT NULL,
  from_spot TEXT NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  to_spot TEXT NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  seconds INTEGER NOT NULL CHECK (seconds >= 0),
  meters INTEGER NOT NULL CHECK (meters >= 0),
  approximate BOOLEAN NOT NULL DEFAULT FALSE,
  graph_label TEXT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (costing, from_spot, to_spot)
);
CREATE INDEX IF NOT EXISTS idx_travel_time_matrix_computed ON travel_time_matrix (costing, computed_at DESC);

CREATE TABLE IF NOT EXISTS trend_digests (
  week_id TEXT PRIMARY KEY,
  signals JSONB NOT NULL,
  digest JSONB NOT NULL,
  ai_model TEXT,
  ai_used BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS ai_cache (
  cache_key TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Idempotent upgrade of available curated trails. The original curated stops
-- have no routing matrix yet, so use an explicitly approximate straight-line
-- estimate at 30 km/h (auto) instead of the misleading 1 min / 1 km sentinel.
-- Runtime matrix refresh can replace these estimates with Valhalla legs.
WITH route_points AS (
  SELECT c.id AS trail_id, cs.order_index, cs.spot_id, s.gps_lat, s.gps_lng,
    row_number() OVER (PARTITION BY c.id ORDER BY cs.order_index, cs.spot_id) AS position
  FROM curated_collections c JOIN curated_collection_spots cs ON cs.collection_id=c.id
  JOIN spots s ON s.id=cs.spot_id
  WHERE c.is_active=TRUE AND c.category='trail'
    AND c.id IN ('coastal_wonders_trail','pangasinan_heritage_trail','pangasinan_eco_escapes','pangasinan_culinary_trail')
    AND s.gps_lat IS NOT NULL AND s.gps_lng IS NOT NULL
), route_legs AS (
  SELECT rp.trail_id, rp.position,
    CASE WHEN prev.spot_id IS NULL THEN 0::double precision ELSE
      6371 * 2 * asin(sqrt(
        sin(radians(rp.gps_lat-prev.gps_lat)/2)^2 +
        cos(radians(prev.gps_lat))*cos(radians(rp.gps_lat))*
        sin(radians(rp.gps_lng-prev.gps_lng)/2)^2)) END AS leg_km
  FROM route_points rp LEFT JOIN route_points prev
    ON prev.trail_id=rp.trail_id AND prev.position=rp.position-1
), route_totals AS (
  SELECT trail_id, COUNT(*)::int AS stop_count,
    SUM(leg_km)::numeric(8,2) AS total_km,
    (SUM(CEIL(leg_km / 30 * 60)) + COUNT(*) * 45)::int AS total_minutes
  FROM route_legs GROUP BY trail_id
)
INSERT INTO trails (id, slug, title, tagline, tier, theme, municipalities, unlock_rule, costing,
  total_minutes, total_km, story, status, source, is_test, created_at)
SELECT c.id, c.id, left(c.title,80), '', 'starter', COALESCE(c.category,'mixed'), '{}',
  '{"type":"free"}'::jsonb, 'auto', totals.total_minutes, totals.total_km, jsonb_build_object('source','curated','intro',c.description,'estimate','straight-line at 30 km/h'),
  'published', 'curated', FALSE, c.created_at
FROM curated_collections c JOIN route_totals totals ON totals.trail_id=c.id WHERE c.is_active=TRUE AND c.category='trail'
  AND c.id IN ('coastal_wonders_trail','pangasinan_heritage_trail','pangasinan_eco_escapes','pangasinan_culinary_trail')
ON CONFLICT (id) DO NOTHING;

WITH route_points AS (
  SELECT c.id AS trail_id, cs.order_index, cs.spot_id, s.gps_lat, s.gps_lng,
    row_number() OVER (PARTITION BY c.id ORDER BY cs.order_index, cs.spot_id) AS position
  FROM curated_collections c JOIN curated_collection_spots cs ON cs.collection_id=c.id
  JOIN spots s ON s.id=cs.spot_id
  WHERE c.is_active=TRUE AND c.category='trail'
    AND c.id IN ('coastal_wonders_trail','pangasinan_heritage_trail','pangasinan_eco_escapes','pangasinan_culinary_trail')
    AND s.gps_lat IS NOT NULL AND s.gps_lng IS NOT NULL
), route_legs AS (
  SELECT rp.*,
    CASE WHEN prev.spot_id IS NULL THEN 0::double precision ELSE
      6371 * 2 * asin(sqrt(
        sin(radians(rp.gps_lat-prev.gps_lat)/2)^2 +
        cos(radians(prev.gps_lat))*cos(radians(rp.gps_lat))*
        sin(radians(rp.gps_lng-prev.gps_lng)/2)^2)) END AS leg_km
  FROM route_points rp LEFT JOIN route_points prev
    ON prev.trail_id=rp.trail_id AND prev.position=rp.position-1
), stop_metrics AS (
  SELECT *, CEIL(leg_km / 30 * 60)::int AS leg_minutes,
    (SUM(CEIL(leg_km / 30 * 60)) OVER (PARTITION BY trail_id ORDER BY position) + (position-1)*45)::int AS arrive_offset_min
  FROM route_legs
)
INSERT INTO trail_stops (trail_id, position, spot_id, arrive_offset_min, dwell_min, leg_minutes, leg_km, narration)
SELECT metrics.trail_id, metrics.position::smallint, metrics.spot_id, metrics.arrive_offset_min,
  45, metrics.leg_minutes, metrics.leg_km, ''
FROM stop_metrics metrics JOIN trails t ON t.id=metrics.trail_id AND t.source='curated'
ON CONFLICT (trail_id, position) DO NOTHING;
