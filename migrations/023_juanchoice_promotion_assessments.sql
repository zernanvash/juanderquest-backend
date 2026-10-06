-- Iteration 02: Durable Promotion Assessments
-- Record explicit moderator safety and promotion decisions per candidate.

CREATE TABLE IF NOT EXISTS juanchoice_promotion_assessments (
  id UUID PRIMARY KEY,
  candidate_id UUID NOT NULL REFERENCES juanchoice_candidates(id) ON DELETE RESTRICT,
  assessed_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  revision BIGINT NOT NULL CHECK (revision > 0),
  decision TEXT NOT NULL CHECK (decision IN ('cleared', 'restricted')),
  reason TEXT NOT NULL CHECK (char_length(trim(reason)) >= 10 AND char_length(trim(reason)) <= 1000),
  assessed_at TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (candidate_id, revision),
  CHECK (valid_until > assessed_at AND valid_until <= assessed_at + INTERVAL '7 days')
);

CREATE INDEX IF NOT EXISTS idx_juanchoice_assessments_assessed_by
  ON juanchoice_promotion_assessments(assessed_by);

CREATE INDEX IF NOT EXISTS idx_juanchoice_assessments_candidate_revision
  ON juanchoice_promotion_assessments(candidate_id, revision DESC);
