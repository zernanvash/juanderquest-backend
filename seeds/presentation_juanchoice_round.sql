-- One-off presentation-only JuanChoice slate. Never run against the alpha DB.
-- All timestamps are explicit Asia/Manila (+08:00); no official series or
-- monthly schedule relationship is created. Replays verify and do not mutate.
BEGIN;
SELECT set_config('jdq.presentation_campaign_id', :'campaign_id', true);

DO $presentation$
DECLARE
  demo_id uuid := current_setting('jdq.presentation_campaign_id')::uuid;
  demo_slug text := 'juanchoice-coastal-demo-2026-10';
  demo_theme text := 'Coastal Discoveries — Presentation Demo';
  opens timestamptz := '2026-10-04 12:00:00+08'::timestamptz;
  closes timestamptz := '2026-10-06 20:00:00+08'::timestamptz;
  slate text[] := ARRAY[
    'spot-cabongaoan-beach',      -- Burgos: alternative coast
    'spot-cape-bolinao-lighthouse', -- Bolinao: coastal heritage
    'spot-tambobong-beach',       -- Dasol: fishing-village beach
    'spot-tondol-beach'           -- Anda: shallow sandbar
  ];
  existing juanchoice_campaigns%ROWTYPE;
  now_at_db timestamptz := clock_timestamp();
BEGIN
  IF current_database() <> 'juanderquest_presentation' THEN
    RAISE EXCEPTION 'Presentation seed refuses database %', current_database();
  END IF;
  IF now_at_db >= closes THEN
    RAISE EXCEPTION 'Presentation window expired; review a new explicit schedule';
  END IF;
  IF (SELECT COUNT(*) FROM juanchoice_schedule_periods) <> 0 THEN
    RAISE EXCEPTION 'Presentation database contains monthly schedule periods';
  END IF;
  IF EXISTS (SELECT 1 FROM juanchoice_campaigns WHERE id <> demo_id AND status <> 'draft') THEN
    RAISE EXCEPTION 'Another published campaign exists in the presentation database';
  END IF;
  IF (SELECT COUNT(DISTINCT municipality) FROM spots WHERE id = ANY(slate)) <> 4 OR
     (SELECT COUNT(*) FROM spots WHERE id = ANY(slate) AND status = 'published'
       AND is_test = FALSE AND recommendation_suppressed = FALSE
       AND source_type = 'editorial') <> 4 THEN
    RAISE EXCEPTION 'Reviewed 4-spot editorial slate is missing or ineligible';
  END IF;

  SELECT * INTO existing FROM juanchoice_campaigns WHERE id = demo_id FOR UPDATE;
  IF FOUND THEN
    IF existing.slug <> demo_slug OR existing.region <> 'pangasinan' OR
       existing.theme <> demo_theme OR existing.opens_at <> opens OR
       existing.closes_at <> closes OR existing.is_test <> FALSE OR
       existing.series_key IS NOT NULL OR existing.round_number IS NOT NULL OR
       existing.counts_for_streak <> FALSE OR
       existing.status NOT IN ('scheduled','voting','closed','finalized','archived') OR
       (SELECT COUNT(*) FROM juanchoice_candidates WHERE campaign_id = demo_id) <> 4 OR
       (SELECT COUNT(*) FROM juanchoice_candidates WHERE campaign_id = demo_id
         AND spot_id = ANY(slate) AND status = 'eligible' AND is_test = FALSE) <> 4 THEN
      RAISE EXCEPTION 'Existing presentation campaign differs from reviewed seed';
    END IF;
    RETURN;
  END IF;

  INSERT INTO juanchoice_region_locks(region) VALUES('pangasinan') ON CONFLICT DO NOTHING;
  PERFORM 1 FROM juanchoice_region_locks WHERE region='pangasinan' FOR UPDATE;
  INSERT INTO juanchoice_campaigns
    (id,slug,region,theme,status,opens_at,closes_at,is_test,policy_version,
     series_key,round_number,counts_for_streak)
  VALUES
    (demo_id,demo_slug,'pangasinan',demo_theme,'draft',opens,closes,FALSE,
     'juanchoice-pilot-v1',NULL,NULL,FALSE);
  INSERT INTO juanchoice_candidates(id,campaign_id,spot_id,status,is_test)
  SELECT gen_random_uuid(),demo_id,chosen.spot_id,'eligible',FALSE FROM unnest(slate) AS chosen(spot_id);
  IF (SELECT COUNT(*) FROM juanchoice_candidates WHERE campaign_id=demo_id) <> 4 THEN
    RAISE EXCEPTION 'Presentation slate insertion incomplete';
  END IF;
  UPDATE juanchoice_campaigns SET status = CASE WHEN now_at_db >= opens THEN 'voting' ELSE 'scheduled' END
  WHERE id=demo_id;
  INSERT INTO juanchoice_campaign_audit(id,campaign_id,actor_id,action,reason)
  VALUES(gen_random_uuid(),demo_id,NULL,'published','One-off isolated presentation demo; not an official monthly round');
END
$presentation$;
COMMIT;
