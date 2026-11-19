-- Migration 111 (Plan 116 §8.4): licensed, attributed destination photos at national scale.
-- Additive. Third-party catalog photos (Commons, Openverse, Flickr, Mapillary) carry their
-- licence, author and file page, and have no uploading user. Uploads keep user_id.

ALTER TABLE spot_assets ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE spot_assets DROP CONSTRAINT IF EXISTS chk_spot_assets_source;
ALTER TABLE spot_assets ADD CONSTRAINT chk_spot_assets_source CHECK (source IS NULL OR source IN
  ('commons', 'openverse', 'flickr', 'mapillary', 'lgu_permission', 'traveller', 'merchant', 'editorial'));
ALTER TABLE spot_assets ADD COLUMN IF NOT EXISTS source_id TEXT;          -- Commons file title, Flickr photo id, …
ALTER TABLE spot_assets ADD COLUMN IF NOT EXISTS license TEXT;            -- normalised: 'CC0','PD','PDM','CC BY 4.0','CC BY-SA 2.0'
ALTER TABLE spot_assets ADD COLUMN IF NOT EXISTS license_url TEXT;
ALTER TABLE spot_assets ADD COLUMN IF NOT EXISTS author TEXT;
ALTER TABLE spot_assets ADD COLUMN IF NOT EXISTS attribution_url TEXT;    -- the photo's own page
ALTER TABLE spot_assets ADD COLUMN IF NOT EXISTS blurhash TEXT;
ALTER TABLE spot_assets ADD COLUMN IF NOT EXISTS dominant_color TEXT;
ALTER TABLE spot_assets ADD COLUMN IF NOT EXISTS phash BIGINT;            -- 64-bit perceptual hash (dedupe)
ALTER TABLE spot_assets ADD COLUMN IF NOT EXISTS quality_score REAL;
ALTER TABLE spot_assets ADD COLUMN IF NOT EXISTS variants JSONB NOT NULL DEFAULT '{}'::jsonb; -- {"w320":url,"w640":url,"w1280":url}
ALTER TABLE spot_assets ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE spot_assets ADD COLUMN IF NOT EXISTS sort_order SMALLINT NOT NULL DEFAULT 0;

-- Catalog photos have no uploader; every other source still needs one.
ALTER TABLE spot_assets ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE spot_assets DROP CONSTRAINT IF EXISTS chk_spot_assets_uploader;
ALTER TABLE spot_assets ADD CONSTRAINT chk_spot_assets_uploader CHECK (
  user_id IS NOT NULL OR source IN ('commons', 'openverse', 'flickr', 'mapillary', 'lgu_permission', 'editorial'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_spot_assets_source ON spot_assets (source, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_spot_assets_primary ON spot_assets (spot_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS idx_spot_assets_spot_order ON spot_assets (spot_id, sort_order);

-- PGMEM_SKIP_BEGIN
-- Scraped third-party photos must carry a commercial-use licence (no NC/ND) plus credit.
ALTER TABLE spot_assets DROP CONSTRAINT IF EXISTS chk_spot_assets_third_party_license;
ALTER TABLE spot_assets ADD CONSTRAINT chk_spot_assets_third_party_license CHECK (
  source IS NULL OR source NOT IN ('commons', 'openverse', 'flickr', 'mapillary')
  OR ((license IN ('CC0', 'PD', 'PDM') OR license ~ '^CC BY(-SA)? [0-9]\.[0-9]$')
      AND author IS NOT NULL AND btrim(author) <> '' AND attribution_url IS NOT NULL));
-- PGMEM_SKIP_END
