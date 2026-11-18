-- Plan 108: Merchant sponsorship conditions and unmet-condition override audit fields.
ALTER TABLE quest_sponsorships
  ADD COLUMN IF NOT EXISTS conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS accepted_with_unmet JSONB NULL,
  ADD COLUMN IF NOT EXISTS override_acknowledged_at TIMESTAMPTZ NULL;
