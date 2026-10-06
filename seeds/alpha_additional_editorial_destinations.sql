-- Additive, idempotent public destination listings for the dedicated laptop alpha.
-- Place existence/descriptions: Pangasinan PTCAO / Provincial Government (source_url).
-- Map pins: OpenStreetMap Nominatim POI results checked 2026-09-27; these are
-- discovery pins, not GPS proof targets. No hours, fees, amenities, media,
-- attendance claims, or quest bindings are asserted.

BEGIN;

INSERT INTO spots (
  id, slug, name, description, category, subcategory, tags,
  municipality, address, gps_lat, gps_lng, hours, amenities, image_url,
  source_type, source_name, source_url, trust_level, status, is_test
) VALUES
(
  'spot-cape-bolinao-lighthouse', 'cape-bolinao-lighthouse', 'Cape Bolinao Lighthouse',
  'A heritage lighthouse at Punta Piedra. Visitors can view its exterior; check current site access before traveling.',
  'culture_heritage', 'heritage_site', '["heritage","lighthouse","coast"]'::jsonb,
  'Bolinao', 'Patar, Bolinao, Pangasinan', 16.3071116, 119.7856181,
  '{}'::jsonb, '[]'::jsonb, '', 'editorial', 'Pangasinan PTCAO',
  'https://seepangasinan.com/places/cape-bolinao-lighthouse/', 'editorial', 'published', FALSE
),
(
  'spot-bolinao-falls-1', 'bolinao-falls-1', 'Bolinao Falls 1',
  'One stop in Bolinao''s connected waterfall system. Confirm local access, water conditions, and safety rules before a visit.',
  'nature_outdoors', 'waterfall', '["waterfall","nature","freshwater"]'::jsonb,
  'Bolinao', 'Samang Norte, Bolinao, Pangasinan', 16.3058696, 119.8601895,
  '{}'::jsonb, '[]'::jsonb, '', 'editorial', 'Pangasinan PTCAO',
  'https://seepangasinan.com/places/bolinao-falls/', 'editorial', 'published', FALSE
),
(
  'spot-enchanted-cave-bolinao', 'enchanted-cave-bolinao', 'Enchanted Cave',
  'A limestone cave within a Bolinao eco-park. Check current access and follow on-site safety guidance.',
  'nature_outdoors', 'cave', '["cave","geology","nature"]'::jsonb,
  'Bolinao', 'Patar Road, Bolinao, Pangasinan', 16.3420930, 119.8042730,
  '{}'::jsonb, '[]'::jsonb, '', 'editorial', 'Pangasinan PTCAO',
  'https://seepangasinan.com/places/enchanted-cave/', 'editorial', 'published', FALSE
),
(
  'spot-tondol-beach', 'tondol-beach-anda', 'Tondol Beach',
  'A white-sand beach in Anda known for its shallow coastal sandbar. Tide and sea conditions vary; check locally.',
  'nature_outdoors', 'beach', '["beach","sandbar","coast"]'::jsonb,
  'Anda', 'Tondol, Anda, Pangasinan', 16.3138195, 120.0170323,
  '{}'::jsonb, '[]'::jsonb, '', 'editorial', 'Pangasinan PTCAO',
  'https://seepangasinan.com/places/tondol-beach/', 'editorial', 'published', FALSE
),
(
  'spot-cabongaoan-beach', 'cabongaoan-beach', 'Cabongaoan Beach',
  'A sandy Burgos coast with rocky tidal pools and viewpoints. Treat the pools and surf with caution.',
  'nature_outdoors', 'beach', '["beach","coast","rock_formations"]'::jsonb,
  'Burgos', 'Cabongaoan, Burgos, Pangasinan', 15.9892305, 119.7634067,
  '{}'::jsonb, '[]'::jsonb, '', 'editorial', 'Pangasinan PTCAO',
  'https://seepangasinan.com/places/cabongaoan-beach/', 'editorial', 'published', FALSE
),
(
  'spot-tambobong-beach', 'tambobong-beach', 'Tambobong Beach',
  'A coastal beach beside the fishing village of Tambobong in Dasol. Confirm travel and boat arrangements locally.',
  'nature_outdoors', 'beach', '["beach","coast","fishing_village"]'::jsonb,
  'Dasol', 'Tambobong, Dasol, Pangasinan', 15.9271996, 119.7778772,
  '{}'::jsonb, '[]'::jsonb, '', 'editorial', 'Pangasinan PTCAO',
  'https://seepangasinan.com/places/tambobong-beach/', 'editorial', 'published', FALSE
),
(
  'spot-tondaligan-beach', 'tondaligan-beach', 'Tondaligan Beach',
  'A public beach in the Bonuan area of Dagupan City. Check sea conditions and available facilities before visiting.',
  'nature_outdoors', 'beach', '["beach","city_coast","walking"]'::jsonb,
  'Dagupan City', 'Bonuan Gueset, Dagupan City, Pangasinan', 16.0910556, 120.3571739,
  '{}'::jsonb, '[]'::jsonb, '', 'editorial', 'Pangasinan PTCAO',
  'https://seepangasinan.com/places/tondaligan-beach/', 'editorial', 'published', FALSE
),
(
  'spot-balungao-springs', 'balungao-hot-and-cold-springs', 'Balungao Hot and Cold Springs',
  'A Balungao spring destination near Mount Balungao. Check current access and activity availability locally.',
  'activities_wellness', 'recreation', '["spring","wellness","nature"]'::jsonb,
  'Balungao', 'Mabini, Balungao, Pangasinan', 15.8669472, 120.6864810,
  '{}'::jsonb, '[]'::jsonb, '', 'editorial', 'Province of Pangasinan',
  'https://www.pangasinan.gov.ph/city-municipalities/balungao/', 'editorial', 'published', FALSE
),
(
  'spot-manleluag-spring', 'manleluag-spring-protected-landscape', 'Manleluag Spring Protected Landscape',
  'A protected spring and forest landscape in Mangatarem. Verify access requirements and trail conditions before traveling.',
  'nature_outdoors', 'park', '["spring","forest","protected_area"]'::jsonb,
  'Mangatarem', 'Pacalat, Mangatarem, Pangasinan', 15.7018494, 120.2826623,
  '{}'::jsonb, '[]'::jsonb, '', 'editorial', 'Pangasinan PTCAO',
  'https://seepangasinan.com/places/manleluag-spring-protected-landscape/', 'editorial', 'published', FALSE
)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
