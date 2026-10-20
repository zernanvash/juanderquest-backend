-- Migration 054: Quest Builder (order mode, per-task tracking, per-task review)
-- Supports multi-task quests, any-order vs sequential unlock, per-task review states,
-- and upgrades existing v1 steps to canonical v2 QuestTask structures.

ALTER TABLE quests ADD COLUMN IF NOT EXISTS step_order_mode TEXT NOT NULL DEFAULT 'sequential'
  CHECK (step_order_mode IN ('sequential','any'));

ALTER TABLE quest_attempts ADD COLUMN IF NOT EXISTS step_order_mode TEXT NOT NULL DEFAULT 'sequential'
  CHECK (step_order_mode IN ('sequential','any'));

ALTER TABLE quest_step_evidence ADD COLUMN IF NOT EXISTS task_key TEXT;
ALTER TABLE quest_step_evidence ADD COLUMN IF NOT EXISTS failed_tries INT NOT NULL DEFAULT 0;
ALTER TABLE quest_step_evidence ADD COLUMN IF NOT EXISTS first_try_at TIMESTAMPTZ;
ALTER TABLE quest_step_evidence ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE quest_step_evidence ADD COLUMN IF NOT EXISTS needs_changes_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_step_evidence_quest_task ON quest_step_evidence (quest_id, task_key, status);

-- Upgrade existing v1 quest steps to v2 in-place:
-- 1. Assign stable task_key ('task_' || md5(id || '_' || ordinal)) if missing
-- 2. Construct verification object based on checkpoint_type & existing coordinates/prompt/marker_code
--    - QR: fall back to quests.marker_code (never invent a random code); if absent, mark needs_new_qr_sheet: true
--    - Coordinates: fall back to quests.gps_lat/gps_lng only (never fabricate 16.0/120.0); if missing, set fence: null and needs_author_review: true
--    - Action spot_id: fall back to the quest's active reviewed_quest_spot_bindings.spot_id or spots.id where spots.quest_id = quests.id (never quests.id)
-- 3. Demote unverified action 'view_story' to required: false
UPDATE quests
SET steps = (
  SELECT COALESCE(
    jsonb_agg(
      jsonb_strip_nulls(
        jsonb_build_object(
          'key', COALESCE(step->>'key', 'task_' || md5(quests.id || '_' || ordinal::text)),
          'step_order', ordinal::int,
          'title', COALESCE(step->>'title', 'Task ' || ordinal::text),
          'description', COALESCE(step->>'description', ''),
          'required', CASE
            WHEN step->>'checkpoint_type' = 'action' AND step->>'action_kind' = 'view_story' THEN false
            WHEN step->>'required' = 'false' THEN false
            ELSE true
          END,
          'checkpoint_type', COALESCE(step->>'checkpoint_type', 'location'),
          'verification', CASE
            WHEN step ? 'verification' THEN step->'verification'
            WHEN step->>'checkpoint_type' = 'qr' THEN jsonb_build_object(
              'type', 'qr',
              'fence', CASE
                WHEN COALESCE((step->>'gps_lat')::numeric, quests.gps_lat) IS NOT NULL
                 AND COALESCE((step->>'gps_lng')::numeric, quests.gps_lng) IS NOT NULL
                THEN jsonb_build_object(
                  'lat', COALESCE((step->>'gps_lat')::numeric, quests.gps_lat),
                  'lng', COALESCE((step->>'gps_lng')::numeric, quests.gps_lng),
                  'radius_meters', COALESCE((step->>'radius_meters')::numeric, 100)
                )
                ELSE null
              END,
              'marker_code', COALESCE(NULLIF(trim(step->>'marker_code'), ''), NULLIF(trim(quests.marker_code), '')),
              'needs_new_qr_sheet', (COALESCE(NULLIF(trim(step->>'marker_code'), ''), NULLIF(trim(quests.marker_code), '')) IS NULL),
              'needs_author_review', (
                COALESCE((step->>'gps_lat')::numeric, quests.gps_lat) IS NULL
                OR COALESCE((step->>'gps_lng')::numeric, quests.gps_lng) IS NULL
                OR COALESCE(NULLIF(trim(step->>'marker_code'), ''), NULLIF(trim(quests.marker_code), '')) IS NULL
              )
            )
            WHEN step->>'checkpoint_type' = 'photo' THEN jsonb_build_object(
              'type', 'photo',
              'prompt', COALESCE(step->>'hint', step->>'description', step->>'title', 'Take a photo'),
              'fence', CASE
                WHEN step ? 'gps_lat' AND step ? 'gps_lng'
                 AND (step->>'gps_lat') IS NOT NULL AND (step->>'gps_lng') IS NOT NULL
                THEN jsonb_build_object(
                  'lat', (step->>'gps_lat')::numeric,
                  'lng', (step->>'gps_lng')::numeric,
                  'radius_meters', COALESCE((step->>'radius_meters')::numeric, 100)
                )
                ELSE null
              END,
              'require_gps', (step ? 'gps_lat' AND step ? 'gps_lng' AND (step->>'gps_lat') IS NOT NULL AND (step->>'gps_lng') IS NOT NULL)
            )
            WHEN step->>'checkpoint_type' = 'ar' THEN jsonb_build_object(
              'type', 'ar',
              'fence', CASE
                WHEN COALESCE((step->>'gps_lat')::numeric, quests.gps_lat) IS NOT NULL
                 AND COALESCE((step->>'gps_lng')::numeric, quests.gps_lng) IS NOT NULL
                THEN jsonb_build_object(
                  'lat', COALESCE((step->>'gps_lat')::numeric, quests.gps_lat),
                  'lng', COALESCE((step->>'gps_lng')::numeric, quests.gps_lng),
                  'radius_meters', LEAST(150, GREATEST(30, COALESCE((step->>'radius_meters')::numeric, 50)))
                )
                ELSE null
              END,
              'object', CASE
                WHEN step->>'object' IN ('token', 'gem', 'beacon', 'box') THEN step->>'object'
                ELSE 'token'
              END,
              'color', CASE
                WHEN step->>'color' IN ('#FFB703', '#2D6A4F', '#3B82F6', '#E11D48') THEN step->>'color'
                ELSE '#FFB703'
              END,
              'needs_author_review', (
                COALESCE((step->>'gps_lat')::numeric, quests.gps_lat) IS NULL
                OR COALESCE((step->>'gps_lng')::numeric, quests.gps_lng) IS NULL
              )
            )
            WHEN step->>'checkpoint_type' = 'action' THEN jsonb_build_object(
              'type', 'action',
              'task', jsonb_build_object(
                'kind', CASE
                  WHEN step->>'action_kind' = 'complete_quiz' THEN 'complete_quiz'
                  WHEN step->>'action_kind' = 'like_spot' THEN 'like_spot'
                  WHEN step->>'action_kind' = 'vote_juanchoice' THEN 'vote_juanchoice'
                  ELSE 'save_spot'
                END,
                'spot_id', COALESCE(
                  NULLIF(trim(step->>'action_target_id'), ''),
                  (SELECT b.spot_id FROM reviewed_quest_spot_bindings b WHERE b.quest_id = quests.id AND b.status = 'active' LIMIT 1),
                  (SELECT s.id FROM spots s WHERE s.quest_id = quests.id ORDER BY s.created_at ASC LIMIT 1)
                )
              ),
              'needs_author_review', (
                COALESCE(
                  NULLIF(trim(step->>'action_target_id'), ''),
                  (SELECT b.spot_id FROM reviewed_quest_spot_bindings b WHERE b.quest_id = quests.id AND b.status = 'active' LIMIT 1),
                  (SELECT s.id FROM spots s WHERE s.quest_id = quests.id ORDER BY s.created_at ASC LIMIT 1)
                ) IS NULL
              )
            )
            ELSE jsonb_build_object(
              'type', 'location',
              'fence', CASE
                WHEN COALESCE((step->>'gps_lat')::numeric, quests.gps_lat) IS NOT NULL
                 AND COALESCE((step->>'gps_lng')::numeric, quests.gps_lng) IS NOT NULL
                THEN jsonb_build_object(
                  'lat', COALESCE((step->>'gps_lat')::numeric, quests.gps_lat),
                  'lng', COALESCE((step->>'gps_lng')::numeric, quests.gps_lng),
                  'radius_meters', COALESCE((step->>'radius_meters')::numeric, 100)
                )
                ELSE null
              END,
              'needs_author_review', (
                COALESCE((step->>'gps_lat')::numeric, quests.gps_lat) IS NULL
                OR COALESCE((step->>'gps_lng')::numeric, quests.gps_lng) IS NULL
              )
            )
          END,
          'gps_lat', COALESCE((step->>'gps_lat')::numeric, quests.gps_lat),
          'gps_lng', COALESCE((step->>'gps_lng')::numeric, quests.gps_lng),
          'radius_meters', COALESCE((step->>'radius_meters')::numeric, 100),
          'hint', step->>'hint',
          'marker_code', CASE
            WHEN step->>'checkpoint_type' = 'qr' THEN COALESCE(NULLIF(trim(step->>'marker_code'), ''), NULLIF(trim(quests.marker_code), ''))
            ELSE step->>'marker_code'
          END,
          'needs_new_qr_sheet', CASE
            WHEN step->>'checkpoint_type' = 'qr'
             AND COALESCE(NULLIF(trim(step->>'marker_code'), ''), NULLIF(trim(quests.marker_code), '')) IS NULL
            THEN true
            ELSE null
          END,
          'needs_author_review', CASE
            WHEN step->>'checkpoint_type' IN ('location', 'qr', 'ar')
             AND (COALESCE((step->>'gps_lat')::numeric, quests.gps_lat) IS NULL OR COALESCE((step->>'gps_lng')::numeric, quests.gps_lng) IS NULL)
            THEN true
            WHEN step->>'checkpoint_type' = 'qr'
             AND COALESCE(NULLIF(trim(step->>'marker_code'), ''), NULLIF(trim(quests.marker_code), '')) IS NULL
            THEN true
            WHEN step->>'checkpoint_type' = 'action'
             AND COALESCE(
               NULLIF(trim(step->>'action_target_id'), ''),
               (SELECT b.spot_id FROM reviewed_quest_spot_bindings b WHERE b.quest_id = quests.id AND b.status = 'active' LIMIT 1),
               (SELECT s.id FROM spots s WHERE s.quest_id = quests.id ORDER BY s.created_at ASC LIMIT 1)
             ) IS NULL
            THEN true
            ELSE null
          END
        )
      )
      ORDER BY ordinal
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(COALESCE(quests.steps, '[]'::jsonb)) WITH ORDINALITY AS existing_steps(step, ordinal)
)
WHERE jsonb_typeof(quests.steps) = 'array'
  AND jsonb_array_length(quests.steps) > 0;
