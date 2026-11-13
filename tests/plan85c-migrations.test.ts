import { createTestDb } from '../src/db/testHarness.js';

const describeRealPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

describeRealPg('Plan 85c: database tidy migrations 083–085', () => {
  it('applies 083 indexes, 084 duplicate drops & check constraints, and 085 empty dead-table drops', async () => {
    const testDb = await createTestDb();
    try {
      const schema = (await testDb.pool.query('SELECT current_schema() AS s')).rows[0].s as string;

      const expectedIndexes = [
        'idx_trail_checkins_user_id',
        'idx_trail_unlocks_user_id',
        'idx_trail_completions_user_id',
        'idx_trail_stops_spot_id',
        'idx_spots_created_by',
        'idx_spots_quest_id',
        'idx_juanchoice_ballots_user_id',
        'idx_juanchoice_participations_user_id',
        'idx_juanchoice_ballot_events_campaign_id',
        'idx_juanchoice_ballot_events_user_id',
        'idx_juanchoice_candidates_spot_id',
        'idx_juanchoice_receipts_user_id',
        'idx_plaza_weekly_scores_user_id',
        'idx_redemptions_voucher_id',
        'idx_vouchers_merchant_id',
        'idx_travel_time_matrix_from_spot',
        'idx_travel_time_matrix_to_spot',
        'idx_achievement_awards_achievement_id',
        'idx_admin_area_assignments_area_id',
        'idx_cultural_quiz_attempts_version_id',
        'idx_cultural_quiz_attempt_answers_question_id',
        'idx_curated_collection_spots_spot_id',
        'idx_quest_funding_contributions_funder_user_id',
        'idx_quest_funding_holds_submission_id',
        'idx_reward_appeals_user_id',
        'idx_spot_activity_events_user_id',
        'idx_user_daily_missions_mission_id',
        'idx_user_cosmetics_item_id',
      ];

      const idxRes = await testDb.pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1`, [schema]);
      const indexSet = new Set(idxRes.rows.map((r: { indexname: string }) => r.indexname));
      for (const idx of expectedIndexes) {
        expect(indexSet.has(idx)).toBe(true);
      }

      const droppedDuplicates = [
        'idx_users_seed_id',
        'idx_admin_areas_psgc',
        'idx_social_activities_event_key',
        'idx_juanchoice_periods_recent',
        'idx_juanchoice_assessments_candidate_revision',
        'idx_cultural_quiz_versions_quiz',
        'idx_cultural_quiz_options_question',
        'idx_cultural_quiz_questions_version',
      ];
      for (const dup of droppedDuplicates) {
        expect(indexSet.has(dup)).toBe(false);
      }

      const chkRes = await testDb.pool.query(
        `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_namespace n ON n.oid = c.connamespace
         WHERE n.nspname = $1 AND c.contype = 'c'`,
        [schema],
      );
      const chkSet = new Set(chkRes.rows.map((r: { conname: string }) => r.conname));
      for (const con of [
        'chk_spots_status',
        'chk_spot_assets_status',
        'chk_merchants_status',
        'chk_merchant_memberships_role',
        'chk_merchant_memberships_status',
        'chk_auth_mail_outbox_status',
        'chk_daily_missions_kind',
        'chk_streak_shield_events_kind',
        'chk_governance_ledger_type',
      ]) {
        expect(chkSet.has(con)).toBe(true);
      }

      await expect(
        testDb.pool.query(
          `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng, source_type, source_name, status, is_test)
           VALUES ('bad-spot', 'bad-spot', 'Bad', 'Bad', 'Heritage', 'Museum', 'Lingayen', 'Lingayen', 16.0, 120.0, 'editorial', 'test', 'invalid_status', false)`,
        ),
      ).rejects.toThrow(/chk_spots_status/);

      const tblRes = await testDb.pool.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename IN ('auth_sessions', 'lgu_operator_scopes')`,
        [schema],
      );
      expect(tblRes.rows).toHaveLength(0);
    } finally {
      await testDb.close();
    }
  }, 120_000);
});
