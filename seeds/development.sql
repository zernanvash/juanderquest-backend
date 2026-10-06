-- Development Seeds for JuanderQuest

INSERT INTO users (id, seed_id, display_name, email, avatar_url, role, demo_points) VALUES
('11111111-1111-1111-1111-111111111111', 'user-1', 'Juan Dela Cruz', 'juan@juanderquest.ph', 'https://api.dicebear.com/7.x/avataaars/svg?seed=Juan', 'user', 100),
('22222222-2222-2222-2222-222222222222', 'admin-1', 'Pangasinan Admin', 'admin@pangasinan.gov.ph', 'https://api.dicebear.com/7.x/avataaars/svg?seed=Admin', 'admin', 0)
ON CONFLICT (seed_id) DO NOTHING;

-- Local public traveler fixtures exercise people search and canonical profile
-- routes without changing the privacy settings of the demo-login account.
INSERT INTO users (
  id, seed_id, display_name, email, avatar_url, role, demo_points,
  is_public, handle, bio, status_text, scout_reputation
) VALUES
(
  'fixture-juan-explorer', 'fixture-juan-explorer', 'Juan Explorer',
  'juan.explorer@fixtures.juanderquest.local', NULL, 'user', 100,
  TRUE, 'juan_explorer', 'Exploring Pangasinan beaches and heritage sites.',
  'Planning my next coastal trip', 250
),
(
  'fixture-maria-santos', 'fixture-maria-santos', 'Maria Santos',
  'maria.santos@fixtures.juanderquest.local', NULL, 'user', 100,
  TRUE, 'maria_santos', 'Sharing local food and culture around Pangasinan.',
  'Discovering new community spots', 420
)
ON CONFLICT (seed_id) DO NOTHING;

INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url) VALUES
(
  'q1111111-1111-1111-1111-111111111111',
  'Hundred Islands Eco Trek',
  'Visit Governor''s Island viewing deck in Alaminos City and scan the eco-marker.',
  'eco',
  'Alaminos City, Pangasinan',
  16.2063,
  119.9706,
  150,
  50,
  'MARKER_HUNDRED_ISLANDS_01',
  'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/hundred_islands.png'
),
(
  'q2222222-2222-2222-2222-222222222222',
  'Bolinao Lighthouse Cultural Heritage',
  'Explore Cape Bolinao Lighthouse built in 1905 and scan the heritage marker.',
  'cultural',
  'Bolinao, Pangasinan',
  16.3885,
  119.9095,
  200,
  75,
  'MARKER_BOLINAO_LIGHTHOUSE_01',
  'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/bolinao_lighthouse.png'
),
(
  'q3333333-3333-3333-3333-333333333333',
  'Manaoag Shrine Pilgrimage',
  'Visit the Minor Basilica of Our Lady of the Rosary of Manaoag.',
  'cultural',
  'Manaoag, Pangasinan',
  16.0436,
  120.4867,
  100,
  60,
  'MARKER_MANAOAG_SHRINE_01',
  'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/manaoag.png'
),
(
  'q4444444-4444-4444-4444-444444444444',
  'Lingayen Gulf Beach & Capitol Park',
  'Discover the historic Pangasinan Provincial Capitol and beach park.',
  'cultural',
  'Lingayen, Pangasinan',
  16.0232,
  120.2312,
  250,
  40,
  'MARKER_LINGAYEN_CAPITOL_01',
  'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/lingayen.png'
),
(
  'q5555555-5555-5555-5555-555555555555',
  'Dagupan Bangus Taste & Trade Trail',
  'Scan the culinary marker at the famous Dagupan City fish port marketplace.',
  'food_trade',
  'Dagupan City, Pangasinan',
  16.0433,
  120.3334,
  150,
  50,
  'MARKER_DAGUPAN_BANGUS_01',
  'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/dagupan_bangus.png'
)
ON CONFLICT (marker_code) DO NOTHING;

-- Synthetic QA entities stay quarantined by is_test, but must still satisfy
-- the spots.quest_id foreign key when development fixtures are persisted.
INSERT INTO quests (
  id, title, description, category, location_name, gps_lat, gps_lng,
  radius_meters, reward_points, marker_code, marker_image_url, is_test
) VALUES (
  'qa-quest-tambobong',
  'Tambobong Cove QA Quest',
  'Synthetic marker quest used only by evaluator preview and local QA flows.',
  'eco',
  'Dasol, Pangasinan',
  15.9083,
  119.7892,
  150,
  25,
  'QA_MARKER_TAMBOBONG_01',
  'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/qa_tambobong.png',
  TRUE
)
ON CONFLICT (marker_code) DO UPDATE SET is_test = TRUE;

INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status, reviewed_by, reviewed_at) VALUES
('sub-seeded-governance-eligibility', 'seeded-governance-eligibility', '11111111-1111-1111-1111-111111111111', 'q5555555-5555-5555-5555-555555555555', 'MARKER_DAGUPAN_BANGUS_01', 16.0433, 120.3334, 5, 'approved', '22222222-2222-2222-2222-222222222222', NOW())
ON CONFLICT (id) DO NOTHING;
