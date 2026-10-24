-- The marker artwork host was never populated. Allow a missing optional image
-- and clear only the dead URLs seeded by the original demo catalog.
ALTER TABLE quests ALTER COLUMN marker_image_url DROP NOT NULL;

UPDATE quests
SET marker_image_url = NULL
WHERE marker_image_url LIKE 'https://raw.githubusercontent.com/JuanderQuest/assets/%';
