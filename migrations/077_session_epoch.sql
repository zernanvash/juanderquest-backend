-- Plan 72 Phase 3: Session epoch invalidation
-- Adds a durable monotonic session epoch to users.
-- Incremented upon password reset or global session revocation ("sign out everywhere")
-- to invalidate existing session JWTs.

ALTER TABLE users ADD COLUMN IF NOT EXISTS session_epoch INTEGER NOT NULL DEFAULT 0;
