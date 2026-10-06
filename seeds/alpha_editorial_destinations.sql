-- Small, source-backed public alpha catalog. These are destination listings,
-- not verified visits, paid partner offers, or quest proof locations.
-- No stock photos, operating hours, prices, or amenities are asserted.
-- Reviewed against the linked LGU/provincial sources on 2026-09-27.

INSERT INTO spots (
  id, slug, name, description, category, subcategory, tags,
  municipality, address, gps_lat, gps_lng, hours, amenities, image_url,
  source_type, source_name, source_url, trust_level, status, is_test
) VALUES
(
  'spot-hundred-islands', 'hundred-islands-national-park',
  'Hundred Islands National Park',
  'Explore the Alaminos archipelago from the Lucap visitor gateway. Confirm boat schedules and current access rules locally.',
  'nature_outdoors', 'park', '["island", "coast", "scenic"]'::jsonb,
  'Alaminos City', 'Lucap, Alaminos City, Pangasinan', 16.2063, 119.9706,
  '{}'::jsonb, '[]'::jsonb, '', 'editorial', 'JuanDerQuest Alpha Editorial',
  'https://www.alaminoscity.gov.ph/i-choose-hundred-islands/hundred-islands-national-park.html',
  'editorial', 'published', FALSE
),
(
  'spot-patar', 'patar-white-beach', 'Patar White Beach',
  'A beach destination in Bolinao known for its coastline and sunsets. Confirm local conditions and access before travel.',
  'nature_outdoors', 'beach', '["beach", "sunset", "coast"]'::jsonb,
  'Bolinao', 'Patar, Bolinao, Pangasinan', 16.3204, 119.7847,
  '{}'::jsonb, '[]'::jsonb, '', 'editorial', 'JuanDerQuest Alpha Editorial',
  'https://www.pangasinan.gov.ph/city-municipalities/bolinao/',
  'editorial', 'published', FALSE
),
(
  'spot-manaoag', 'minor-basilica-of-manaoag',
  'Minor Basilica of Our Lady of Manaoag',
  'A major pilgrimage landmark in Manaoag. Check the basilica’s current visitor guidance before arrival.',
  'culture_heritage', 'church', '["pilgrimage", "heritage"]'::jsonb,
  'Manaoag', 'Manaoag, Pangasinan', 16.0436, 120.4854,
  '{}'::jsonb, '[]'::jsonb, '', 'editorial', 'JuanDerQuest Alpha Editorial',
  'https://www.pangasinan.gov.ph/district/4th-district/',
  'editorial', 'published', FALSE
),
(
  'spot-lingayen-baywalk', 'lingayen-baywalk', 'Lingayen Baywalk',
  'A public coastal promenade in the provincial capital for walking and views of Lingayen Gulf.',
  'activities_wellness', 'running_spot', '["coast", "walking", "scenic"]'::jsonb,
  'Lingayen', 'Lingayen, Pangasinan', 16.0218, 120.2319,
  '{}'::jsonb, '[]'::jsonb, '', 'editorial', 'JuanDerQuest Alpha Editorial',
  'https://www.pangasinan.gov.ph/city-municipalities/lingayen/',
  'editorial', 'published', FALSE
),
(
  'spot-pangasinan-capitol', 'pangasinan-provincial-capitol',
  'Pangasinan Provincial Capitol',
  'Visit the historic Capitol grounds in Lingayen; redevelopment may affect access to some areas.',
  'culture_heritage', 'heritage_site', '["heritage", "architecture", "walking"]'::jsonb,
  'Lingayen', 'Capitol Complex, Lingayen, Pangasinan', 16.0232, 120.2312,
  '{}'::jsonb, '[]'::jsonb, '', 'editorial', 'JuanDerQuest Alpha Editorial',
  'https://www.pangasinan.gov.ph/the-redevelopment-of-the-pangasinan-capitol-grounds-where-progress-meets-heritage/',
  'editorial', 'published', FALSE
)
ON CONFLICT (slug) DO NOTHING;
