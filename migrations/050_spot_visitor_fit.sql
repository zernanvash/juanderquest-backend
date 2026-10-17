-- 050_spot_visitor_fit.sql
-- Add traveler fit tags (good_for, best_time) and make price_level optional.

ALTER TABLE spots ADD COLUMN IF NOT EXISTS good_for JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE spots ADD COLUMN IF NOT EXISTS best_time JSONB NOT NULL DEFAULT '[]'::jsonb;

-- New community posts no longer state a price; NULL means "not provided", never "Free".
ALTER TABLE spots ALTER COLUMN price_level DROP NOT NULL;
ALTER TABLE spots ALTER COLUMN price_level DROP DEFAULT;
