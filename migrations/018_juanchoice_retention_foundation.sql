-- Phase 5 retention primitives. Existing campaigns are deliberately excluded
-- from streaks until an administrator assigns an official series/round.
ALTER TABLE juanchoice_campaigns ADD COLUMN IF NOT EXISTS series_key TEXT;
ALTER TABLE juanchoice_campaigns ADD COLUMN IF NOT EXISTS round_number BIGINT;
ALTER TABLE juanchoice_campaigns ADD COLUMN IF NOT EXISTS counts_for_streak BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE juanchoice_campaigns ADD CONSTRAINT chk_juanchoice_official_round_identity
  CHECK (
    (counts_for_streak = TRUE AND series_key = 'pangasinan-primary' AND round_number IS NOT NULL AND round_number > 0)
    OR (counts_for_streak = FALSE AND series_key IS NULL AND round_number IS NULL)
  );
CREATE UNIQUE INDEX IF NOT EXISTS uq_juanchoice_official_series_round
  ON juanchoice_campaigns(series_key,round_number)
  WHERE counts_for_streak=TRUE AND status <> 'cancelled';

CREATE TABLE IF NOT EXISTS user_engagement_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  share_achievements BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO achievement_definitions(id,track,title,description,badge_icon,category,threshold,criteria_version)
VALUES
  ('civic_regular_voter','civic','Regular Voter','Participated in 4 consecutive official JuanChoice rounds.','how_to_vote','streak',4,'juanchoice-streak-v1'),
  ('civic_community_supporter','civic','Community Supporter','Participated in 8 consecutive official JuanChoice rounds.','groups','streak',8,'juanchoice-streak-v1'),
  ('civic_tourism_advocate','civic','Tourism Advocate','Participated in 16 consecutive official JuanChoice rounds.','campaign','streak',16,'juanchoice-streak-v1'),
  ('civic_community_pathfinder','civic','Community Pathfinder','Participated in 32 consecutive official JuanChoice rounds.','explore','streak',32,'juanchoice-streak-v1'),
  ('civic_voice_of_pangasinan','civic','Voice of Pangasinan','Participated in 52 consecutive official JuanChoice rounds.','workspace_premium','streak',52,'juanchoice-streak-v1'),
  ('early_discoverer','explorer','Early Discoverer','Verified a destination before it became a JuanChoice winner.','diamond','discovery',1,'juanchoice-early-discovery-v1')
ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS engagement_challenges (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  cadence TEXT NOT NULL CHECK(cadence IN ('weekly','monthly','seasonal')),
  metric TEXT NOT NULL CHECK(metric IN ('verified_visits','unique_destinations','unique_municipalities','juanchoice_participations')),
  target BIGINT NOT NULL CHECK(target > 0),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_engagement_challenges_active
  ON engagement_challenges(starts_at,ends_at,is_test);

CREATE TABLE IF NOT EXISTS community_goals (
  id UUID PRIMARY KEY,
  campaign_id UUID REFERENCES juanchoice_campaigns(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  metric TEXT NOT NULL CHECK(metric IN ('finalized_participants','approved_visits')),
  target BIGINT NOT NULL CHECK(target > 0),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','reached','expired','cancelled')),
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_community_goals_active ON community_goals(status,starts_at,ends_at,is_test);

CREATE TABLE IF NOT EXISTS community_goal_unlocks (
  goal_id UUID PRIMARY KEY REFERENCES community_goals(id) ON DELETE RESTRICT,
  observed_count BIGINT NOT NULL CHECK(observed_count >= 0),
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rule_version TEXT NOT NULL,
  outbox_event_id UUID UNIQUE REFERENCES outbox_events(id) ON DELETE RESTRICT
);
