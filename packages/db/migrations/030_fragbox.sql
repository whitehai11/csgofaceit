CREATE TABLE IF NOT EXISTS player_boxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id TEXT NOT NULL,
  box_type TEXT NOT NULL DEFAULT 'fragbox',
  date_received TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened BOOLEAN NOT NULL DEFAULT FALSE,
  opened_at TIMESTAMPTZ,
  reward_id UUID,
  UNIQUE (id)
);

CREATE INDEX IF NOT EXISTS idx_player_boxes_steam_opened ON player_boxes (steam_id, opened, date_received DESC);

CREATE TABLE IF NOT EXISTS box_rewards (
  reward_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reward_type TEXT NOT NULL CHECK (reward_type IN ('weapon_skin', 'knife_skin', 'glove_skin', 'xp_boost', 'profile_badge', 'special_title')),
  skin_name TEXT NOT NULL,
  rarity TEXT NOT NULL CHECK (rarity IN ('common', 'rare', 'epic', 'legendary', 'mythic')),
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_box_rewards_rarity ON box_rewards (rarity);

CREATE TABLE IF NOT EXISTS player_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id TEXT NOT NULL,
  item_id UUID NOT NULL REFERENCES box_rewards(reward_id) ON DELETE RESTRICT,
  rarity TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_player_inventory_steam ON player_inventory (steam_id, created_at DESC);

INSERT INTO box_rewards (reward_type, skin_name, rarity, image_url)
VALUES
  ('weapon_skin', 'AK47 Redline', 'common', 'https://images.fraghub.gg/fragbox/ak47_redline.png'),
  ('weapon_skin', 'MP9 Hydra', 'common', 'https://images.fraghub.gg/fragbox/mp9_hydra.png'),
  ('weapon_skin', 'FAMAS Rapid Eye Movement', 'common', 'https://images.fraghub.gg/fragbox/famas_rem.png'),
  ('xp_boost', 'XP Boost 25%', 'common', 'https://images.fraghub.gg/fragbox/xp_boost_25.png'),
  ('special_title', 'Title: Queue Grinder', 'common', 'https://images.fraghub.gg/fragbox/title_queue_grinder.png'),

  ('weapon_skin', 'AK47 Vulcan', 'rare', 'https://images.fraghub.gg/fragbox/ak47_vulcan.png'),
  ('weapon_skin', 'M4A1-S Printstream', 'rare', 'https://images.fraghub.gg/fragbox/m4a1s_printstream.png'),
  ('weapon_skin', 'AWP Asiimov', 'rare', 'https://images.fraghub.gg/fragbox/awp_asiimov.png'),
  ('profile_badge', 'Badge: Frag Hunter', 'rare', 'https://images.fraghub.gg/fragbox/badge_frag_hunter.png'),
  ('xp_boost', 'XP Boost 50%', 'rare', 'https://images.fraghub.gg/fragbox/xp_boost_50.png'),

  ('weapon_skin', 'AK47 Fire Serpent', 'epic', 'https://images.fraghub.gg/fragbox/ak47_fire_serpent.png'),
  ('weapon_skin', 'M4A4 Howl', 'epic', 'https://images.fraghub.gg/fragbox/m4a4_howl.png'),
  ('weapon_skin', 'AWP Dragon Lore', 'epic', 'https://images.fraghub.gg/fragbox/awp_dragon_lore.png'),
  ('special_title', 'Title: Clutch Master', 'epic', 'https://images.fraghub.gg/fragbox/title_clutch_master.png'),
  ('profile_badge', 'Badge: FragBox Veteran', 'epic', 'https://images.fraghub.gg/fragbox/badge_fragbox_veteran.png'),

  ('knife_skin', 'Karambit Fade', 'legendary', 'https://images.fraghub.gg/fragbox/karambit_fade.png'),
  ('knife_skin', 'Butterfly Knife Doppler', 'legendary', 'https://images.fraghub.gg/fragbox/butterfly_doppler.png'),
  ('glove_skin', 'Sport Gloves Pandora''s Box', 'legendary', 'https://images.fraghub.gg/fragbox/sport_pandoras_box.png'),
  ('glove_skin', 'Driver Gloves Crimson Kimono', 'legendary', 'https://images.fraghub.gg/fragbox/driver_crimson_kimono.png'),
  ('glove_skin', 'Specialist Gloves Fade', 'legendary', 'https://images.fraghub.gg/fragbox/specialist_fade.png'),

  ('knife_skin', 'Skeleton Knife Gamma Doppler', 'mythic', 'https://images.fraghub.gg/fragbox/skeleton_gamma_doppler.png'),
  ('glove_skin', 'Sport Gloves Vice', 'mythic', 'https://images.fraghub.gg/fragbox/sport_vice.png'),
  ('special_title', 'Title: FragBox Immortal', 'mythic', 'https://images.fraghub.gg/fragbox/title_fragbox_immortal.png')
ON CONFLICT DO NOTHING;
