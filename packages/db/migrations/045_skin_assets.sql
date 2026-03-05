CREATE TABLE IF NOT EXISTS skin_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  weapon TEXT NOT NULL,
  skin_name TEXT NOT NULL,
  rarity TEXT NOT NULL,
  image_url TEXT,
  model_path TEXT,
  local_path TEXT,
  steam_cdn_url TEXT,
  csgostash_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (weapon, skin_name)
);

CREATE INDEX IF NOT EXISTS idx_skin_assets_weapon ON skin_assets (weapon);
CREATE INDEX IF NOT EXISTS idx_skin_assets_rarity ON skin_assets (rarity);

INSERT INTO skin_assets (weapon, skin_name, rarity, image_url)
SELECT ws.weapon_name, ws.skin_name, ws.rarity, ws.image_url
FROM weapon_skins ws
ON CONFLICT (weapon, skin_name) DO NOTHING;
