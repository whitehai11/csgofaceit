CREATE TABLE IF NOT EXISTS weapons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('rifle', 'pistol', 'sniper', 'smg', 'heavy', 'knife', 'gloves', 'other')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  weapon_id UUID NOT NULL REFERENCES weapons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rarity TEXT NOT NULL CHECK (rarity IN ('consumer', 'industrial', 'mil-spec', 'restricted', 'classified', 'covert', 'extraordinary', 'contraband', 'other')),
  image_url TEXT,
  local_image_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (weapon_id, name)
);

CREATE TABLE IF NOT EXISTS maps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  image_url TEXT,
  radar_url TEXT,
  local_image_path TEXT,
  local_radar_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ranks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  icon_url TEXT,
  local_icon_path TEXT,
  tier INTEGER NOT NULL CHECK (tier > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_skins_weapon_id ON skins (weapon_id);
CREATE INDEX IF NOT EXISTS idx_skins_rarity ON skins (rarity);
CREATE INDEX IF NOT EXISTS idx_weapons_type ON weapons (type);
CREATE INDEX IF NOT EXISTS idx_ranks_tier ON ranks (tier);
