-- 041_clear_unverified_stock_images.sql
-- Clear placeholder stock images from spots where verified real photo data has not yet been acquired.
-- Preserves all posts, coordinates, metadata, and verified real upload images (/api/v1/uploads/spot-photos/*).

UPDATE spots
SET image_url = '',
    updated_at = NOW()
WHERE image_url LIKE 'https://images.unsplash.com/%';
