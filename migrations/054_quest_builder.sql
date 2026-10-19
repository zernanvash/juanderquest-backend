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
-- 3. Demote unverified action 'view_story' to required: false
UPDATE quests
SET steps = (
  SELECT COALESCE(
    jsonb_agg(
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
            'fence', jsonb_build_object(
              'lat', COALESCE((step->>'gps_lat')::numeric, quests.gps_lat, 16.0),
              'lng', COALESCE((step->>'gps_lng')::numeric, quests.gps_lng, 120.0),
              'radius_meters', COALESCE((step->>'radius_meters')::numeric, 100)
            ),
            'marker_code', COALESCE(step->>'marker_code', 'JDQ-STEP-' || upper(substr(md5(random()::text || clock_timestamp()::text || quests.id || ordinal::text), 1, 32)))
          )
          WHEN step->>'checkpoint_type' = 'photo' THEN jsonb_build_object(
            'type', 'photo',
            'prompt', COALESCE(step->>'hint', step->>'description', step->>'title', 'Take a photo'),
            'fence', CASE
              WHEN step ? 'gps_lat' AND step ? 'gps_lng' THEN jsonb_build_object(
                'lat', (step->>'gps_lat')::numeric,
                'lng', (step->>'gps_lng')::numeric,
                'radius_meters', COALESCE((step->>'radius_meters')::numeric, 100)
              )
              ELSE null
            END,
            'require_gps', (step ? 'gps_lat' AND step ? 'gps_lng')
          )
          WHEN step->>'checkpoint_type' = 'ar' THEN jsonb_build_object(
            'type', 'ar',
            'fence', jsonb_build_object(
              'lat', COALESCE((step->>'gps_lat')::numeric, quests.gps_lat, 16.0),
              'lng', COALESCE((step->>'gps_lng')::numeric, quests.gps_lng, 120.0),
              'radius_meters', LEAST(150, GREATEST(30, COALESCE((step->>'radius_meters')::numeric, 50)))
            ),
            'object', CASE
              WHEN step->>'object' IN ('token', 'gem', 'beacon', 'box') THEN step->>'object'
              ELSE 'token'
            END,
            'color', CASE
              WHEN step->>'color' IN ('#FFB703', '#2D6A4F', '#3B82F6', '#E11D48') THEN step->>'color'
              ELSE '#FFB703'
            END
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
              'spot_id', COALESCE(step->>'action_target_id', quests.id)
            )
          )
          ELSE jsonb_build_object(
            'type', 'location',
            'fence', jsonb_build_object(
              'lat', COALESCE((step->>'gps_lat')::numeric, quests.gps_lat, 16.0),
              'lng', COALESCE((step->>'gps_lng')::numeric, quests.gps_lng, 120.0),
              'radius_meters', COALESCE((step->>'radius_meters')::numeric, 100)
            )
          )
        END,
        'gps_lat', COALESCE((step->>'gps_lat')::numeric, quests.gps_lat, 16.0),
        'gps_lng', COALESCE((step->>'gps_lng')::numeric, quests.gps_lng, 120.0),
        'radius_meters', COALESCE((step->>'radius_meters')::numeric, 100),
        'hint', step->>'hint',
        'marker_code', step->>'marker_code'
      )
      ORDER BY ordinal
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(COALESCE(quests.steps, '[]'::jsonb)) WITH ORDINALITY AS existing_steps(step, ordinal)
)
WHERE jsonb_typeof(quests.steps) = 'array'
  AND jsonb_array_length(quests.steps) > 0;
