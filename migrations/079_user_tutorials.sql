-- First-run tutorial (owner 2026-11-04): which tutorials an account has seen,
-- as key -> ISO time, so a tutorial shows once per account even after the
-- app's data is cleared or on a new phone.
ALTER TABLE users ADD COLUMN IF NOT EXISTS tutorials_seen JSONB NOT NULL DEFAULT '{}'::jsonb;
