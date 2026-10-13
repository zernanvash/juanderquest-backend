-- 040_pangasinan_expanded_commons_photos.sql
-- Replace remaining stock photos with verified Wikimedia Commons open-data photos
-- for Antong Falls & Mountain Brook, Tondaligan Beach, and Tayug Sunflower Maze & Agri-Park.

UPDATE spots
SET image_url = '/api/v1/uploads/spot-photos/catalog-antong-falls.jpg',
    source_type = 'open_data',
    source_name = 'Photo: johrabino · CC BY-SA 4.0',
    source_url = 'https://commons.wikimedia.org/wiki/File:ANTONG_FALLS_1.jpg',
    trust_level = 'open_data',
    updated_at = NOW()
WHERE id = 'spot-antong-falls'
  AND slug = 'antong-falls-sison'
  AND status = 'published' AND is_test = FALSE
  AND image_url LIKE 'https://images.unsplash.com/%';

UPDATE spots
SET image_url = '/api/v1/uploads/spot-photos/catalog-tondaligan-beach.jpg',
    source_type = 'open_data',
    source_name = 'Photo: Jdcedit · CC BY-SA 4.0',
    source_url = 'https://commons.wikimedia.org/wiki/File:By_Jdcedit_-_Tondaligan_Beach_Sunset.jpg',
    trust_level = 'open_data',
    updated_at = NOW()
WHERE id = 'spot-tondaligan-beach'
  AND slug = 'tondaligan-beach'
  AND status = 'published' AND is_test = FALSE
  AND image_url LIKE 'https://images.unsplash.com/%';

UPDATE spots
SET image_url = '/api/v1/uploads/spot-photos/catalog-tayug-sunflower-maze.jpg',
    source_type = 'open_data',
    source_name = 'Photo: JorielleY · CC0',
    source_url = 'https://commons.wikimedia.org/wiki/File:Tayug_Sunflower_Eco_Park_In_Pangasinan_1.jpg',
    trust_level = 'open_data',
    updated_at = NOW()
WHERE id = 'spot-tayug-sunflower-maze'
  AND slug = 'tayug-sunflower-maze-agri-park'
  AND status = 'published' AND is_test = FALSE
  AND image_url LIKE 'https://images.unsplash.com/%';
