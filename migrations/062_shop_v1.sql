-- Shop v1: cosmetic catalog, ownership, loadout, preview partner offers and teasers.
CREATE TABLE IF NOT EXISTS cosmetic_items (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{3,60}$'),
  kind TEXT NOT NULL CHECK (kind IN ('banner','frame','title','name_color')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  description TEXT NOT NULL DEFAULT '',
  rarity TEXT NOT NULL DEFAULT 'common' CHECK (rarity IN ('common','rare','epic','legendary')),
  price_points INT CHECK (price_points IS NULL OR price_points > 0),
  price_tjdq NUMERIC(20,0) CHECK (price_tjdq IS NULL OR price_tjdq > 0),
  unlock_achievement_id VARCHAR(100) REFERENCES achievement_definitions(id),
  asset JSONB NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  available_from TIMESTAMPTZ,
  available_until TIMESTAMPTZ,
  sort_order INT NOT NULL DEFAULT 0,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_cosmetics (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES cosmetic_items(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source IN ('purchase','achievement','grant')),
  points_spent INT NOT NULL DEFAULT 0 CHECK (points_spent >= 0),
  idempotency_key TEXT,
  ledger_group_id TEXT,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,item_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_cosmetics_idem ON user_cosmetics(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS user_cosmetic_loadout (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  banner_id TEXT REFERENCES cosmetic_items(id),
  frame_id TEXT REFERENCES cosmetic_items(id),
  title_id TEXT REFERENCES cosmetic_items(id),
  name_color_id TEXT REFERENCES cosmetic_items(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cosmetic_audit (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  item_id TEXT,
  target_user_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS availability TEXT NOT NULL DEFAULT 'live' CHECK (availability IN ('live','preview'));
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS partner_label TEXT;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS icon_key TEXT;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS shop_teasers (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  icon_key TEXT NOT NULL,
  eta_text TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO cosmetic_items(id,kind,name,rarity,price_points,price_tjdq,unlock_achievement_id,asset,sort_order) VALUES
('banner-lingayen-sunset','banner','Lingayen Sunset','common',150,NULL,NULL,'{"style":"gradient","colors":["#f4a261","#e76f51"],"angle":135,"pattern":"sun"}',10),
('banner-hundred-islands','banner','Hundred Islands','rare',400,NULL,NULL,'{"style":"gradient","colors":["#2a9d8f","#457b9d","#1d3557"],"angle":160,"pattern":"islands"}',20),
('banner-capiz-heritage','banner','Capiz Heritage','rare',400,NULL,NULL,'{"style":"gradient","colors":["#e9d8a6","#ca9b52"],"angle":120,"pattern":"capiz"}',30),
('banner-bamboo-grove','banner','Bamboo Grove','common',150,NULL,NULL,'{"style":"gradient","colors":["#95d5b2","#2d6a4f"],"angle":90,"pattern":"bamboo"}',40),
('banner-bangus-festival','banner','Bangus Festival','epic',900,90,NULL,'{"style":"gradient","colors":["#48cae4","#0077b6","#03045e"],"angle":150,"pattern":"waves"}',50),
('banner-golden-hour','banner','Golden Hour','legendary',NULL,150,NULL,'{"style":"gradient","colors":["#ffd166","#f77f00","#d62828"],"angle":135,"pattern":"sun"}',60),
('frame-bamboo','frame','Bamboo Ring','common',120,NULL,NULL,'{"style":"ring","colors":["#95d5b2","#2d6a4f"],"width":3,"animated":false}',10),
('frame-coral','frame','Coral Ring','rare',350,NULL,NULL,'{"style":"ring","colors":["#ff8fab","#fb6f92"],"width":4,"animated":false}',20),
('frame-sea-glass','frame','Sea Glass','rare',350,NULL,NULL,'{"style":"ring","colors":["#a8dadc","#457b9d"],"width":4,"animated":false}',30),
('frame-golden-sun','frame','Golden Sun','legendary',1500,120,NULL,'{"style":"ring","colors":["#ffd166","#f4a261"],"width":5,"animated":true}',40),
('frame-coastal-conqueror','frame','Coastal Conqueror','epic',NULL,NULL,'coastal_conqueror','{"style":"ring","colors":["#00b4d8","#0077b6"],"width":5,"animated":false}',50),
('frame-heritage-seeker','frame','Heritage Seeker','epic',NULL,NULL,'heritage_seeker','{"style":"ring","colors":["#b08968","#7f5539"],"width":5,"animated":false}',60),
('title-island-hopper','title','Island Hopper','common',100,NULL,NULL,'{"text":"Island Hopper"}',10),
('title-bangus-buff','title','Bangus Buff','common',100,NULL,NULL,'{"text":"Bangus Buff"}',20),
('title-pangasinan-pioneer','title','Pangasinan Pioneer','rare',NULL,NULL,'pangasinan_pioneer','{"text":"Pangasinan Pioneer"}',30),
('title-civic-voice','title','Civic Voice','rare',NULL,NULL,'civic_first_voice','{"text":"Civic Voice"}',40),
('color-mangrove','name_color','Mangrove Green','common',80,NULL,NULL,'{"color":"#2d6a4f"}',10),
('color-sunset','name_color','Sunset Orange','rare',250,NULL,NULL,'{"color":"#c2410c"}',20),
('color-deep-sea','name_color','Deep Sea Blue','rare',250,NULL,NULL,'{"color":"#1d4ed8"}',30),
('color-ube','name_color','Ube Purple','epic',500,NULL,NULL,'{"color":"#7e22ce"}',40)
ON CONFLICT(id) DO NOTHING;

UPDATE vouchers SET availability='preview', partner_label='Partner grill · Dagupan', icon_key='meal', sort_order=10 WHERE id='v1';
UPDATE vouchers SET availability='preview', partner_label='Partner café · Bolinao', icon_key='coffee', sort_order=20 WHERE id='v2';
UPDATE vouchers SET availability='preview', partner_label='Souvenir shop · Alaminos', icon_key='souvenir', sort_order=30 WHERE id='v3';
INSERT INTO merchants(id,name,location,description) VALUES
('sample-partner-boat','Boat operator · Alaminos','Alaminos','Sample partner placeholder.'),
('sample-partner-pasalubong','Pasalubong store · Manaoag','Manaoag','Sample partner placeholder.'),
('sample-partner-etrike','E-trike partner · Lingayen','Lingayen','Sample partner placeholder.'),
('sample-partner-museum','Heritage site · Lingayen','Lingayen','Sample partner placeholder.'),
('sample-partner-beach-stay','Beach resort · San Fabian','San Fabian','Sample partner placeholder.')
ON CONFLICT(id) DO NOTHING;
INSERT INTO vouchers(id,merchant_id,title,description,cost_points,is_active,availability,partner_label,icon_key,sort_order) VALUES
('pv-boat-tour','sample-partner-boat','10% off a Hundred Islands island-hopping tour','Sample offer; partner coming soon.',300,TRUE,'preview','Boat operator · Alaminos','boat',40),
('pv-pasalubong','sample-partner-pasalubong','₱30 off pasalubong (₱200+)','Sample offer; partner coming soon.',90,TRUE,'preview','Pasalubong store · Manaoag','sweets',50),
('pv-etrike','sample-partner-etrike','One free short-hop e-trike ride','Sample offer; partner coming soon.',70,TRUE,'preview','E-trike partner · Lingayen','ride',60),
('pv-museum','sample-partner-museum','Free guided tour add-on','Sample offer; partner coming soon.',120,TRUE,'preview','Heritage site · Lingayen','ticket',70),
('pv-beach-stay','sample-partner-beach-stay','10% off a weekday cottage','Sample offer; partner coming soon.',400,TRUE,'preview','Beach resort · San Fabian','stay',80)
ON CONFLICT(id) DO NOTHING;
INSERT INTO shop_teasers(id,title,description,icon_key,eta_text,sort_order) VALUES
('teaser-vip-trails','VIP trails','Unlock premium curated trails with tJDQ.','trail','Coming soon',10),
('teaser-event-pass','Event passes','Reserved spots at festivals and community events.','ticket','Coming soon',20),
('teaser-tjdq-items','tJDQ exclusives','Legendary cosmetics you can only get with tJDQ.','sparkles','After the beta',30),
('teaser-experiences','Local experiences','Meet artisans, behind-the-scenes tours.','users','Coming soon',40)
ON CONFLICT(id) DO NOTHING;
