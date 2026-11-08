-- Home town (owner 2026-11-08): the town the traveler says they are from.
-- Chosen by the user, not inferred from where they play, because travelers do
-- most quests away from home. NULL = not set (or not from Pangasinan).
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_municipality TEXT NULL;
