-- Migration 047: Enforce one durable submission per challenge nonce across workers.
CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_challenge_nonce
  ON submissions(scanned_marker_code)
  WHERE scanned_marker_code LIKE 'CHALLENGE:%';
