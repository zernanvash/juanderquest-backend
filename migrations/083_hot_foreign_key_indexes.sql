-- Plan 85c (D1): Indexes for hot unindexed foreign keys filtered or joined per user, spot, trail, quest, merchant, or voucher.
-- Note: For zero-downtime live apply outside a transaction, run each statement with CREATE INDEX CONCURRENTLY IF NOT EXISTS.

CREATE INDEX IF NOT EXISTS idx_trail_checkins_user_id ON trail_checkins (user_id);
CREATE INDEX IF NOT EXISTS idx_trail_unlocks_user_id ON trail_unlocks (user_id);
CREATE INDEX IF NOT EXISTS idx_trail_completions_user_id ON trail_completions (user_id);
CREATE INDEX IF NOT EXISTS idx_trail_stops_spot_id ON trail_stops (spot_id);
CREATE INDEX IF NOT EXISTS idx_spots_created_by ON spots (created_by);
CREATE INDEX IF NOT EXISTS idx_spots_quest_id ON spots (quest_id);
CREATE INDEX IF NOT EXISTS idx_juanchoice_ballots_user_id ON juanchoice_ballots (user_id);
CREATE INDEX IF NOT EXISTS idx_juanchoice_participations_user_id ON juanchoice_participations (user_id);
CREATE INDEX IF NOT EXISTS idx_juanchoice_ballot_events_campaign_id ON juanchoice_ballot_events (campaign_id);
CREATE INDEX IF NOT EXISTS idx_juanchoice_ballot_events_user_id ON juanchoice_ballot_events (user_id);
CREATE INDEX IF NOT EXISTS idx_juanchoice_candidates_spot_id ON juanchoice_candidates (spot_id);
CREATE INDEX IF NOT EXISTS idx_juanchoice_receipts_user_id ON juanchoice_receipts (user_id);
CREATE INDEX IF NOT EXISTS idx_plaza_weekly_scores_user_id ON plaza_weekly_scores (user_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_voucher_id ON redemptions (voucher_id);
CREATE INDEX IF NOT EXISTS idx_vouchers_merchant_id ON vouchers (merchant_id);
CREATE INDEX IF NOT EXISTS idx_travel_time_matrix_from_spot ON travel_time_matrix (from_spot);
CREATE INDEX IF NOT EXISTS idx_travel_time_matrix_to_spot ON travel_time_matrix (to_spot);
CREATE INDEX IF NOT EXISTS idx_achievement_awards_achievement_id ON achievement_awards (achievement_id);
CREATE INDEX IF NOT EXISTS idx_admin_area_assignments_area_id ON admin_area_assignments (area_id);
CREATE INDEX IF NOT EXISTS idx_cultural_quiz_attempts_version_id ON cultural_quiz_attempts (version_id);
CREATE INDEX IF NOT EXISTS idx_cultural_quiz_attempt_answers_question_id ON cultural_quiz_attempt_answers (question_id);
CREATE INDEX IF NOT EXISTS idx_curated_collection_spots_spot_id ON curated_collection_spots (spot_id);
CREATE INDEX IF NOT EXISTS idx_quest_funding_contributions_funder_user_id ON quest_funding_contributions (funder_user_id);
CREATE INDEX IF NOT EXISTS idx_quest_funding_holds_submission_id ON quest_funding_holds (submission_id);
CREATE INDEX IF NOT EXISTS idx_reward_appeals_user_id ON reward_appeals (user_id);
CREATE INDEX IF NOT EXISTS idx_spot_activity_events_user_id ON spot_activity_events (user_id);
CREATE INDEX IF NOT EXISTS idx_user_daily_missions_mission_id ON user_daily_missions (mission_id);
CREATE INDEX IF NOT EXISTS idx_user_cosmetics_item_id ON user_cosmetics (item_id);
