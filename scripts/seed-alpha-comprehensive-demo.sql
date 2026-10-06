-- JuanderQuest Alpha Comprehensive Realistic Data Seed
-- Prepares authentic destinations, imagery, scout profiles, quests, verified visits,
-- community goals, social interactions, crowd events, and merchant vouchers.

BEGIN;

-- ============================================================================
-- 1. USERS: Authentic Scout Personas & LGU Moderators
-- ============================================================================

-- Update existing scouts with realistic avatars, bios, and reputation
UPDATE users SET
  display_name = 'Scout Aira (Verified Scout)',
  handle = 'aira_coast',
  avatar_url = 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&q=80',
  bio = 'Bolinao coastal navigator and marine sanctuary scout. Passionate about hidden coves and reef conservation.',
  status_text = 'Surveying Patar Beach tide pools',
  scout_reputation = 350,
  demo_points = 250,
  is_public = true,
  is_test = false
WHERE id = 'qa-sim-20260927-u01';

UPDATE users SET
  display_name = 'Scout Ben',
  handle = 'ben_heritage',
  avatar_url = 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=400&q=80',
  bio = 'Pangasinan colonial history buff and architecture documenter. Tracing the historic Gulf trail.',
  status_text = 'Photographing the Capitol grounds',
  scout_reputation = 280,
  demo_points = 180,
  is_public = true,
  is_test = false
WHERE id = 'qa-sim-20260927-u02';

UPDATE users SET
  display_name = 'Scout Celine',
  handle = 'celine_culinary',
  avatar_url = 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=400&q=80',
  bio = 'Dagupan culinary scout. On a mission to taste every regional bangus recipe and market delicacy.',
  status_text = 'Tasting fresh Puto Calasiao',
  scout_reputation = 220,
  demo_points = 140,
  is_public = true,
  is_test = false
WHERE id = 'qa-sim-20260927-u03';

UPDATE users SET
  display_name = 'Scout Diego',
  handle = 'diego_ecotrek',
  avatar_url = 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=400&q=80',
  bio = 'Hundred Islands certified eco-guide. Waterfall chaser and family adventure trail planner.',
  status_text = 'Island hopping in Alaminos',
  scout_reputation = 210,
  demo_points = 120,
  is_public = true,
  is_test = false
WHERE id = 'qa-sim-20260927-u04';

UPDATE users SET
  display_name = 'Scout Ella',
  handle = 'ella_voyager',
  avatar_url = 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?auto=format&fit=crop&w=400&q=80',
  bio = 'Weekend explorer and sunset hunter. Lover of quiet tidal flats and starry coastal nights.',
  status_text = 'Camping at Cabongaoan Beach',
  scout_reputation = 180,
  demo_points = 90,
  is_public = true,
  is_test = false
WHERE id = 'qa-sim-20260927-u05';

UPDATE users SET
  display_name = 'Scout Franco',
  handle = 'franco_adventures',
  avatar_url = 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&w=400&q=80',
  bio = 'Western Pangasinan trail notes, hidden sands, and boat routes to secluded islets.',
  status_text = 'Boating to Colibra Island',
  scout_reputation = 150,
  demo_points = 80,
  is_public = true,
  is_test = false
WHERE id = 'qa-sim-20260927-u06';

-- Add additional realistic community scouts and LGU tourism moderator
INSERT INTO users (
  id, seed_id, display_name, email, avatar_url, role,
  demo_points, scout_reputation, is_public, handle, bio, status_text, is_test, created_at
) VALUES
(
  'user-marian-artisan', 'user-marian', 'Marian Rivera', 'marian@juanderquest.local',
  'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=400&q=80', 'user',
  160, 240, true, 'marian_artisan', 'Documenting Binalonan woven crafts, bamboo crafts, and local market artisans.',
  'Visiting Binalonan bamboo workshops', false, NOW() - INTERVAL '28 days'
),
(
  'user-rafael-diver', 'user-rafael', 'Rafael Cruz', 'rafael@juanderquest.local',
  'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=400&q=80', 'user',
  190, 260, true, 'rafael_diver', 'Free diver and coastal conservationist. Mapping reef health across Lingayen Gulf.',
  'Diving the Bolinao marine drop-off', false, NOW() - INTERVAL '26 days'
),
(
  'user-patricia-lgu', 'user-patricia', 'Patricia Santos • Tourism Officer', 'patricia@lgu.pangasinan.gov.ph',
  'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=400&q=80', 'admin',
  500, 800, true, 'patricia_tourism', 'Pangasinan Provincial Tourism and Cultural Affairs Office (PTCAO) moderator.',
  'Verifying community quest submissions', false, NOW() - INTERVAL '40 days'
)
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  handle = EXCLUDED.handle,
  avatar_url = EXCLUDED.avatar_url,
  bio = EXCLUDED.bio,
  status_text = EXCLUDED.status_text,
  is_test = false;

-- Grant LGU operator scopes to Patricia Santos
INSERT INTO lgu_operator_scopes (user_id, municipality_id, permission, is_active) VALUES
  ('user-patricia-lgu', 'bolinao', 'moderate', true),
  ('user-patricia-lgu', 'alaminos_city', 'moderate', true),
  ('user-patricia-lgu', 'lingayen', 'moderate', true),
  ('user-patricia-lgu', 'dagupan_city', 'moderate', true),
  ('user-patricia-lgu', 'manaoag', 'moderate', true),
  ('user-patricia-lgu', 'dasol', 'moderate', true)
ON CONFLICT DO NOTHING;

-- User engagement preferences
INSERT INTO user_engagement_preferences (user_id, share_achievements) VALUES
  ('qa-sim-20260927-u01', true),
  ('qa-sim-20260927-u02', true),
  ('qa-sim-20260927-u03', true),
  ('qa-sim-20260927-u04', true),
  ('qa-sim-20260927-u05', true),
  ('qa-sim-20260927-u06', true),
  ('user-marian-artisan', true),
  ('user-rafael-diver', true)
ON CONFLICT (user_id) DO UPDATE SET share_achievements = true;

-- Social Follow Network
INSERT INTO user_follows (follower_id, following_id, created_at) VALUES
  ('qa-sim-20260927-u01', 'user-patricia-lgu', NOW() - INTERVAL '20 days'),
  ('qa-sim-20260927-u02', 'user-patricia-lgu', NOW() - INTERVAL '18 days'),
  ('user-marian-artisan', 'qa-sim-20260927-u01', NOW() - INTERVAL '15 days'),
  ('user-marian-artisan', 'qa-sim-20260927-u02', NOW() - INTERVAL '14 days'),
  ('user-rafael-diver', 'qa-sim-20260927-u01', NOW() - INTERVAL '12 days'),
  ('user-rafael-diver', 'qa-sim-20260927-u04', NOW() - INTERVAL '10 days'),
  ('qa-sim-20260927-u03', 'user-marian-artisan', NOW() - INTERVAL '8 days')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 2. DESTINATIONS: High-Res Imagery, Hours, Amenities & Capacity Bands
-- ============================================================================

UPDATE spots SET
  image_url = 'https://images.unsplash.com/photo-1518509562904-e7ef99cdcc86?auto=format&fit=crop&w=1200&q=80',
  description = 'Alaminos City''s world-renowned marine national park comprising 123 emerald islands at high tide. Lucap Wharf provides motorboat access to Governor''s Island, Quezon Island, Children''s Island, and Marcos Island with helmet diving and ziplines.',
  hours = '{"daily": "06:00-17:30"}'::jsonb,
  amenities = '["parking", "restrooms", "boat_rental", "cottage_rentals", "lifeguard", "food_stalls", "zipline", "snorkeling", "scenic_view"]'::jsonb,
  crowd_capacity_band = 'high',
  price_level = 2,
  is_test = false
WHERE id = 'spot-hundred-islands';

UPDATE spots SET
  image_url = 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1200&q=80',
  description = 'A breathtaking stretch of creamy golden sand on the western edge of Bolinao. Renowned for dramatic West Philippine Sea sunsets, calm swimming shallows, and coral rock formations.',
  hours = '{"daily": "06:00-19:00"}'::jsonb,
  amenities = '["parking", "restrooms", "cottage_rentals", "lifeguard", "food_stalls", "scenic_view", "beach_volleyball"]'::jsonb,
  crowd_capacity_band = 'medium',
  price_level = 1,
  is_test = false
WHERE id = 'spot-patar';

UPDATE spots SET
  image_url = 'https://images.unsplash.com/photo-1548625361-16a9a087192a?auto=format&fit=crop&w=1200&q=80',
  description = 'One of the Philippines'' most venerated Marian pilgrimage centers, canonized as a Minor Basilica in 2015. Features ivory-sculpted colonial altars, prayer gardens, candle galleries, and religious museum.',
  hours = '{"daily": "05:00-19:00"}'::jsonb,
  amenities = '["parking", "restrooms", "wheelchair_accessible", "prayer_garden", "museum", "gift_shop"]'::jsonb,
  crowd_capacity_band = 'high',
  price_level = 0,
  is_test = false
WHERE id = 'spot-manaoag';

UPDATE spots SET
  image_url = 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=1200&q=80',
  description = 'A picturesque beachfront promenade in the provincial capital of Lingayen. Offers panoramic vistas of Lingayen Gulf, shaded brick walkways for jogging, bike lanes, and fresh seafood stalls.',
  hours = '{"daily": "05:00-22:00"}'::jsonb,
  amenities = '["parking", "restrooms", "bike_rental", "jogging_path", "food_stalls", "wheelchair_accessible", "scenic_view"]'::jsonb,
  crowd_capacity_band = 'medium',
  price_level = 0,
  is_test = false
WHERE id = 'spot-lingayen-baywalk';

UPDATE spots SET
  image_url = 'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=1200&q=80',
  description = 'The neoclassical Capitol Building of Pangasinan, designed by William Parsons in 1918. Standing facing the sea amid manicured palms and reflecting pools, it is celebrated as the "Grand Old Lady of Pangasinan."',
  hours = '{"monday-friday": "08:00-17:00", "grounds": "06:00-21:00"}'::jsonb,
  amenities = '["parking", "restrooms", "guided_tours", "wheelchair_accessible", "historical_marker", "gardens"]'::jsonb,
  crowd_capacity_band = 'medium',
  price_level = 0,
  is_test = false
WHERE id = 'spot-pangasinan-capitol';

UPDATE spots SET
  image_url = 'https://images.unsplash.com/photo-1509316975850-ff9c5deb0cd9?auto=format&fit=crop&w=1200&q=80',
  description = 'Built in 1905 on Punta Piedra, this 101-foot lighthouse is the second tallest in the Philippines. Perched atop a limestone cliff, it commands sweeping 360-degree vistas across Cape Bolinao and the shipping lanes.',
  hours = '{"daily": "06:00-18:30"}'::jsonb,
  amenities = '["parking", "viewing_deck", "historical_marker", "photo_spot", "souvenirs"]'::jsonb,
  crowd_capacity_band = 'medium',
  price_level = 0,
  is_test = false
WHERE id = 'spot-cape-bolinao-lighthouse';

UPDATE spots SET
  image_url = 'https://images.unsplash.com/photo-1432405972618-c60b0225b8f9?auto=format&fit=crop&w=1200&q=80',
  description = 'A multi-tiered freshwater cascade featuring a deep natural emerald swimming lagoon, bamboo rafting, and cliff-diving platforms surrounded by jungle foliage in Bolinao.',
  hours = '{"daily": "07:00-17:00"}'::jsonb,
  amenities = '["parking", "restrooms", "cottage_rentals", "bamboo_raft", "life_vest_rental"]'::jsonb,
  crowd_capacity_band = 'medium',
  price_level = 1,
  is_test = false
WHERE id = 'spot-bolinao-falls-1';

UPDATE spots SET
  image_url = 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1200&q=80',
  description = 'A subterranean limestone cavern harboring a deep, crystal-clear natural underground freshwater pool. Illuminated pathways lead down into this refreshing geological wonder.',
  hours = '{"daily": "08:00-17:00"}'::jsonb,
  amenities = '["parking", "restrooms", "swimming_pool", "guided_path", "cottages"]'::jsonb,
  crowd_capacity_band = 'medium',
  price_level = 2,
  is_test = false
WHERE id = 'spot-enchanted-cave-bolinao';

UPDATE spots SET
  image_url = 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?auto=format&fit=crop&w=1200&q=80',
  description = 'Nicknamed the "Little Boracay of the North," this peaceful beach in Anda features a vast white-sand sandbar stretching over a kilometer offshore during low tide with shallow crystal water.',
  hours = '{"daily": "06:00-18:00"}'::jsonb,
  amenities = '["parking", "restrooms", "cottage_rentals", "sandbar_walks", "water_sports", "food_stalls"]'::jsonb,
  crowd_capacity_band = 'medium',
  price_level = 1,
  is_test = false
WHERE id = 'spot-tondol-beach';

UPDATE spots SET
  image_url = 'https://images.unsplash.com/photo-1505118380757-91f5f5632de0?auto=format&fit=crop&w=1200&q=80',
  description = 'A rugged coastal gem in Burgos famous for white sand, dramatic rock formations, tidal blowholes, and the famous natural tidal pool nicknamed the "Death Pool" carved into the coastal rocks.',
  hours = '{"daily": "06:00-18:00"}'::jsonb,
  amenities = '["parking", "cottage_rentals", "tidal_pools", "rock_scramble", "scenic_view"]'::jsonb,
  crowd_capacity_band = 'low',
  price_level = 1,
  is_test = false
WHERE id = 'spot-cabongaoan-beach';

UPDATE spots SET
  image_url = 'https://images.unsplash.com/photo-1473496169904-658ba7c44d8a?auto=format&fit=crop&w=1200&q=80',
  description = 'A serene coastal haven on the Dasol peninsula with powdery white sand and fishing outriggers. Gateway to Colibra (Snake) Island and crocodile-shaped rock islands.',
  hours = '{"daily": "06:00-18:00"}'::jsonb,
  amenities = '["parking", "restrooms", "boat_rental", "cottage_rentals", "snorkeling", "secluded_beach"]'::jsonb,
  crowd_capacity_band = 'low',
  price_level = 1,
  is_test = false
WHERE id = 'spot-tambobong-beach';

UPDATE spots SET
  image_url = 'https://images.unsplash.com/photo-1519046904884-53103b34b206?auto=format&fit=crop&w=1200&q=80',
  description = 'Dagupan City''s premier coastal recreation area along Bonuan Gueset. Features seaside parks, seafood dining sheds, cycling tracks, and sunset walking promenades.',
  hours = '{"daily": "05:00-21:00"}'::jsonb,
  amenities = '["parking", "restrooms", "seafood_restaurants", "bike_lanes", "park_benches", "scenic_view"]'::jsonb,
  crowd_capacity_band = 'medium',
  price_level = 0,
  is_test = false
WHERE id = 'spot-tondaligan-beach';

UPDATE spots SET
  image_url = 'https://images.unsplash.com/photo-1540555700478-4be289fbecef?auto=format&fit=crop&w=1200&q=80',
  description = 'Located at the foothills of Mount Balungao, featuring volcanic spring pools with mineral waters, hot springs, cold river pools, extreme ziplines, and quad bike trails.',
  hours = '{"daily": "08:00-17:00"}'::jsonb,
  amenities = '["parking", "restrooms", "thermal_pools", "zipline", "atv_rentals", "cottages", "picnic_area"]'::jsonb,
  crowd_capacity_band = 'low',
  price_level = 2,
  is_test = false
WHERE id = 'spot-balungao-springs';

UPDATE spots SET
  image_url = 'https://images.unsplash.com/photo-1448375240586-882707db888b?auto=format&fit=crop&w=1200&q=80',
  description = 'A 1,075-hectare protected forest landscape and bird sanctuary in Mangatarem. Home to thermal sulfur springs, forest canopy boardwalks, and cool freshwater bathing lagoons.',
  hours = '{"daily": "07:00-17:00"}'::jsonb,
  amenities = '["parking", "restrooms", "forest_trails", "sulfur_springs", "camping_ground", "picnic_sheds"]'::jsonb,
  crowd_capacity_band = 'low',
  price_level = 1,
  is_test = false
WHERE id = 'spot-manleluag-spring';

-- Add 6 additional authentic spots in Pangasinan to expand exploration
INSERT INTO spots (
  id, slug, name, description, category, subcategory, tags,
  municipality, address, gps_lat, gps_lng, price_level, hours, amenities, image_url,
  source_type, source_name, source_url, trust_level, status, is_test
) VALUES
(
  'spot-calasiao-puto-village', 'calasiao-puto-village', 'Calasiao Puto Village & Stalls',
  'The cultural epicenter of the Philippines'' beloved bite-sized steamed rice cake (Puto Calasiao). Rows of traditional vendors steam fresh white puto, kutsinta, and regional delicacies daily.',
  'eat_drink', 'market', '["food","delicacy","heritage","kakanin"]'::jsonb,
  'Calasiao', 'Poblacion West, Calasiao, Pangasinan', 16.0125, 120.3582, 0,
  '{"daily": "05:00-20:00"}'::jsonb,
  '["parking", "food_stalls", "pasalubong_center", "wheelchair_accessible"]'::jsonb,
  'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=1200&q=80',
  'editorial', 'Pangasinan PTCAO', 'https://seepangasinan.com/', 'editorial', 'published', false
),
(
  'spot-colibra-island', 'colibra-island-dasol', 'Colibra Island (Snake Island)',
  'A secluded, pristine coral islet off the coast of Dasol surrounded by sapphire waters and living coral reef gardens. Ideal for snorkeling and off-grid day excursions.',
  'nature_outdoors', 'island', '["island","snorkeling","reef","hidden_gem"]'::jsonb,
  'Dasol', 'Tambobong Marine Area, Dasol, Pangasinan', 15.8856, 119.7891, 1,
  '{"daily": "06:00-16:00"}'::jsonb,
  '["boat_access", "snorkeling", "beach", "photo_spot"]'::jsonb,
  'https://images.unsplash.com/photo-1544551763-46a013bb70d5?auto=format&fit=crop&w=1200&q=80',
  'editorial', 'Pangasinan PTCAO', 'https://seepangasinan.com/', 'editorial', 'published', false
),
(
  'spot-sual-overlook', 'sual-bay-scenic-overlook', 'Sual Bay & Overlook Viewdeck',
  'A scenic hillside viewing pavilion offering sweeping vistas across Sual Bay, docking cargo vessels, fishing fleets, and the green hills of Western Pangasinan.',
  'nature_outdoors', 'scenic_viewpoint', '["scenic_view","viewpoint","hills","photography"]'::jsonb,
  'Sual', 'Poblacion, Sual, Pangasinan', 16.0712, 120.0886, 0,
  '{"daily": "06:00-19:00"}'::jsonb,
  '["parking", "viewing_deck", "photo_spot", "benches"]'::jsonb,
  'https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?auto=format&fit=crop&w=1200&q=80',
  'editorial', 'Pangasinan PTCAO', 'https://seepangasinan.com/', 'editorial', 'published', false
),
(
  'spot-binalonan-church', 'binalonan-holy-child-church', 'Holy Child Parish Church & Heritage Plaza',
  'A grand Spanish colonial stone church constructed in 1841 fronted by the expansive Binalonan Municipal Plaza, landscaped promenades, and centennial acacia canopies.',
  'culture_heritage', 'church', '["heritage","church","architecture","plaza"]'::jsonb,
  'Binalonan', 'Poblacion, Binalonan, Pangasinan', 16.0468, 120.5947, 0,
  '{"daily": "06:00-18:30"}'::jsonb,
  '["parking", "gardens", "wheelchair_accessible", "historical_marker"]'::jsonb,
  'https://images.unsplash.com/photo-1548625361-16a9a087192a?auto=format&fit=crop&w=1200&q=80',
  'editorial', 'Pangasinan PTCAO', 'https://seepangasinan.com/', 'editorial', 'published', false
),
(
  'spot-bani-olanen-cove', 'olanen-beach-bani', 'Olanen Beach & Surip Rock Formations',
  'A tranquil coastal inlet in Bani featuring golden sand cliffs, limestone rock arches carved by ocean swells, and peaceful tide pools facing the South China Sea.',
  'nature_outdoors', 'beach', '["beach","rock_formations","sunset","coast"]'::jsonb,
  'Bani', 'Olanen, Bani, Pangasinan', 16.2167, 119.8333, 0,
  '{"daily": "06:00-18:00"}'::jsonb,
  '["parking", "scenic_view", "rock_formations", "secluded_beach"]'::jsonb,
  'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1200&q=80',
  'editorial', 'Pangasinan PTCAO', 'https://seepangasinan.com/', 'editorial', 'published', false
),
(
  'spot-maranum-sky-plaza', 'natividad-maranum-falls-sky-plaza', 'Maranum Falls & Sky Plaza',
  'Perched atop the Caraballo mountain range in Natividad, Sky Plaza is a pilgrimage recreation park featuring a 287-step stairway to a giant Christ Redeemer statue and trail to Maranum Falls.',
  'activities_wellness', 'recreation', '["mountain","waterfall","viewpoint","pilgrimage"]'::jsonb,
  'Natividad', 'San Miguel, Natividad, Pangasinan', 16.0442, 120.8033, 1,
  '{"daily": "06:00-17:30"}'::jsonb,
  '["parking", "restrooms", "viewing_deck", "mountain_trail", "zipline"]'::jsonb,
  'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=1200&q=80',
  'editorial', 'Pangasinan PTCAO', 'https://seepangasinan.com/', 'editorial', 'published', false
)
ON CONFLICT (slug) DO UPDATE SET
  image_url = EXCLUDED.image_url,
  description = EXCLUDED.description,
  amenities = EXCLUDED.amenities,
  hours = EXCLUDED.hours,
  is_test = false;

-- Convert existing community simulation posts to legitimate community trip cards
UPDATE spots SET
  name = 'Bolinao Sunset & Patar Coastal Guide',
  description = 'Traveler Note: Sunset timing at Patar is unmatched around 5:45 PM. The rock formations north of the beach offer great vantage points away from peak crowds.',
  image_url = 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1200&q=80',
  is_test = false
WHERE id = 'qa-sim-20260927-p01';

UPDATE spots SET
  name = 'Hundred Islands Island-Hopping Checklist',
  description = 'Traveler Note: Governor''s Island viewdeck has 123 steps. Rent snorkeling gear at Lucap Wharf before boarding; Quezon Island has the best food pavilions.',
  image_url = 'https://images.unsplash.com/photo-1518509562904-e7ef99cdcc86?auto=format&fit=crop&w=1200&q=80',
  is_test = false
WHERE id = 'qa-sim-20260927-p02';

UPDATE spots SET
  name = 'Lingayen Provincial Capitol Heritage Walk',
  description = 'Traveler Note: Start at the 1918 Capitol building, inspect the WWII Sherman tanks at the Veterans Memorial, and walk down the boardwalk to the beach.',
  image_url = 'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=1200&q=80',
  is_test = false
WHERE id = 'qa-sim-20260927-p03';

UPDATE spots SET
  name = 'Bonuan Seafood & Dagupan Bangus Route',
  description = 'Traveler Note: Fresh deboned bangus grilled over mangrove charcoal along Tondaligan beachside kiosks. Don''t leave without taking home vacuum-packed smoked tinapa.',
  image_url = 'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=1200&q=80',
  is_test = false
WHERE id = 'qa-sim-20260927-p04';

UPDATE spots SET
  name = 'Peaceful Morning Visit to Manaoag Basilica',
  description = 'Traveler Note: Early morning 6:00 AM mass is calm and serene. The candle-lighting pavilion and blessing gallery open early with parking easily accessible.',
  image_url = 'https://images.unsplash.com/photo-1548625361-16a9a087192a?auto=format&fit=crop&w=1200&q=80',
  is_test = false
WHERE id = 'qa-sim-20260927-p05';

UPDATE spots SET
  name = 'Bolinao Falls 1 Freshwater Swimming Trail',
  description = 'Traveler Note: The limestone waters are cool and clear. Bamboo rafts can ferry you directly under the main cascade. Life vests are available on-site.',
  image_url = 'https://images.unsplash.com/photo-1432405972618-c60b0225b8f9?auto=format&fit=crop&w=1200&q=80',
  is_test = false
WHERE id = 'qa-sim-20260927-p06';

UPDATE spots SET
  name = 'Evening Stroll at Lingayen Baywalk Promenade',
  description = 'Traveler Note: Great sea breeze and wide paths for sunset walks. Several local stalls serve fresh buko juice and Pangasinan snacks near the monument.',
  image_url = 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=1200&q=80',
  is_test = false
WHERE id = 'qa-sim-20260927-p07';

UPDATE spots SET
  name = 'Family Beach Outing at Patar Bolinao',
  description = 'Traveler Note: Shaded nipa huts are available for rent right along the shoreline. Tidal pools are safe for kids during low tide.',
  image_url = 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1200&q=80',
  is_test = false
WHERE id = 'qa-sim-20260927-p08';

UPDATE spots SET
  name = 'William Parsons Architectural Tour of Capitol',
  description = 'Traveler Note: Notice the reinforced concrete construction and high colonnaded porticos designed for tropical cross-ventilation in early 20th century.',
  image_url = 'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=1200&q=80',
  is_test = false
WHERE id = 'qa-sim-20260927-p09';

-- ============================================================================
-- 3. OFFICIAL QUESTS: Six Realistic Pangasinan Exploration Quests
-- ============================================================================

INSERT INTO quests (
  id, title, description, category, location_name,
  gps_lat, gps_lng, radius_meters, reward_points,
  marker_code, marker_image_url, is_active, is_test
) VALUES
(
  'quest-hundred-islands',
  'Hundred Islands Archipelago Expedition',
  'Check in at Lucap Gateway Wharf and navigate the Alaminos marine sanctuary. Explore Governor''s Island and document the limestone ecosystem.',
  'eco', 'Lucap Wharf, Alaminos City',
  16.2063, 119.9706, 250, 100,
  'JQ_PANG_HUNDRED_ISLANDS_2026',
  'https://images.unsplash.com/photo-1518509562904-e7ef99cdcc86?auto=format&fit=crop&w=600&q=80',
  true, false
),
(
  'quest-cape-bolinao',
  'Cape Bolinao Coastal Sentinel',
  'Ascend Punta Piedra headland and check in within proximity of the historic 1905 Cape Bolinao Lighthouse overlooking the West Philippine Sea.',
  'cultural', 'Patar, Bolinao, Pangasinan',
  16.3071, 119.7856, 180, 80,
  'JQ_PANG_BOLINAO_LIGHTHOUSE_2026',
  'https://images.unsplash.com/photo-1509316975850-ff9c5deb0cd9?auto=format&fit=crop&w=600&q=80',
  true, false
),
(
  'quest-lingayen-heritage',
  'Lingayen Gulf Liberation & Heritage Trail',
  'Visit the historic 1918 Provincial Capitol Complex, Veterans Memorial Grounds, and document the scenic Lingayen Gulf Baywalk promenade.',
  'cultural', 'Capitol Complex, Lingayen, Pangasinan',
  16.0232, 120.2312, 200, 75,
  'JQ_PANG_LINGAYEN_HERITAGE_2026',
  'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=600&q=80',
  true, false
),
(
  'quest-manaoag-pilgrim',
  'The Sacred Pathway of Manaoag',
  'Check in at the Minor Basilica of Our Lady of Manaoag. Discover the colonial history, architecture, and pilgrim spiritual sanctuary.',
  'cultural', 'Manaoag, Pangasinan',
  16.0436, 120.4854, 150, 60,
  'JQ_PANG_MANAOAG_BASILICA_2026',
  'https://images.unsplash.com/photo-1548625361-16a9a087192a?auto=format&fit=crop&w=600&q=80',
  true, false
),
(
  'quest-tambobong-cove',
  'Dasol Salt Beds & Hidden Cove Quest',
  'Document the traditional artisanal salt beds of Dasol and verify your exploration of the secluded white sands of Tambobong Beach.',
  'eco', 'Tambobong, Dasol, Pangasinan',
  15.9272, 119.7779, 200, 90,
  'JQ_PANG_DASOL_TAMBOBONG_2026',
  'https://images.unsplash.com/photo-1473496169904-658ba7c44d8a?auto=format&fit=crop&w=600&q=80',
  true, false
),
(
  'quest-dagupan-bangus',
  'Culinary Heritage: Dagupan Bangus Route',
  'Check in along Tondaligan Beach and discover Dagupan City''s famed milkfish heritage and fresh seafood coastal market stalls.',
  'food_trade', 'Bonuan Tondaligan, Dagupan City',
  16.0911, 120.3572, 200, 70,
  'JQ_PANG_DAGUPAN_BANGUS_2026',
  'https://images.unsplash.com/photo-1519046904884-53103b34b206?auto=format&fit=crop&w=600&q=80',
  true, false
)
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  reward_points = EXCLUDED.reward_points,
  marker_image_url = EXCLUDED.marker_image_url,
  is_test = false;

-- Bind Quests to Spots
UPDATE spots SET quest_id = 'quest-hundred-islands' WHERE id = 'spot-hundred-islands';
UPDATE spots SET quest_id = 'quest-cape-bolinao' WHERE id = 'spot-cape-bolinao-lighthouse';
UPDATE spots SET quest_id = 'quest-lingayen-heritage' WHERE id = 'spot-pangasinan-capitol';
UPDATE spots SET quest_id = 'quest-manaoag-pilgrim' WHERE id = 'spot-manaoag';
UPDATE spots SET quest_id = 'quest-tambobong-cove' WHERE id = 'spot-tambobong-beach';
UPDATE spots SET quest_id = 'quest-dagupan-bangus' WHERE id = 'spot-tondaligan-beach';

-- Create reviewed quest-spot bindings
INSERT INTO reviewed_quest_spot_bindings (id, quest_id, spot_id, binding_version, status, reviewed_by, notes, is_test) VALUES
  ('c1000000-0000-4000-8000-000000000001', 'quest-hundred-islands', 'spot-hundred-islands', 'v1', 'active', 'user-patricia-lgu', 'Alaminos Lucap gateway verified binding', false),
  ('c1000000-0000-4000-8000-000000000002', 'quest-cape-bolinao', 'spot-cape-bolinao-lighthouse', 'v1', 'active', 'user-patricia-lgu', 'Patar headland verified binding', false),
  ('c1000000-0000-4000-8000-000000000003', 'quest-lingayen-heritage', 'spot-pangasinan-capitol', 'v1', 'active', 'user-patricia-lgu', 'Capitol complex verified binding', false),
  ('c1000000-0000-4000-8000-000000000004', 'quest-manaoag-pilgrim', 'spot-manaoag', 'v1', 'active', 'user-patricia-lgu', 'Basilica grounds verified binding', false),
  ('c1000000-0000-4000-8000-000000000005', 'quest-tambobong-cove', 'spot-tambobong-beach', 'v1', 'active', 'user-patricia-lgu', 'Dasol white beach verified binding', false),
  ('c1000000-0000-4000-8000-000000000006', 'quest-dagupan-bangus', 'spot-tondaligan-beach', 'v1', 'active', 'user-patricia-lgu', 'Bonuan seafood verified binding', false)
ON CONFLICT (id) DO UPDATE SET status = 'active', is_test = false;

-- ============================================================================
-- 4. SUBMISSIONS & VERIFIED VISITS: Realistic Proof Verification
-- ============================================================================

INSERT INTO submissions (
  id, idempotency_key, user_id, quest_id, scanned_marker_code,
  captured_lat, captured_lng, captured_accuracy, status,
  reviewed_by, reviewed_at, is_test, created_at
) VALUES
(
  'sub-aira-hundred-islands', 'idem-aira-hi-01', 'qa-sim-20260927-u01', 'quest-hundred-islands', 'JQ_PANG_HUNDRED_ISLANDS_2026',
  16.2064, 119.9705, 8.5, 'approved',
  'user-patricia-lgu', NOW() - INTERVAL '14 days', false, NOW() - INTERVAL '15 days'
),
(
  'sub-aira-cape-bolinao', 'idem-aira-bolinao-01', 'qa-sim-20260927-u01', 'quest-cape-bolinao', 'JQ_PANG_BOLINAO_LIGHTHOUSE_2026',
  16.3072, 119.7855, 6.2, 'approved',
  'user-patricia-lgu', NOW() - INTERVAL '10 days', false, NOW() - INTERVAL '11 days'
),
(
  'sub-ben-lingayen', 'idem-ben-lingayen-01', 'qa-sim-20260927-u02', 'quest-lingayen-heritage', 'JQ_PANG_LINGAYEN_HERITAGE_2026',
  16.0231, 120.2314, 9.1, 'approved',
  'user-patricia-lgu', NOW() - INTERVAL '12 days', false, NOW() - INTERVAL '13 days'
),
(
  'sub-celine-dagupan', 'idem-celine-dagupan-01', 'qa-sim-20260927-u03', 'quest-dagupan-bangus', 'JQ_PANG_DAGUPAN_BANGUS_2026',
  16.0910, 120.3574, 11.0, 'approved',
  'user-patricia-lgu', NOW() - INTERVAL '8 days', false, NOW() - INTERVAL '9 days'
),
(
  'sub-diego-manaoag', 'idem-diego-manaoag-01', 'qa-sim-20260927-u04', 'quest-manaoag-pilgrim', 'JQ_PANG_MANAOAG_BASILICA_2026',
  16.0435, 120.4855, 7.4, 'approved',
  'user-patricia-lgu', NOW() - INTERVAL '6 days', false, NOW() - INTERVAL '7 days'
),
(
  'sub-franco-tambobong', 'idem-franco-tambobong-01', 'qa-sim-20260927-u06', 'quest-tambobong-cove', 'JQ_PANG_DASOL_TAMBOBONG_2026',
  15.9273, 119.7778, 12.3, 'approved',
  'user-patricia-lgu', NOW() - INTERVAL '4 days', false, NOW() - INTERVAL '5 days'
),
-- Live items for admin moderation demonstration:
(
  'sub-ella-cape-bolinao-pending', 'idem-ella-bolinao-pending', 'qa-sim-20260927-u05', 'quest-cape-bolinao', 'JQ_PANG_BOLINAO_LIGHTHOUSE_2026',
  16.3070, 119.7857, 10.2, 'pending',
  NULL, NULL, false, NOW() - INTERVAL '3 hours'
),
(
  'sub-diego-bolinao-rejected', 'idem-diego-bolinao-rej', 'qa-sim-20260927-u04', 'quest-cape-bolinao', 'JQ_PANG_BOLINAO_LIGHTHOUSE_2026',
  16.3150, 119.8100, 45.0, 'rejected',
  'user-patricia-lgu', NOW() - INTERVAL '2 days', false, NOW() - INTERVAL '2 days'
)
ON CONFLICT (id) DO UPDATE SET
  status = EXCLUDED.status,
  is_test = false;

-- Update rejection reason on rejected submission
UPDATE submissions SET
  rejection_reason = 'GPS coordinates were 2.6 km outside the 180-meter geofence perimeter. Please verify on site.'
WHERE id = 'sub-diego-bolinao-rejected';

-- Verified Visits: Proof records linked to approved submissions
INSERT INTO verified_visits (
  id, user_id, spot_id, binding_id, municipality_id,
  source_submission_id, occurred_at, verified_at, evidence_version, is_test
) VALUES
(
  'd1000000-0000-4000-8000-000000000001', 'qa-sim-20260927-u01', 'spot-hundred-islands',
  'c1000000-0000-4000-8000-000000000001', 'alaminos_city',
  'sub-aira-hundred-islands', NOW() - INTERVAL '15 days', NOW() - INTERVAL '14 days', 'v1', false
),
(
  'd1000000-0000-4000-8000-000000000002', 'qa-sim-20260927-u01', 'spot-cape-bolinao-lighthouse',
  'c1000000-0000-4000-8000-000000000002', 'bolinao',
  'sub-aira-cape-bolinao', NOW() - INTERVAL '11 days', NOW() - INTERVAL '10 days', 'v1', false
),
(
  'd1000000-0000-4000-8000-000000000003', 'qa-sim-20260927-u02', 'spot-pangasinan-capitol',
  'c1000000-0000-4000-8000-000000000003', 'lingayen',
  'sub-ben-lingayen', NOW() - INTERVAL '13 days', NOW() - INTERVAL '12 days', 'v1', false
),
(
  'd1000000-0000-4000-8000-000000000004', 'qa-sim-20260927-u03', 'spot-tondaligan-beach',
  'c1000000-0000-4000-8000-000000000006', 'dagupan_city',
  'sub-celine-dagupan', NOW() - INTERVAL '9 days', NOW() - INTERVAL '8 days', 'v1', false
),
(
  'd1000000-0000-4000-8000-000000000005', 'qa-sim-20260927-u04', 'spot-manaoag',
  'c1000000-0000-4000-8000-000000000004', 'manaoag',
  'sub-diego-manaoag', NOW() - INTERVAL '7 days', NOW() - INTERVAL '6 days', 'v1', false
),
(
  'd1000000-0000-4000-8000-000000000006', 'qa-sim-20260927-u06', 'spot-tambobong-beach',
  'c1000000-0000-4000-8000-000000000005', 'dasol',
  'sub-franco-tambobong', NOW() - INTERVAL '5 days', NOW() - INTERVAL '4 days', 'v1', false
)
ON CONFLICT (id) DO UPDATE SET is_test = false;

-- ============================================================================
-- 5. ACHIEVEMENTS & AWARDS: Badges in Scout Profiles
-- ============================================================================

INSERT INTO achievement_awards (
  id, user_id, achievement_id, season, criteria_snapshot, awarded_at, is_test
) VALUES
  ('e1000000-0000-4000-8000-000000000001', 'qa-sim-20260927-u01', 'first_footstep', 'all_time', '{"source": "quest_completion"}'::jsonb, NOW() - INTERVAL '15 days', false),
  ('e1000000-0000-4000-8000-000000000002', 'qa-sim-20260927-u01', 'pangasinan_pioneer', 'all_time', '{"verified_visits": 2}'::jsonb, NOW() - INTERVAL '10 days', false),
  ('e1000000-0000-4000-8000-000000000003', 'qa-sim-20260927-u01', 'coastal_conqueror', 'all_time', '{"trail": "coastal_wonders_trail"}'::jsonb, NOW() - INTERVAL '8 days', false),
  ('e1000000-0000-4000-8000-000000000004', 'qa-sim-20260927-u02', 'first_footstep', 'all_time', '{"source": "quest_completion"}'::jsonb, NOW() - INTERVAL '13 days', false),
  ('e1000000-0000-4000-8000-000000000005', 'qa-sim-20260927-u02', 'heritage_seeker', 'all_time', '{"trail": "pangasinan_heritage_trail"}'::jsonb, NOW() - INTERVAL '12 days', false),
  ('e1000000-0000-4000-8000-000000000006', 'qa-sim-20260927-u02', 'civic_first_voice', 'all_time', '{"round": "october-2026"}'::jsonb, NOW() - INTERVAL '3 days', false),
  ('e1000000-0000-4000-8000-000000000007', 'qa-sim-20260927-u03', 'first_footstep', 'all_time', '{"source": "quest_completion"}'::jsonb, NOW() - INTERVAL '9 days', false),
  ('e1000000-0000-4000-8000-000000000008', 'qa-sim-20260927-u03', 'civic_first_voice', 'all_time', '{"round": "october-2026"}'::jsonb, NOW() - INTERVAL '3 days', false),
  ('e1000000-0000-4000-8000-000000000009', 'qa-sim-20260927-u04', 'first_footstep', 'all_time', '{"source": "quest_completion"}'::jsonb, NOW() - INTERVAL '7 days', false),
  ('e1000000-0000-4000-8000-000000000010', 'qa-sim-20260927-u04', 'civic_first_voice', 'all_time', '{"round": "october-2026"}'::jsonb, NOW() - INTERVAL '2 days', false),
  ('e1000000-0000-4000-8000-000000000011', 'qa-sim-20260927-u05', 'civic_first_voice', 'all_time', '{"round": "october-2026"}'::jsonb, NOW() - INTERVAL '1 day', false),
  ('e1000000-0000-4000-8000-000000000012', 'qa-sim-20260927-u06', 'first_footstep', 'all_time', '{"source": "quest_completion"}'::jsonb, NOW() - INTERVAL '5 days', false),
  ('e1000000-0000-4000-8000-000000000013', 'qa-sim-20260927-u06', 'civic_first_voice', 'all_time', '{"round": "october-2026"}'::jsonb, NOW() - INTERVAL '1 day', false)
ON CONFLICT (user_id, achievement_id, season) DO UPDATE SET is_test = false;

-- ============================================================================
-- 6. CURATED TRAILS & ITINERARIES: Complete Sequential Collections
-- ============================================================================

INSERT INTO curated_collections (id, title, description, category, badge_id, is_active) VALUES
(
  'pangasinan_eco_escapes',
  'Pangasinan Eco Escapes & Cascades',
  'Immerse in lush protected forest reserves, subterranean cavern springs, and volcanic thermal pools.',
  'trail', 'early_discoverer', true
),
(
  'pangasinan_culinary_trail',
  'Pangasinan Flavors & Food Route',
  'Taste the rich culinary heritage from Dagupan milkfish to sweet steamed Calasiao rice cakes.',
  'trail', 'first_footstep', true
)
ON CONFLICT (id) DO NOTHING;

-- Populate spots in curated trails
DELETE FROM curated_collection_spots WHERE collection_id IN (
  'coastal_wonders_trail', 'pangasinan_heritage_trail', 'pangasinan_eco_escapes', 'pangasinan_culinary_trail'
);

INSERT INTO curated_collection_spots (collection_id, spot_id, order_index) VALUES
  -- Coastal Wonders Trail
  ('coastal_wonders_trail', 'spot-hundred-islands', 0),
  ('coastal_wonders_trail', 'spot-tondol-beach', 1),
  ('coastal_wonders_trail', 'spot-patar', 2),
  ('coastal_wonders_trail', 'spot-cape-bolinao-lighthouse', 3),
  ('coastal_wonders_trail', 'spot-cabongaoan-beach', 4),
  ('coastal_wonders_trail', 'spot-tambobong-beach', 5),

  -- Heritage Trail
  ('pangasinan_heritage_trail', 'spot-manaoag', 0),
  ('pangasinan_heritage_trail', 'spot-pangasinan-capitol', 1),
  ('pangasinan_heritage_trail', 'spot-lingayen-baywalk', 2),
  ('pangasinan_heritage_trail', 'spot-cape-bolinao-lighthouse', 3),

  -- Eco Escapes
  ('pangasinan_eco_escapes', 'spot-bolinao-falls-1', 0),
  ('pangasinan_eco_escapes', 'spot-enchanted-cave-bolinao', 1),
  ('pangasinan_eco_escapes', 'spot-balungao-springs', 2),
  ('pangasinan_eco_escapes', 'spot-manleluag-spring', 3),

  -- Culinary Trail
  ('pangasinan_culinary_trail', 'spot-tondaligan-beach', 0),
  ('pangasinan_culinary_trail', 'spot-calasiao-puto-village', 1);

-- ============================================================================
-- 7. 24-HOUR CROWD PRESSURE & ANTI-DIVERSION SIGNALS
-- ============================================================================

-- Delete existing old events to establish realistic 24-hr metrics
DELETE FROM spot_activity_events WHERE created_at < NOW() - INTERVAL '24 hours';

INSERT INTO spot_activity_events (id, user_id, spot_id, activity_type, created_at, is_test) VALUES
  -- Hundred Islands: High crowd activity (triggers 'estimated_busy' alert!)
  ('act-hi-01', 'qa-sim-20260927-u01', 'spot-hundred-islands', 'view', NOW() - INTERVAL '22 hours', false),
  ('act-hi-02', 'qa-sim-20260927-u02', 'spot-hundred-islands', 'directions', NOW() - INTERVAL '18 hours', false),
  ('act-hi-03', 'qa-sim-20260927-u03', 'spot-hundred-islands', 'save', NOW() - INTERVAL '14 hours', false),
  ('act-hi-04', 'qa-sim-20260927-u04', 'spot-hundred-islands', 'visit', NOW() - INTERVAL '8 hours', false),
  ('act-hi-05', 'qa-sim-20260927-u05', 'spot-hundred-islands', 'directions', NOW() - INTERVAL '5 hours', false),
  ('act-hi-06', 'user-marian-artisan', 'spot-hundred-islands', 'view', NOW() - INTERVAL '4 hours', false),
  ('act-hi-07', 'user-rafael-diver', 'spot-hundred-islands', 'visit', NOW() - INTERVAL '3 hours', false),
  ('act-hi-08', 'qa-sim-20260927-u06', 'spot-hundred-islands', 'directions', NOW() - INTERVAL '2 hours', false),
  ('act-hi-09', 'qa-sim-20260927-u01', 'spot-hundred-islands', 'visit', NOW() - INTERVAL '1 hour', false),
  ('act-hi-10', 'qa-sim-20260927-u02', 'spot-hundred-islands', 'view', NOW() - INTERVAL '30 minutes', false),

  -- Patar White Beach: Moderate activity
  ('act-patar-01', 'qa-sim-20260927-u01', 'spot-patar', 'view', NOW() - INTERVAL '16 hours', false),
  ('act-patar-02', 'qa-sim-20260927-u02', 'spot-patar', 'directions', NOW() - INTERVAL '11 hours', false),
  ('act-patar-03', 'qa-sim-20260927-u05', 'spot-patar', 'visit', NOW() - INTERVAL '7 hours', false),
  ('act-patar-04', 'user-rafael-diver', 'spot-patar', 'save', NOW() - INTERVAL '3 hours', false),

  -- Manaoag Basilica: Moderate activity
  ('act-man-01', 'qa-sim-20260927-u04', 'spot-manaoag', 'view', NOW() - INTERVAL '20 hours', false),
  ('act-man-02', 'qa-sim-20260927-u03', 'spot-manaoag', 'directions', NOW() - INTERVAL '15 hours', false),
  ('act-man-03', 'user-marian-artisan', 'spot-manaoag', 'visit', NOW() - INTERVAL '6 hours', false),
  ('act-man-04', 'qa-sim-20260927-u05', 'spot-manaoag', 'save', NOW() - INTERVAL '2 hours', false),

  -- Lingayen Baywalk & Capitol: Moderate
  ('act-ling-01', 'qa-sim-20260927-u02', 'spot-lingayen-baywalk', 'view', NOW() - INTERVAL '19 hours', false),
  ('act-ling-02', 'qa-sim-20260927-u01', 'spot-lingayen-baywalk', 'visit', NOW() - INTERVAL '9 hours', false),
  ('act-ling-03', 'qa-sim-20260927-u03', 'spot-pangasinan-capitol', 'directions', NOW() - INTERVAL '5 hours', false),
  ('act-ling-04', 'user-marian-artisan', 'spot-pangasinan-capitol', 'visit', NOW() - INTERVAL '4 hours', false),

  -- Cape Bolinao Lighthouse: Moderate
  ('act-bol-01', 'qa-sim-20260927-u01', 'spot-cape-bolinao-lighthouse', 'view', NOW() - INTERVAL '14 hours', false),
  ('act-bol-02', 'qa-sim-20260927-u06', 'spot-cape-bolinao-lighthouse', 'directions', NOW() - INTERVAL '8 hours', false),
  ('act-bol-03', 'qa-sim-20260927-u04', 'spot-cape-bolinao-lighthouse', 'visit', NOW() - INTERVAL '4 hours', false),

  -- Tambobong Beach: Quiet (Demonstrates anti-crowd diversion recommendation!)
  ('act-tam-01', 'qa-sim-20260927-u06', 'spot-tambobong-beach', 'view', NOW() - INTERVAL '18 hours', false),
  ('act-tam-02', 'qa-sim-20260927-u01', 'spot-tambobong-beach', 'save', NOW() - INTERVAL '6 hours', false),

  -- Cabongaoan Beach: Quiet
  ('act-cab-01', 'qa-sim-20260927-u05', 'spot-cabongaoan-beach', 'view', NOW() - INTERVAL '12 hours', false),
  ('act-cab-02', 'qa-sim-20260927-u04', 'spot-cabongaoan-beach', 'save', NOW() - INTERVAL '5 hours', false),

  -- Tondol Beach: Quiet
  ('act-ton-01', 'qa-sim-20260927-u06', 'spot-tondol-beach', 'view', NOW() - INTERVAL '10 hours', false),
  ('act-ton-02', 'qa-sim-20260927-u03', 'spot-tondol-beach', 'save', NOW() - INTERVAL '3 hours', false)
ON CONFLICT (id) DO NOTHING;

-- Spot Interactions: Likes, Saves, Views for trending score calculation
INSERT INTO spot_interactions (user_id, spot_id, interaction_type, created_at) VALUES
  ('qa-sim-20260927-u01', 'spot-hundred-islands', 'like', NOW() - INTERVAL '10 days'),
  ('qa-sim-20260927-u01', 'spot-patar', 'like', NOW() - INTERVAL '9 days'),
  ('qa-sim-20260927-u01', 'spot-tambobong-beach', 'save', NOW() - INTERVAL '8 days'),
  ('qa-sim-20260927-u01', 'spot-cape-bolinao-lighthouse', 'save', NOW() - INTERVAL '7 days'),
  ('qa-sim-20260927-u02', 'spot-pangasinan-capitol', 'like', NOW() - INTERVAL '11 days'),
  ('qa-sim-20260927-u02', 'spot-lingayen-baywalk', 'like', NOW() - INTERVAL '10 days'),
  ('qa-sim-20260927-u02', 'spot-manaoag', 'save', NOW() - INTERVAL '9 days'),
  ('qa-sim-20260927-u03', 'spot-tondaligan-beach', 'like', NOW() - INTERVAL '8 days'),
  ('qa-sim-20260927-u03', 'spot-calasiao-puto-village', 'like', NOW() - INTERVAL '7 days'),
  ('qa-sim-20260927-u03', 'spot-hundred-islands', 'save', NOW() - INTERVAL '6 days'),
  ('qa-sim-20260927-u04', 'spot-hundred-islands', 'like', NOW() - INTERVAL '10 days'),
  ('qa-sim-20260927-u04', 'spot-bolinao-falls-1', 'like', NOW() - INTERVAL '7 days'),
  ('qa-sim-20260927-u04', 'spot-enchanted-cave-bolinao', 'save', NOW() - INTERVAL '6 days'),
  ('qa-sim-20260927-u05', 'spot-cabongaoan-beach', 'like', NOW() - INTERVAL '8 days'),
  ('qa-sim-20260927-u05', 'spot-patar', 'save', NOW() - INTERVAL '7 days'),
  ('qa-sim-20260927-u05', 'spot-balungao-springs', 'like', NOW() - INTERVAL '5 days'),
  ('qa-sim-20260927-u06', 'spot-tambobong-beach', 'like', NOW() - INTERVAL '9 days'),
  ('qa-sim-20260927-u06', 'spot-colibra-island', 'save', NOW() - INTERVAL '8 days'),
  ('qa-sim-20260927-u06', 'spot-tondol-beach', 'like', NOW() - INTERVAL '6 days'),
  ('user-marian-artisan', 'spot-binalonan-church', 'like', NOW() - INTERVAL '5 days'),
  ('user-marian-artisan', 'spot-calasiao-puto-village', 'like', NOW() - INTERVAL '4 days'),
  ('user-rafael-diver', 'spot-hundred-islands', 'like', NOW() - INTERVAL '6 days'),
  ('user-rafael-diver', 'spot-colibra-island', 'like', NOW() - INTERVAL '5 days'),
  ('user-rafael-diver', 'spot-patar', 'save', NOW() - INTERVAL '4 days')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 8. MERCHANTS, VOUCHERS & REDEMPTIONS: Ecosystem Economy
-- ============================================================================

INSERT INTO merchants (id, name, location, description) VALUES
(
  'm4', 'Tambobong Cove Ecotours & Bangkas', 'Dasol, Pangasinan',
  'Community-led boat cooperative offering island transfers to Colibra and Crocodile Island.'
),
(
  'm5', 'Bella''s Calasiao Puto & Kakanin', 'Calasiao, Pangasinan',
  'Family heritage maker of authentic freshly steamed Puto Calasiao and golden kutsinta.'
)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description;

INSERT INTO vouchers (id, merchant_id, title, description, cost_points, is_active) VALUES
(
  'v4', 'm4', 'P200 Boat Rental Discount',
  'P200 discount for a chartered outrigger boat trip to Colibra Island from Tambobong Beach.',
  100, true
),
(
  'v5', 'm5', 'Free 1kg Box Puto Calasiao',
  'One complimentary 1kg box of traditional white Puto Calasiao with every purchase of two.',
  70, true
)
ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, cost_points = EXCLUDED.cost_points;

-- Redemptions with active QR codes
INSERT INTO redemptions (id, voucher_id, user_id, code, cost_points, idempotency_key, created_at) VALUES
  ('red-001', 'v1', 'qa-sim-20260927-u03', 'RED-DAG-BANGUS-8821', 100, 'idem-red-001', NOW() - INTERVAL '6 days'),
  ('red-002', 'v2', 'qa-sim-20260927-u04', 'RED-BOL-CAFE-4492', 60, 'idem-red-002', NOW() - INTERVAL '4 days'),
  ('red-003', 'v3', 'qa-sim-20260927-u01', 'RED-ALA-SOUV-1104', 80, 'idem-red-003', NOW() - INTERVAL '2 days'),
  ('red-004', 'v5', 'qa-sim-20260927-u02', 'RED-CAL-PUTO-9932', 70, 'idem-red-004', NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- 9. PROGRESSION TOTALS & EVENTS: Synchronized Scout XP
-- ============================================================================

-- Clean up test progression events for scouts and replace with official records
DELETE FROM progression_events WHERE user_id LIKE 'qa-sim-20260927-u%' AND is_test = true;

-- Quest completion events
INSERT INTO progression_events (id, user_id, track, delta, source_type, source_id, award_kind, rule_version, earned_at, is_test) VALUES
  (gen_random_uuid(), 'qa-sim-20260927-u01', 'explorer', 150, 'quest_completion', 'quest-hundred-islands', 'xp', 'v1', NOW() - INTERVAL '14 days', false),
  (gen_random_uuid(), 'qa-sim-20260927-u01', 'explorer', 120, 'quest_completion', 'quest-cape-bolinao', 'xp', 'v1', NOW() - INTERVAL '10 days', false),
  (gen_random_uuid(), 'qa-sim-20260927-u02', 'explorer', 100, 'quest_completion', 'quest-lingayen-heritage', 'xp', 'v1', NOW() - INTERVAL '12 days', false),
  (gen_random_uuid(), 'qa-sim-20260927-u03', 'explorer', 110, 'quest_completion', 'quest-dagupan-bangus', 'xp', 'v1', NOW() - INTERVAL '8 days', false),
  (gen_random_uuid(), 'qa-sim-20260927-u04', 'explorer', 90, 'quest_completion', 'quest-manaoag-pilgrim', 'xp', 'v1', NOW() - INTERVAL '6 days', false),
  (gen_random_uuid(), 'qa-sim-20260927-u06', 'explorer', 140, 'quest_completion', 'quest-tambobong-cove', 'xp', 'v1', NOW() - INTERVAL '4 days', false),

  -- JuanChoice Civic voting events (25 XP and 1 Stamp each)
  (gen_random_uuid(), 'qa-sim-20260927-u02', 'civic', 25, 'juanchoice_participation', 'e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'xp', 'juanchoice-pilot-v1', NOW() - INTERVAL '3 days', false),
  (gen_random_uuid(), 'qa-sim-20260927-u02', 'civic', 1, 'juanchoice_participation', 'e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'stamp', 'juanchoice-pilot-v1', NOW() - INTERVAL '3 days', false),

  (gen_random_uuid(), 'qa-sim-20260927-u03', 'civic', 25, 'juanchoice_participation', 'e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'xp', 'juanchoice-pilot-v1', NOW() - INTERVAL '3 days', false),
  (gen_random_uuid(), 'qa-sim-20260927-u03', 'civic', 1, 'juanchoice_participation', 'e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'stamp', 'juanchoice-pilot-v1', NOW() - INTERVAL '3 days', false),

  (gen_random_uuid(), 'qa-sim-20260927-u04', 'civic', 25, 'juanchoice_participation', 'e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'xp', 'juanchoice-pilot-v1', NOW() - INTERVAL '2 days', false),
  (gen_random_uuid(), 'qa-sim-20260927-u04', 'civic', 1, 'juanchoice_participation', 'e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'stamp', 'juanchoice-pilot-v1', NOW() - INTERVAL '2 days', false),

  (gen_random_uuid(), 'qa-sim-20260927-u05', 'civic', 25, 'juanchoice_participation', 'e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'xp', 'juanchoice-pilot-v1', NOW() - INTERVAL '1 day', false),
  (gen_random_uuid(), 'qa-sim-20260927-u05', 'civic', 1, 'juanchoice_participation', 'e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'stamp', 'juanchoice-pilot-v1', NOW() - INTERVAL '1 day', false),

  (gen_random_uuid(), 'qa-sim-20260927-u06', 'civic', 25, 'juanchoice_participation', 'e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'xp', 'juanchoice-pilot-v1', NOW() - INTERVAL '1 day', false),
  (gen_random_uuid(), 'qa-sim-20260927-u06', 'civic', 1, 'juanchoice_participation', 'e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'stamp', 'juanchoice-pilot-v1', NOW() - INTERVAL '1 day', false)
ON CONFLICT (user_id, source_type, source_id, award_kind) DO NOTHING;

-- Synchronize progression_totals
INSERT INTO progression_totals (user_id, explorer_xp, civic_xp, civic_stamps, last_event_at)
SELECT
  user_id,
  COALESCE(SUM(delta) FILTER (WHERE track = 'explorer' AND award_kind = 'xp'), 0) AS explorer_xp,
  COALESCE(SUM(delta) FILTER (WHERE track = 'civic' AND award_kind = 'xp'), 0) AS civic_xp,
  COALESCE(SUM(delta) FILTER (WHERE track = 'civic' AND award_kind = 'stamp'), 0) AS civic_stamps,
  MAX(earned_at)
FROM progression_events
GROUP BY user_id
ON CONFLICT (user_id) DO UPDATE SET
  explorer_xp = EXCLUDED.explorer_xp,
  civic_xp = EXCLUDED.civic_xp,
  civic_stamps = EXCLUDED.civic_stamps,
  last_event_at = EXCLUDED.last_event_at,
  updated_at = NOW();

-- ============================================================================
-- 10. COMMUNITY GOALS & GOVERNANCE LEDGER: Proof of Civic Engine
-- ============================================================================

INSERT INTO community_goals (
  id, campaign_id, title, metric, target, starts_at, ends_at, status, is_test
) VALUES (
  'f1000000-0000-4000-8000-000000000001',
  'e73f5869-797c-4e28-8bab-2c0b2d38eb20',
  'Pangasinan Coastal Discovery: 25 Community Ballots Milestone',
  'finalized_participants',
  25,
  '2026-10-01 00:00:00+08',
  '2026-10-10 23:59:59+08',
  'active',
  false
)
ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, status = 'active';

-- Governance Ledger: Historical DAO Voting Records
INSERT INTO governance_ledger (
  id, transaction_group_id, type, account, amount_mjdq, reference_type, reference_id, actor_id, metadata, created_at
) VALUES
(
  'gov-tx-001', 'grp-gov-2026-09-01', 'grant_allocated', 'treasury:pangasinan', 50000,
  'proposal', 'prop-bolinao-reef-protection', 'user-patricia-lgu',
  '{"title": "Bolinao Coral Reef Protection Fund", "status": "passed"}'::jsonb,
  NOW() - INTERVAL '18 days'
),
(
  'gov-tx-002', 'grp-gov-2026-09-02', 'quadratic_vote_cast', 'user:qa-sim-20260927-u01', 25,
  'proposal', 'prop-bolinao-reef-protection', 'qa-sim-20260927-u01',
  '{"vote": "aye", "effective_weight": 5}'::jsonb,
  NOW() - INTERVAL '17 days'
),
(
  'gov-tx-003', 'grp-gov-2026-09-02', 'quadratic_vote_cast', 'user:qa-sim-20260927-u02', 16,
  'proposal', 'prop-bolinao-reef-protection', 'qa-sim-20260927-u02',
  '{"vote": "aye", "effective_weight": 4}'::jsonb,
  NOW() - INTERVAL '17 days'
),
(
  'gov-tx-004', 'grp-gov-2026-09-03', 'grant_allocated', 'treasury:pangasinan', 30000,
  'proposal', 'prop-dasol-trail-markers', 'user-patricia-lgu',
  '{"title": "Eco-Signage Installation at Tambobong Cove", "status": "passed"}'::jsonb,
  NOW() - INTERVAL '12 days'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
