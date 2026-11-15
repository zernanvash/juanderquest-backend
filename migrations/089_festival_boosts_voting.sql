-- 089 (Plan 94): staff choose per festival whether it boosts that week's JuanChoice vote.
-- Default TRUE keeps today's behaviour for existing rows.
ALTER TABLE juanchoice_festivals ADD COLUMN IF NOT EXISTS boosts_voting BOOLEAN NOT NULL DEFAULT TRUE;
