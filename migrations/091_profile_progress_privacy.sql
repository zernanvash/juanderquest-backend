-- 091 (Plan 58): allow travelers to opt in to showing quest progress on their public profile.
ALTER TABLE users ADD COLUMN IF NOT EXISTS progress_public BOOLEAN NOT NULL DEFAULT FALSE;
