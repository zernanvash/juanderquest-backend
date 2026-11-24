-- Plan 118: Pending destination relocation requests for pin moves > 200 m.
CREATE TABLE IF NOT EXISTS spot_relocation_requests (
  id TEXT PRIMARY KEY,
  spot_id TEXT NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_lat DOUBLE PRECISION NOT NULL,
  from_lng DOUBLE PRECISION NOT NULL,
  to_lat DOUBLE PRECISION NOT NULL,
  to_lng DOUBLE PRECISION NOT NULL,
  distance_m INT NOT NULL,
  accuracy_m DOUBLE PRECISION NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  reviewed_by TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ NULL,
  review_note TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_spot_relocation_open
  ON spot_relocation_requests(spot_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_spot_relocation_status_created
  ON spot_relocation_requests(status, created_at DESC);
