-- Migration 045: Give QR quest steps private, server-generated marker codes.
-- Existing per-step marker codes are rotated because the earlier public step
-- projections could expose them. Human-readable `hint` values are never codes.
UPDATE quests
SET steps = (
  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN step->>'checkpoint_type' = 'qr' THEN
          jsonb_set(
            step,
            '{marker_code}',
            to_jsonb('JDQ-STEP-' || upper(substr(md5(random()::text || clock_timestamp()::text || quests.id || ordinal::text), 1, 32))),
            true
          )
        ELSE step
      END
      ORDER BY ordinal
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(COALESCE(quests.steps, '[]'::jsonb)) WITH ORDINALITY AS existing_steps(step, ordinal)
)
WHERE jsonb_typeof(quests.steps) = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(quests.steps, '[]'::jsonb)) AS existing_steps(step)
    WHERE step->>'checkpoint_type' = 'qr'
  );
