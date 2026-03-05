ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS creator_match BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS creator_player_id UUID REFERENCES players(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS creator_stream_url TEXT;

CREATE TABLE IF NOT EXISTS creator_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id TEXT NOT NULL,
  discord_id TEXT,
  reward_type TEXT NOT NULL,
  date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  match_id UUID REFERENCES matches(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_creator_matches_steam_date
  ON creator_matches (steam_id, date DESC);

CREATE TABLE IF NOT EXISTS viewer_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id TEXT NOT NULL,
  discord_id TEXT,
  reward_type TEXT NOT NULL,
  date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  match_id UUID REFERENCES matches(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_viewer_rewards_steam_date
  ON viewer_rewards (steam_id, date DESC);

CREATE TABLE IF NOT EXISTS creator_boxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id TEXT NOT NULL,
  discord_id TEXT,
  reward_type TEXT NOT NULL,
  date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  match_id UUID REFERENCES matches(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_creator_boxes_steam_date
  ON creator_boxes (steam_id, date DESC);

ALTER TABLE box_rewards
  ADD COLUMN IF NOT EXISTS source_box_type TEXT NOT NULL DEFAULT 'fragbox';

CREATE INDEX IF NOT EXISTS idx_box_rewards_source_type
  ON box_rewards (source_box_type, rarity);

INSERT INTO box_rewards (reward_type, skin_name, rarity, image_url, source_box_type)
VALUES
  ('weapon_skin', 'AK47 Vulcan', 'common', 'https://images.fraghub.gg/creatorbox/ak47_vulcan.png', 'creatorbox'),
  ('weapon_skin', 'M4A1-S Printstream', 'common', 'https://images.fraghub.gg/creatorbox/m4a1s_printstream.png', 'creatorbox'),
  ('xp_boost', 'Creator XP Boost 50%', 'common', 'https://images.fraghub.gg/creatorbox/xp_boost_50.png', 'creatorbox'),

  ('weapon_skin', 'AK47 Fire Serpent', 'rare', 'https://images.fraghub.gg/creatorbox/ak47_fire_serpent.png', 'creatorbox'),
  ('weapon_skin', 'AWP Dragon Lore', 'rare', 'https://images.fraghub.gg/creatorbox/awp_dragon_lore.png', 'creatorbox'),
  ('profile_badge', 'Badge: Creator Fan', 'rare', 'https://images.fraghub.gg/creatorbox/badge_creator_fan.png', 'creatorbox'),

  ('weapon_skin', 'M4A4 Howl', 'epic', 'https://images.fraghub.gg/creatorbox/m4a4_howl.png', 'creatorbox'),
  ('special_title', 'Title: Front Row Viewer', 'epic', 'https://images.fraghub.gg/creatorbox/title_front_row_viewer.png', 'creatorbox'),
  ('glove_skin', 'Specialist Gloves Fade', 'epic', 'https://images.fraghub.gg/creatorbox/specialist_fade.png', 'creatorbox'),

  ('knife_skin', 'Karambit Fade', 'legendary', 'https://images.fraghub.gg/creatorbox/karambit_fade.png', 'creatorbox'),
  ('knife_skin', 'Butterfly Knife Doppler', 'legendary', 'https://images.fraghub.gg/creatorbox/butterfly_doppler.png', 'creatorbox'),
  ('glove_skin', 'Sport Gloves Pandora''s Box', 'legendary', 'https://images.fraghub.gg/creatorbox/sport_pandoras_box.png', 'creatorbox'),

  ('special_title', 'Title: Creator Inner Circle', 'mythic', 'https://images.fraghub.gg/creatorbox/title_creator_inner_circle.png', 'creatorbox'),
  ('glove_skin', 'Driver Gloves Crimson Kimono', 'mythic', 'https://images.fraghub.gg/creatorbox/driver_crimson_kimono.png', 'creatorbox')
ON CONFLICT DO NOTHING;
