-- QA-only, repeatable community simulation for the dedicated home-alpha DB.
-- Run with psql -v qa_wallet_address=0x... -f alpha_community_simulation.sql.
-- Never run against an unrelated database. Fictional activity remains is_test.
\set ON_ERROR_STOP on
BEGIN;

-- A private, operator-owned wallet can sign in through the normal challenge flow.
-- Its public address is passed by the operator; the private key never enters Git.
INSERT INTO users (id, seed_id, display_name, email, role, is_public, is_test)
VALUES (
  'qa-sim-20260927-operator',
  'wallet:' || lower(:'qa_wallet_address'),
  'Alpha QA Operator', 'alpha-qa-operator@simulation.invalid',
  'qa', FALSE, FALSE
)
ON CONFLICT DO NOTHING;

INSERT INTO users (
  id, seed_id, display_name, email, role, is_public, handle,
  bio, status_text, scout_reputation, is_test, created_at
) VALUES
('qa-sim-20260927-u01','qa-sim-20260927-u01','SIM Aira • Coast Scout','aira@simulation.invalid','user',TRUE,'sim_aira_coast','Fictional alpha traveler sharing sample coast itineraries.','Planning a Bolinao weekend',0,TRUE,NOW()-INTERVAL '25 days'),
('qa-sim-20260927-u02','qa-sim-20260927-u02','SIM Ben • Heritage Walks','ben@simulation.invalid','user',TRUE,'sim_ben_heritage','Fictional alpha traveler exploring heritage routes.','Saved the Capitol trail',0,TRUE,NOW()-INTERVAL '22 days'),
('qa-sim-20260927-u03','qa-sim-20260927-u03','SIM Celine • Local Food','celine@simulation.invalid','user',TRUE,'sim_celine_food','Fictional alpha traveler testing food and market discovery.','Looking for a Dagupan route',0,TRUE,NOW()-INTERVAL '19 days'),
('qa-sim-20260927-u04','qa-sim-20260927-u04','SIM Diego • Family Trips','diego@simulation.invalid','user',TRUE,'sim_diego_family','Fictional alpha traveler planning accessible family outings.','Comparing beach alternatives',0,TRUE,NOW()-INTERVAL '17 days'),
('qa-sim-20260927-u05','qa-sim-20260927-u05','SIM Ella • Weekend Explorer','ella@simulation.invalid','user',TRUE,'sim_ella_weekends','Fictional alpha traveler testing weekend trip recommendations.','Following coastal posts',0,TRUE,NOW()-INTERVAL '15 days'),
('qa-sim-20260927-u06','qa-sim-20260927-u06','SIM Franco • Trail Notes','franco@simulation.invalid','user',TRUE,'sim_franco_trails','Fictional alpha traveler testing quests and saved maps.','Checking the next trail',0,TRUE,NOW()-INTERVAL '13 days')
ON CONFLICT DO NOTHING;

INSERT INTO discovery_preferences (user_id,categories,tags,occasions,price_levels,radius_km,onboarding_state)
VALUES
('qa-sim-20260927-u01','["nature_outdoors"]','["beach","scenic"]','["weekend"]','[0,1]',80,'completed'),
('qa-sim-20260927-u02','["culture_heritage"]','["heritage","walking"]','["solo"]','[0]',40,'completed'),
('qa-sim-20260927-u03','["eat_drink"]','["local_food","market"]','["friends"]','[0,1]',35,'completed'),
('qa-sim-20260927-u04','["nature_outdoors","activities_wellness"]','["family","walking"]','["family"]','[0,1]',60,'completed'),
('qa-sim-20260927-u05','["nature_outdoors","culture_heritage"]','["scenic","heritage"]','["weekend"]','[0,1,2]',100,'completed'),
('qa-sim-20260927-u06','["nature_outdoors"]','["hidden_gem","walking"]','["solo"]','[0,1]',90,'completed')
ON CONFLICT (user_id) DO NOTHING;

-- Social edges are varied enough to exercise counts, relationship state, and lists.
INSERT INTO user_follows (follower_id,following_id,created_at) VALUES
('qa-sim-20260927-u01','qa-sim-20260927-u02',NOW()-INTERVAL '12 days'),
('qa-sim-20260927-u01','qa-sim-20260927-u03',NOW()-INTERVAL '10 days'),
('qa-sim-20260927-u01','qa-sim-20260927-u05',NOW()-INTERVAL '6 days'),
('qa-sim-20260927-u02','qa-sim-20260927-u01',NOW()-INTERVAL '11 days'),
('qa-sim-20260927-u02','qa-sim-20260927-u06',NOW()-INTERVAL '5 days'),
('qa-sim-20260927-u03','qa-sim-20260927-u01',NOW()-INTERVAL '9 days'),
('qa-sim-20260927-u03','qa-sim-20260927-u04',NOW()-INTERVAL '4 days'),
('qa-sim-20260927-u04','qa-sim-20260927-u01',NOW()-INTERVAL '7 days'),
('qa-sim-20260927-u04','qa-sim-20260927-u05',NOW()-INTERVAL '3 days'),
('qa-sim-20260927-u05','qa-sim-20260927-u01',NOW()-INTERVAL '8 days'),
('qa-sim-20260927-u05','qa-sim-20260927-u02',NOW()-INTERVAL '2 days'),
('qa-sim-20260927-u05','qa-sim-20260927-u06',NOW()-INTERVAL '1 day'),
('qa-sim-20260927-u06','qa-sim-20260927-u02',NOW()-INTERVAL '5 days'),
('qa-sim-20260927-u06','qa-sim-20260927-u03',NOW()-INTERVAL '3 days')
ON CONFLICT DO NOTHING;

-- These are demonstrator quests, not published GPS markers or verified visits.
INSERT INTO quests (
  id,title,description,category,location_name,gps_lat,gps_lng,
  radius_meters,reward_points,marker_code,marker_image_url,is_test
) VALUES
('qa-sim-20260927-q01','SIM • Patar coastal orientation','QA-only sample quest for testing discovery and proof submission; no physical marker is installed.','eco','Patar, Bolinao',16.3204,119.7847,150,50,'QA_SIM_PATAR_20260927','',TRUE),
('qa-sim-20260927-q02','SIM • Lingayen heritage walk','QA-only sample quest for testing discovery and proof submission; no physical marker is installed.','cultural','Lingayen, Pangasinan',16.0232,120.2312,150,40,'QA_SIM_LINGAYEN_20260927','',TRUE)
ON CONFLICT DO NOTHING;

-- Multiple text-only community cards exercise the feed without borrowed images,
-- fabricated photo evidence, business hours, or claimed on-site verification.
INSERT INTO spots (
  id,slug,name,description,category,subcategory,tags,municipality,address,
  gps_lat,gps_lng,image_url,source_type,source_name,trust_level,status,
  quest_id,created_by,is_test,created_at
) VALUES
('qa-sim-20260927-p01','qa-sim-patar-weekend-plan','SIM Post • Patar weekend plan','Simulation post: A beach-first weekend idea for Bolinao. Save Patar, compare weather and transport, then confirm access locally before leaving.','nature_outdoors','beach','["beach","weekend","scenic"]','Bolinao','Patar, Bolinao, Pangasinan',16.3204,119.7847,'','community','Fictional alpha traveler','community','published','qa-sim-20260927-q01','qa-sim-20260927-u01',TRUE,NOW()-INTERVAL '11 days'),
('qa-sim-20260927-p02','qa-sim-hundred-islands-checklist','SIM Post • Hundred Islands checklist','Simulation post: Start at the Lucap gateway, ask for current boat and island access details, and leave enough time for a relaxed return.','nature_outdoors','park','["island","family","scenic"]','Alaminos City','Lucap, Alaminos City, Pangasinan',16.2063,119.9706,'','community','Fictional alpha traveler','community','published',NULL,'qa-sim-20260927-u04',TRUE,NOW()-INTERVAL '9 days'),
('qa-sim-20260927-p03','qa-sim-lingayen-heritage-route','SIM Post • Lingayen heritage route','Simulation post: Pair the Capitol grounds with a gentle baywalk. Check current access to any redevelopment areas before planning a group visit.','culture_heritage','heritage_site','["heritage","walking","family"]','Lingayen','Capitol Complex, Lingayen, Pangasinan',16.0232,120.2312,'','community','Fictional alpha traveler','community','published','qa-sim-20260927-q02','qa-sim-20260927-u02',TRUE,NOW()-INTERVAL '8 days'),
('qa-sim-20260927-p04','qa-sim-dagupan-bangus-stop','SIM Post • Dagupan bangus stop','Simulation post: Add a local food stop in Dagupan to a city walk. Ask vendors about availability and prices on the day rather than relying on old listings.','eat_drink','street_food','["local_food","market","friends"]','Dagupan City','Dagupan City, Pangasinan',16.0431,120.3333,'','community','Fictional alpha traveler','community','published',NULL,'qa-sim-20260927-u03',TRUE,NOW()-INTERVAL '7 days'),
('qa-sim-20260927-p05','qa-sim-manaoag-quiet-morning','SIM Post • Manaoag quiet morning','Simulation post: Make time for a respectful visit to the basilica and check its official visitor guidance before setting out.','culture_heritage','church','["pilgrimage","heritage","solo"]','Manaoag','Manaoag, Pangasinan',16.0436,120.4854,'','community','Fictional alpha traveler','community','published',NULL,'qa-sim-20260927-u05',TRUE,NOW()-INTERVAL '6 days'),
('qa-sim-20260927-p06','qa-sim-bolinao-falls-route','SIM Post • Bolinao Falls route','Simulation post: A falls stop can complement a Bolinao beach trip. Confirm conditions, local guidance, and safe access before entering the water.','nature_outdoors','waterfall','["nature","friends","hidden_gem"]','Bolinao','Samang Norte, Bolinao, Pangasinan',16.3377,119.8806,'','community','Fictional alpha traveler','community','published',NULL,'qa-sim-20260927-u06',TRUE,NOW()-INTERVAL '5 days'),
('qa-sim-20260927-p07','qa-sim-lingayen-baywalk-evening','SIM Post • Lingayen baywalk evening','Simulation post: A low-cost coastal walk idea for a small group. Check weather, lighting, and local advisories first.','activities_wellness','running_spot','["walking","coast","friends"]','Lingayen','Lingayen, Pangasinan',16.0218,120.2319,'','community','Fictional alpha traveler','community','published',NULL,'qa-sim-20260927-u01',TRUE,NOW()-INTERVAL '4 days'),
('qa-sim-20260927-p08','qa-sim-patar-family-questions','SIM Post • Patar family questions','Simulation post: Comparing Patar with other coastal stops for a family day trip. Save the options and verify transport, shade, and facilities locally.','nature_outdoors','beach','["beach","family","planning"]','Bolinao','Patar, Bolinao, Pangasinan',16.3204,119.7847,'','community','Fictional alpha traveler','community','published',NULL,'qa-sim-20260927-u04',TRUE,NOW()-INTERVAL '3 days'),
('qa-sim-20260927-p09','qa-sim-capitol-architecture-notes','SIM Post • Capitol architecture notes','Simulation post: A short heritage walk idea centered on the Provincial Capitol. Public access may change during redevelopment; check first.','culture_heritage','heritage_site','["architecture","heritage","walking"]','Lingayen','Capitol Complex, Lingayen, Pangasinan',16.0232,120.2312,'','community','Fictional alpha traveler','community','published',NULL,'qa-sim-20260927-u02',TRUE,NOW()-INTERVAL '2 days')
ON CONFLICT DO NOTHING;

INSERT INTO spot_interactions (user_id,spot_id,interaction_type,created_at) VALUES
('qa-sim-20260927-u01','qa-sim-20260927-p03','save',NOW()-INTERVAL '6 days'),
('qa-sim-20260927-u01','qa-sim-20260927-p04','like',NOW()-INTERVAL '5 days'),
('qa-sim-20260927-u02','qa-sim-20260927-p01','save',NOW()-INTERVAL '6 days'),
('qa-sim-20260927-u02','qa-sim-20260927-p05','like',NOW()-INTERVAL '4 days'),
('qa-sim-20260927-u03','qa-sim-20260927-p01','like',NOW()-INTERVAL '5 days'),
('qa-sim-20260927-u03','qa-sim-20260927-p02','save',NOW()-INTERVAL '4 days'),
('qa-sim-20260927-u03','qa-sim-20260927-p07','like',NOW()-INTERVAL '3 days'),
('qa-sim-20260927-u04','qa-sim-20260927-p01','like',NOW()-INTERVAL '5 days'),
('qa-sim-20260927-u04','qa-sim-20260927-p03','save',NOW()-INTERVAL '3 days'),
('qa-sim-20260927-u04','qa-sim-20260927-p05','save',NOW()-INTERVAL '2 days'),
('qa-sim-20260927-u05','qa-sim-20260927-p01','save',NOW()-INTERVAL '4 days'),
('qa-sim-20260927-u05','qa-sim-20260927-p02','like',NOW()-INTERVAL '3 days'),
('qa-sim-20260927-u05','qa-sim-20260927-p04','like',NOW()-INTERVAL '2 days'),
('qa-sim-20260927-u06','qa-sim-20260927-p03','like',NOW()-INTERVAL '3 days'),
('qa-sim-20260927-u06','qa-sim-20260927-p06','save',NOW()-INTERVAL '2 days'),
('qa-sim-20260927-u06','qa-sim-20260927-p08','like',NOW()-INTERVAL '1 day')
ON CONFLICT DO NOTHING;

-- Moderation examples are explicitly synthetic; no approved visit is invented.
INSERT INTO submissions (
  id,idempotency_key,user_id,quest_id,scanned_marker_code,
  captured_lat,captured_lng,captured_accuracy,status,rejection_reason,is_test,created_at
) VALUES
('qa-sim-20260927-s01','qa-sim-20260927-proof-01','qa-sim-20260927-u01','qa-sim-20260927-q01','QA_SIM_PATAR_20260927',16.3204,119.7847,8,'pending',NULL,TRUE,NOW()-INTERVAL '2 days'),
('qa-sim-20260927-s02','qa-sim-20260927-proof-02','qa-sim-20260927-u02','qa-sim-20260927-q02','QA_SIM_LINGAYEN_20260927',16.0232,120.2312,12,'pending',NULL,TRUE,NOW()-INTERVAL '1 day'),
('qa-sim-20260927-s03','qa-sim-20260927-proof-03','qa-sim-20260927-u06','qa-sim-20260927-q01','QA_SIM_PATAR_20260927',16.3204,119.7847,20,'rejected','Simulation: marker image was not provided.',TRUE,NOW()-INTERVAL '3 days')
ON CONFLICT DO NOTHING;

-- One read-only mock ballot round. No token transfers, merchant offers, or
-- promotional spotlight are generated from this synthetic campaign.
INSERT INTO juanchoice_campaigns (
  id,slug,region,theme,status,opens_at,closes_at,is_test,policy_version
) VALUES (
  'ef000001-0000-4000-8000-000000000001',
  'qa-sim-coastal-gems-20260927','Pangasinan','SIM • Community coastal gems',
  'voting',NOW()-INTERVAL '2 days',NOW()+INTERVAL '5 days',TRUE,'juanchoice-pilot-v1'
)
ON CONFLICT DO NOTHING;

INSERT INTO juanchoice_candidates (id,campaign_id,spot_id,is_test) VALUES
('ef000002-0000-4000-8000-000000000001','ef000001-0000-4000-8000-000000000001','qa-sim-20260927-p01',TRUE),
('ef000002-0000-4000-8000-000000000002','ef000001-0000-4000-8000-000000000001','qa-sim-20260927-p02',TRUE),
('ef000002-0000-4000-8000-000000000003','ef000001-0000-4000-8000-000000000001','qa-sim-20260927-p07',TRUE)
ON CONFLICT DO NOTHING;

INSERT INTO juanchoice_ballots (campaign_id,user_id,candidate_id,is_test,created_at) VALUES
('ef000001-0000-4000-8000-000000000001','qa-sim-20260927-u01','ef000002-0000-4000-8000-000000000001',TRUE,NOW()-INTERVAL '36 hours'),
('ef000001-0000-4000-8000-000000000001','qa-sim-20260927-u02','ef000002-0000-4000-8000-000000000002',TRUE,NOW()-INTERVAL '30 hours'),
('ef000001-0000-4000-8000-000000000001','qa-sim-20260927-u03','ef000002-0000-4000-8000-000000000001',TRUE,NOW()-INTERVAL '28 hours'),
('ef000001-0000-4000-8000-000000000001','qa-sim-20260927-u04','ef000002-0000-4000-8000-000000000003',TRUE,NOW()-INTERVAL '20 hours'),
('ef000001-0000-4000-8000-000000000001','qa-sim-20260927-u05','ef000002-0000-4000-8000-000000000002',TRUE,NOW()-INTERVAL '12 hours'),
('ef000001-0000-4000-8000-000000000001','qa-sim-20260927-u06','ef000002-0000-4000-8000-000000000001',TRUE,NOW()-INTERVAL '4 hours')
ON CONFLICT DO NOTHING;

INSERT INTO juanchoice_participations (campaign_id,user_id,is_test)
SELECT campaign_id,user_id,TRUE FROM juanchoice_ballots
WHERE campaign_id='ef000001-0000-4000-8000-000000000001'
ON CONFLICT DO NOTHING;

INSERT INTO progression_events (
  id,user_id,track,delta,source_type,source_id,award_kind,rule_version,is_test
)
SELECT gen_random_uuid(),user_id,'civic',25,'juanchoice_participation',
       campaign_id::text,'xp','juanchoice-pilot-v1',TRUE
FROM juanchoice_ballots WHERE campaign_id='ef000001-0000-4000-8000-000000000001'
ON CONFLICT (user_id,source_type,source_id,award_kind) DO NOTHING;

INSERT INTO progression_events (
  id,user_id,track,delta,source_type,source_id,award_kind,rule_version,is_test
)
SELECT gen_random_uuid(),user_id,'civic',1,'juanchoice_participation',
       campaign_id::text,'stamp','juanchoice-pilot-v1',TRUE
FROM juanchoice_ballots WHERE campaign_id='ef000001-0000-4000-8000-000000000001'
ON CONFLICT (user_id,source_type,source_id,award_kind) DO NOTHING;

INSERT INTO progression_totals (user_id,explorer_xp,civic_xp,civic_stamps,last_event_at)
SELECT user_id,0,
       COALESCE(SUM(delta) FILTER (WHERE track='civic' AND award_kind='xp'),0),
       COALESCE(SUM(delta) FILTER (WHERE track='civic' AND award_kind='stamp'),0),
       MAX(earned_at)
FROM progression_events
WHERE user_id LIKE 'qa-sim-20260927-u%'
GROUP BY user_id
ON CONFLICT (user_id) DO NOTHING;

COMMIT;
