-- Only image/source metadata changes; the apply helper verifies all four
-- exact target identities and current stock URLs before applying this migration.

UPDATE spots
SET image_url = '/api/v1/uploads/spot-photos/catalog-pangasinan-capitol.jpg',
    source_type = 'open_data',
    source_name = 'Photo: Patrickroque01 · CC BY-SA 4.0',
    source_url = 'https://commons.wikimedia.org/wiki/File:Pangasinan_Capitol_(Lingayen,_Pangasinan;_12-05-2022).jpg',
    trust_level = 'open_data',
    updated_at = NOW()
WHERE id = 'spot-pangasinan-capitol'
  AND slug = 'pangasinan-provincial-capitol'
  AND status = 'published' AND is_test = FALSE
  AND image_url LIKE 'https://images.unsplash.com/%';

UPDATE spots
SET image_url = '/api/v1/uploads/spot-photos/catalog-binmaley-church.jpg',
    source_type = 'open_data',
    source_name = 'Photo: Ralff Nestor Nacor · CC BY-SA 4.0',
    source_url = 'https://commons.wikimedia.org/wiki/File:Binmaley_Church,_Pangasinan,_Jun_2024_(1).jpg',
    trust_level = 'open_data',
    updated_at = NOW()
WHERE id = 'spot-binmaley-church'
  AND slug = 'binmaley-purification-parish-church'
  AND status = 'published' AND is_test = FALSE
  AND image_url LIKE 'https://images.unsplash.com/%';

UPDATE spots
SET image_url = '/api/v1/uploads/spot-photos/catalog-lingayen-baywalk.jpg',
    source_type = 'open_data',
    source_name = 'Photo: JasDolt · CC0',
    source_url = 'https://commons.wikimedia.org/wiki/File:Lingayen_Baywalk_1.jpg',
    trust_level = 'open_data',
    updated_at = NOW()
WHERE id = 'spot-lingayen-baywalk'
  AND slug = 'lingayen-baywalk'
  AND status = 'published' AND is_test = FALSE
  AND image_url LIKE 'https://images.unsplash.com/%';

UPDATE spots
SET image_url = '/api/v1/uploads/spot-photos/catalog-dagupan-cathedral.jpg',
    source_type = 'open_data',
    source_name = 'Photo: Ralff Nestor Nacor · CC BY-SA 4.0',
    source_url = 'https://commons.wikimedia.org/wiki/File:Dagupan_Cathedral,_Pangasinan,_Jun_2024.jpg',
    trust_level = 'open_data',
    updated_at = NOW()
WHERE id = 'spot-st-john-cathedral'
  AND slug = 'st-john-evangelist-cathedral-dagupan'
  AND status = 'published' AND is_test = FALSE
  AND image_url LIKE 'https://images.unsplash.com/%';
