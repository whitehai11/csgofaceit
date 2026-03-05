CREATE TABLE IF NOT EXISTS weapon_skins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  weapon_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('primary', 'pistol', 'knife', 'gloves')),
  skin_name TEXT NOT NULL,
  skin_id TEXT NOT NULL,
  rarity TEXT NOT NULL CHECK (rarity IN ('consumer', 'industrial', 'mil-spec', 'restricted', 'classified', 'covert', 'legendary')),
  image_url TEXT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (weapon_name, skin_id)
);

CREATE INDEX IF NOT EXISTS idx_weapon_skins_weapon ON weapon_skins (weapon_name);
CREATE INDEX IF NOT EXISTS idx_weapon_skins_category ON weapon_skins (category);

INSERT INTO weapon_skins (weapon_name, category, skin_name, skin_id, rarity, image_url, is_default) VALUES
  ('ak47', 'primary', 'Fire Serpent', 'fire_serpent', 'covert', 'https://images.fraghub.gg/skins/ak47/fire_serpent.png', TRUE),
  ('ak47', 'primary', 'Vulcan', 'vulcan', 'classified', 'https://images.fraghub.gg/skins/ak47/vulcan.png', FALSE),
  ('ak47', 'primary', 'Bloodsport', 'bloodsport', 'covert', 'https://images.fraghub.gg/skins/ak47/bloodsport.png', FALSE),
  ('ak47', 'primary', 'Case Hardened', 'case_hardened', 'classified', 'https://images.fraghub.gg/skins/ak47/case_hardened.png', FALSE),
  ('ak47', 'primary', 'Redline', 'redline', 'classified', 'https://images.fraghub.gg/skins/ak47/redline.png', FALSE),

  ('awp', 'primary', 'Dragon Lore', 'dragon_lore', 'legendary', 'https://images.fraghub.gg/skins/awp/dragon_lore.png', TRUE),
  ('awp', 'primary', 'Asiimov', 'asiimov', 'covert', 'https://images.fraghub.gg/skins/awp/asiimov.png', FALSE),
  ('awp', 'primary', 'Hyper Beast', 'hyper_beast', 'covert', 'https://images.fraghub.gg/skins/awp/hyper_beast.png', FALSE),
  ('awp', 'primary', 'Containment Breach', 'containment_breach', 'covert', 'https://images.fraghub.gg/skins/awp/containment_breach.png', FALSE),
  ('awp', 'primary', 'Lightning Strike', 'lightning_strike', 'classified', 'https://images.fraghub.gg/skins/awp/lightning_strike.png', FALSE),

  ('m4a4', 'primary', 'Howl', 'howl', 'legendary', 'https://images.fraghub.gg/skins/m4a4/howl.png', TRUE),
  ('m4a4', 'primary', 'Desolate Space', 'desolate_space', 'classified', 'https://images.fraghub.gg/skins/m4a4/desolate_space.png', FALSE),
  ('m4a4', 'primary', 'Neo Noir', 'neo_noir', 'covert', 'https://images.fraghub.gg/skins/m4a4/neo_noir.png', FALSE),
  ('m4a4', 'primary', 'The Emperor', 'the_emperor', 'covert', 'https://images.fraghub.gg/skins/m4a4/the_emperor.png', FALSE),
  ('m4a4', 'primary', 'Temukau', 'temukau', 'covert', 'https://images.fraghub.gg/skins/m4a4/temukau.png', FALSE),

  ('m4a1-s', 'primary', 'Printstream', 'printstream', 'covert', 'https://images.fraghub.gg/skins/m4a1s/printstream.png', TRUE),
  ('m4a1-s', 'primary', 'Golden Coil', 'golden_coil', 'covert', 'https://images.fraghub.gg/skins/m4a1s/golden_coil.png', FALSE),
  ('m4a1-s', 'primary', 'Hyper Beast', 'hyper_beast', 'covert', 'https://images.fraghub.gg/skins/m4a1s/hyper_beast.png', FALSE),
  ('m4a1-s', 'primary', 'Mecha Industries', 'mecha_industries', 'covert', 'https://images.fraghub.gg/skins/m4a1s/mecha_industries.png', FALSE),
  ('m4a1-s', 'primary', 'Nightmare', 'nightmare', 'classified', 'https://images.fraghub.gg/skins/m4a1s/nightmare.png', FALSE),

  ('mp9', 'primary', 'Hydra', 'hydra', 'restricted', 'https://images.fraghub.gg/skins/mp9/hydra.png', TRUE),
  ('mp9', 'primary', 'Starlight Protector', 'starlight_protector', 'classified', 'https://images.fraghub.gg/skins/mp9/starlight_protector.png', FALSE),
  ('mp9', 'primary', 'Food Chain', 'food_chain', 'restricted', 'https://images.fraghub.gg/skins/mp9/food_chain.png', FALSE),
  ('mp9', 'primary', 'Ruby Poison Dart', 'ruby_poison_dart', 'restricted', 'https://images.fraghub.gg/skins/mp9/ruby_poison_dart.png', FALSE),
  ('mp9', 'primary', 'Mount Fuji', 'mount_fuji', 'mil-spec', 'https://images.fraghub.gg/skins/mp9/mount_fuji.png', FALSE),

  ('ump45', 'primary', 'Primal Saber', 'primal_saber', 'classified', 'https://images.fraghub.gg/skins/ump45/primal_saber.png', TRUE),
  ('ump45', 'primary', 'Momentum', 'momentum', 'restricted', 'https://images.fraghub.gg/skins/ump45/momentum.png', FALSE),
  ('ump45', 'primary', 'Moonrise', 'moonrise', 'restricted', 'https://images.fraghub.gg/skins/ump45/moonrise.png', FALSE),
  ('ump45', 'primary', 'Wild Child', 'wild_child', 'classified', 'https://images.fraghub.gg/skins/ump45/wild_child.png', FALSE),
  ('ump45', 'primary', 'Neo-Noir', 'neo_noir', 'classified', 'https://images.fraghub.gg/skins/ump45/neo_noir.png', FALSE),

  ('famas', 'primary', 'Commemoration', 'commemoration', 'classified', 'https://images.fraghub.gg/skins/famas/commemoration.png', TRUE),
  ('famas', 'primary', 'Roll Cage', 'roll_cage', 'classified', 'https://images.fraghub.gg/skins/famas/roll_cage.png', FALSE),
  ('famas', 'primary', 'Eye of Athena', 'eye_of_athena', 'restricted', 'https://images.fraghub.gg/skins/famas/eye_of_athena.png', FALSE),
  ('famas', 'primary', 'Mecha Industries', 'mecha_industries', 'classified', 'https://images.fraghub.gg/skins/famas/mecha_industries.png', FALSE),
  ('famas', 'primary', 'Rapid Eye Movement', 'rapid_eye_movement', 'mil-spec', 'https://images.fraghub.gg/skins/famas/rapid_eye_movement.png', FALSE),

  ('galil', 'primary', 'Chatterbox', 'chatterbox', 'covert', 'https://images.fraghub.gg/skins/galil/chatterbox.png', TRUE),
  ('galil', 'primary', 'Eco', 'eco', 'classified', 'https://images.fraghub.gg/skins/galil/eco.png', FALSE),
  ('galil', 'primary', 'Sugar Rush', 'sugar_rush', 'restricted', 'https://images.fraghub.gg/skins/galil/sugar_rush.png', FALSE),
  ('galil', 'primary', 'Phoenix Blacklight', 'phoenix_blacklight', 'classified', 'https://images.fraghub.gg/skins/galil/phoenix_blacklight.png', FALSE),
  ('galil', 'primary', 'Cerberus', 'cerberus', 'restricted', 'https://images.fraghub.gg/skins/galil/cerberus.png', FALSE),

  ('p90', 'primary', 'Asiimov', 'asiimov', 'covert', 'https://images.fraghub.gg/skins/p90/asiimov.png', TRUE),
  ('p90', 'primary', 'Death by Kitty', 'death_by_kitty', 'classified', 'https://images.fraghub.gg/skins/p90/death_by_kitty.png', FALSE),
  ('p90', 'primary', 'Emerald Dragon', 'emerald_dragon', 'classified', 'https://images.fraghub.gg/skins/p90/emerald_dragon.png', FALSE),
  ('p90', 'primary', 'Nostalgia', 'nostalgia', 'restricted', 'https://images.fraghub.gg/skins/p90/nostalgia.png', FALSE),
  ('p90', 'primary', 'Shallow Grave', 'shallow_grave', 'restricted', 'https://images.fraghub.gg/skins/p90/shallow_grave.png', FALSE),

  ('mac10', 'primary', 'Neon Rider', 'neon_rider', 'covert', 'https://images.fraghub.gg/skins/mac10/neon_rider.png', TRUE),
  ('mac10', 'primary', 'Stalker', 'stalker', 'classified', 'https://images.fraghub.gg/skins/mac10/stalker.png', FALSE),
  ('mac10', 'primary', 'Case Hardened', 'case_hardened', 'restricted', 'https://images.fraghub.gg/skins/mac10/case_hardened.png', FALSE),
  ('mac10', 'primary', 'Allure', 'allure', 'mil-spec', 'https://images.fraghub.gg/skins/mac10/allure.png', FALSE),
  ('mac10', 'primary', 'Disco Tech', 'disco_tech', 'restricted', 'https://images.fraghub.gg/skins/mac10/disco_tech.png', FALSE),

  ('nova', 'primary', 'Hyper Beast', 'hyper_beast', 'classified', 'https://images.fraghub.gg/skins/nova/hyper_beast.png', TRUE),
  ('nova', 'primary', 'Antique', 'antique', 'restricted', 'https://images.fraghub.gg/skins/nova/antique.png', FALSE),
  ('nova', 'primary', 'Tempest', 'tempest', 'mil-spec', 'https://images.fraghub.gg/skins/nova/tempest.png', FALSE),
  ('nova', 'primary', 'Bloomstick', 'bloomstick', 'restricted', 'https://images.fraghub.gg/skins/nova/bloomstick.png', FALSE),
  ('nova', 'primary', 'Toy Soldier', 'toy_soldier', 'restricted', 'https://images.fraghub.gg/skins/nova/toy_soldier.png', FALSE),

  ('xm1014', 'primary', 'XOXO', 'xoxo', 'classified', 'https://images.fraghub.gg/skins/xm1014/xoxo.png', TRUE),
  ('xm1014', 'primary', 'Tranquility', 'tranquility', 'restricted', 'https://images.fraghub.gg/skins/xm1014/tranquility.png', FALSE),
  ('xm1014', 'primary', 'Entombed', 'entombed', 'classified', 'https://images.fraghub.gg/skins/xm1014/entombed.png', FALSE),
  ('xm1014', 'primary', 'Incinegator', 'incinegator', 'restricted', 'https://images.fraghub.gg/skins/xm1014/incinegator.png', FALSE),
  ('xm1014', 'primary', 'Seasons', 'seasons', 'mil-spec', 'https://images.fraghub.gg/skins/xm1014/seasons.png', FALSE),

  ('mag7', 'primary', 'BI83 Spectrum', 'bi83_spectrum', 'restricted', 'https://images.fraghub.gg/skins/mag7/bi83_spectrum.png', TRUE),
  ('mag7', 'primary', 'Praetorian', 'praetorian', 'restricted', 'https://images.fraghub.gg/skins/mag7/praetorian.png', FALSE),
  ('mag7', 'primary', 'Justice', 'justice', 'classified', 'https://images.fraghub.gg/skins/mag7/justice.png', FALSE),
  ('mag7', 'primary', 'Bulldozer', 'bulldozer', 'classified', 'https://images.fraghub.gg/skins/mag7/bulldozer.png', FALSE),
  ('mag7', 'primary', 'Cinquedea', 'cinquedea', 'covert', 'https://images.fraghub.gg/skins/mag7/cinquedea.png', FALSE),

  ('negev', 'primary', 'Power Loader', 'power_loader', 'restricted', 'https://images.fraghub.gg/skins/negev/power_loader.png', TRUE),
  ('negev', 'primary', 'Mjonir', 'mjonir', 'covert', 'https://images.fraghub.gg/skins/negev/mjonir.png', FALSE),
  ('negev', 'primary', 'Loudmouth', 'loudmouth', 'restricted', 'https://images.fraghub.gg/skins/negev/loudmouth.png', FALSE),
  ('negev', 'primary', 'Bratatat', 'bratatat', 'restricted', 'https://images.fraghub.gg/skins/negev/bratatat.png', FALSE),
  ('negev', 'primary', 'Ultralight', 'ultralight', 'mil-spec', 'https://images.fraghub.gg/skins/negev/ultralight.png', FALSE),

  ('sg553', 'primary', 'Integrale', 'integrale', 'classified', 'https://images.fraghub.gg/skins/sg553/integrale.png', TRUE),
  ('sg553', 'primary', 'Cyrex', 'cyrex', 'classified', 'https://images.fraghub.gg/skins/sg553/cyrex.png', FALSE),
  ('sg553', 'primary', 'Hypnotic', 'hypnotic', 'restricted', 'https://images.fraghub.gg/skins/sg553/hypnotic.png', FALSE),
  ('sg553', 'primary', 'Tiger Moth', 'tiger_moth', 'restricted', 'https://images.fraghub.gg/skins/sg553/tiger_moth.png', FALSE),
  ('sg553', 'primary', 'Pulse', 'pulse', 'mil-spec', 'https://images.fraghub.gg/skins/sg553/pulse.png', FALSE),

  ('aug', 'primary', 'Akihabara Accept', 'akihabara_accept', 'covert', 'https://images.fraghub.gg/skins/aug/akihabara_accept.png', TRUE),
  ('aug', 'primary', 'Chameleon', 'chameleon', 'classified', 'https://images.fraghub.gg/skins/aug/chameleon.png', FALSE),
  ('aug', 'primary', 'Syd Mead', 'syd_mead', 'restricted', 'https://images.fraghub.gg/skins/aug/syd_mead.png', FALSE),
  ('aug', 'primary', 'Bengal Tiger', 'bengal_tiger', 'restricted', 'https://images.fraghub.gg/skins/aug/bengal_tiger.png', FALSE),
  ('aug', 'primary', 'Aristocrat', 'aristocrat', 'mil-spec', 'https://images.fraghub.gg/skins/aug/aristocrat.png', FALSE),

  ('usp-s', 'pistol', 'Kill Confirmed', 'kill_confirmed', 'covert', 'https://images.fraghub.gg/skins/usp-s/kill_confirmed.png', TRUE),
  ('usp-s', 'pistol', 'Neo Noir', 'neo_noir', 'covert', 'https://images.fraghub.gg/skins/usp-s/neo_noir.png', FALSE),
  ('usp-s', 'pistol', 'Printstream', 'printstream', 'covert', 'https://images.fraghub.gg/skins/usp-s/printstream.png', FALSE),
  ('usp-s', 'pistol', 'The Traitor', 'the_traitor', 'covert', 'https://images.fraghub.gg/skins/usp-s/the_traitor.png', FALSE),
  ('usp-s', 'pistol', 'Cortex', 'cortex', 'classified', 'https://images.fraghub.gg/skins/usp-s/cortex.png', FALSE),

  ('glock', 'pistol', 'Fade', 'fade', 'legendary', 'https://images.fraghub.gg/skins/glock/fade.png', TRUE),
  ('glock', 'pistol', 'Water Elemental', 'water_elemental', 'classified', 'https://images.fraghub.gg/skins/glock/water_elemental.png', FALSE),
  ('glock', 'pistol', 'Neo Noir', 'neo_noir', 'covert', 'https://images.fraghub.gg/skins/glock/neo_noir.png', FALSE),
  ('glock', 'pistol', 'Gamma Doppler', 'gamma_doppler', 'legendary', 'https://images.fraghub.gg/skins/glock/gamma_doppler.png', FALSE),
  ('glock', 'pistol', 'Vogue', 'vogue', 'classified', 'https://images.fraghub.gg/skins/glock/vogue.png', FALSE),

  ('deagle', 'pistol', 'Blaze', 'blaze', 'covert', 'https://images.fraghub.gg/skins/deagle/blaze.png', TRUE),
  ('deagle', 'pistol', 'Printstream', 'printstream', 'covert', 'https://images.fraghub.gg/skins/deagle/printstream.png', FALSE),
  ('deagle', 'pistol', 'Conspiracy', 'conspiracy', 'classified', 'https://images.fraghub.gg/skins/deagle/conspiracy.png', FALSE),
  ('deagle', 'pistol', 'Code Red', 'code_red', 'covert', 'https://images.fraghub.gg/skins/deagle/code_red.png', FALSE),
  ('deagle', 'pistol', 'Kumicho Dragon', 'kumicho_dragon', 'classified', 'https://images.fraghub.gg/skins/deagle/kumicho_dragon.png', FALSE),

  ('knife_karambit', 'knife', 'Fade', 'fade', 'legendary', 'https://images.fraghub.gg/skins/knife/karambit_fade.png', TRUE),
  ('knife_karambit', 'knife', 'Doppler', 'doppler', 'legendary', 'https://images.fraghub.gg/skins/knife/karambit_doppler.png', FALSE),
  ('knife_karambit', 'knife', 'Marble Fade', 'marble_fade', 'legendary', 'https://images.fraghub.gg/skins/knife/karambit_marble_fade.png', FALSE),
  ('knife_karambit', 'knife', 'Tiger Tooth', 'tiger_tooth', 'legendary', 'https://images.fraghub.gg/skins/knife/karambit_tiger_tooth.png', FALSE),
  ('knife_karambit', 'knife', 'Slaughter', 'slaughter', 'legendary', 'https://images.fraghub.gg/skins/knife/karambit_slaughter.png', FALSE),

  ('knife_butterfly', 'knife', 'Fade', 'fade', 'legendary', 'https://images.fraghub.gg/skins/knife/butterfly_fade.png', TRUE),
  ('knife_butterfly', 'knife', 'Doppler', 'doppler', 'legendary', 'https://images.fraghub.gg/skins/knife/butterfly_doppler.png', FALSE),
  ('knife_butterfly', 'knife', 'Marble Fade', 'marble_fade', 'legendary', 'https://images.fraghub.gg/skins/knife/butterfly_marble_fade.png', FALSE),
  ('knife_butterfly', 'knife', 'Tiger Tooth', 'tiger_tooth', 'legendary', 'https://images.fraghub.gg/skins/knife/butterfly_tiger_tooth.png', FALSE),
  ('knife_butterfly', 'knife', 'Gamma Doppler', 'gamma_doppler', 'legendary', 'https://images.fraghub.gg/skins/knife/butterfly_gamma_doppler.png', FALSE),

  ('knife_m9_bayonet', 'knife', 'Fade', 'fade', 'legendary', 'https://images.fraghub.gg/skins/knife/m9_fade.png', TRUE),
  ('knife_m9_bayonet', 'knife', 'Doppler', 'doppler', 'legendary', 'https://images.fraghub.gg/skins/knife/m9_doppler.png', FALSE),
  ('knife_m9_bayonet', 'knife', 'Marble Fade', 'marble_fade', 'legendary', 'https://images.fraghub.gg/skins/knife/m9_marble_fade.png', FALSE),
  ('knife_m9_bayonet', 'knife', 'Tiger Tooth', 'tiger_tooth', 'legendary', 'https://images.fraghub.gg/skins/knife/m9_tiger_tooth.png', FALSE),
  ('knife_m9_bayonet', 'knife', 'Slaughter', 'slaughter', 'legendary', 'https://images.fraghub.gg/skins/knife/m9_slaughter.png', FALSE),

  ('knife_bayonet', 'knife', 'Fade', 'fade', 'legendary', 'https://images.fraghub.gg/skins/knife/bayonet_fade.png', TRUE),
  ('knife_bayonet', 'knife', 'Doppler', 'doppler', 'legendary', 'https://images.fraghub.gg/skins/knife/bayonet_doppler.png', FALSE),
  ('knife_bayonet', 'knife', 'Marble Fade', 'marble_fade', 'legendary', 'https://images.fraghub.gg/skins/knife/bayonet_marble_fade.png', FALSE),
  ('knife_bayonet', 'knife', 'Tiger Tooth', 'tiger_tooth', 'legendary', 'https://images.fraghub.gg/skins/knife/bayonet_tiger_tooth.png', FALSE),
  ('knife_bayonet', 'knife', 'Gamma Doppler', 'gamma_doppler', 'legendary', 'https://images.fraghub.gg/skins/knife/bayonet_gamma_doppler.png', FALSE),

  ('knife_skeleton', 'knife', 'Fade', 'fade', 'legendary', 'https://images.fraghub.gg/skins/knife/skeleton_fade.png', TRUE),
  ('knife_skeleton', 'knife', 'Doppler', 'doppler', 'legendary', 'https://images.fraghub.gg/skins/knife/skeleton_doppler.png', FALSE),
  ('knife_skeleton', 'knife', 'Marble Fade', 'marble_fade', 'legendary', 'https://images.fraghub.gg/skins/knife/skeleton_marble_fade.png', FALSE),
  ('knife_skeleton', 'knife', 'Tiger Tooth', 'tiger_tooth', 'legendary', 'https://images.fraghub.gg/skins/knife/skeleton_tiger_tooth.png', FALSE),
  ('knife_skeleton', 'knife', 'Slaughter', 'slaughter', 'legendary', 'https://images.fraghub.gg/skins/knife/skeleton_slaughter.png', FALSE),

  ('knife_talon', 'knife', 'Fade', 'fade', 'legendary', 'https://images.fraghub.gg/skins/knife/talon_fade.png', TRUE),
  ('knife_talon', 'knife', 'Doppler', 'doppler', 'legendary', 'https://images.fraghub.gg/skins/knife/talon_doppler.png', FALSE),
  ('knife_talon', 'knife', 'Marble Fade', 'marble_fade', 'legendary', 'https://images.fraghub.gg/skins/knife/talon_marble_fade.png', FALSE),
  ('knife_talon', 'knife', 'Tiger Tooth', 'tiger_tooth', 'legendary', 'https://images.fraghub.gg/skins/knife/talon_tiger_tooth.png', FALSE),
  ('knife_talon', 'knife', 'Gamma Doppler', 'gamma_doppler', 'legendary', 'https://images.fraghub.gg/skins/knife/talon_gamma_doppler.png', FALSE),

  ('gloves_sport', 'gloves', 'Pandora''s Box', 'pandoras_box', 'legendary', 'https://images.fraghub.gg/skins/gloves/sport_pandoras_box.png', TRUE),
  ('gloves_sport', 'gloves', 'Vice', 'vice', 'legendary', 'https://images.fraghub.gg/skins/gloves/sport_vice.png', FALSE),
  ('gloves_sport', 'gloves', 'Nocts', 'nocts', 'classified', 'https://images.fraghub.gg/skins/gloves/sport_nocts.png', FALSE),
  ('gloves_sport', 'gloves', 'Fade', 'fade', 'legendary', 'https://images.fraghub.gg/skins/gloves/sport_fade.png', FALSE),
  ('gloves_sport', 'gloves', 'Hedge Maze', 'hedge_maze', 'legendary', 'https://images.fraghub.gg/skins/gloves/sport_hedge_maze.png', FALSE),

  ('gloves_driver', 'gloves', 'Crimson Kimono', 'crimson_kimono', 'legendary', 'https://images.fraghub.gg/skins/gloves/driver_crimson_kimono.png', TRUE),
  ('gloves_driver', 'gloves', 'King Snake', 'king_snake', 'legendary', 'https://images.fraghub.gg/skins/gloves/driver_king_snake.png', FALSE),
  ('gloves_driver', 'gloves', 'Nocts', 'nocts', 'classified', 'https://images.fraghub.gg/skins/gloves/driver_nocts.png', FALSE),
  ('gloves_driver', 'gloves', 'Black Tie', 'black_tie', 'classified', 'https://images.fraghub.gg/skins/gloves/driver_black_tie.png', FALSE),
  ('gloves_driver', 'gloves', 'Snow Leopard', 'snow_leopard', 'classified', 'https://images.fraghub.gg/skins/gloves/driver_snow_leopard.png', FALSE),

  ('gloves_specialist', 'gloves', 'Crimson Kimono', 'crimson_kimono', 'legendary', 'https://images.fraghub.gg/skins/gloves/specialist_crimson_kimono.png', TRUE),
  ('gloves_specialist', 'gloves', 'Fade', 'fade', 'legendary', 'https://images.fraghub.gg/skins/gloves/specialist_fade.png', FALSE),
  ('gloves_specialist', 'gloves', 'Vice', 'vice', 'legendary', 'https://images.fraghub.gg/skins/gloves/specialist_vice.png', FALSE),
  ('gloves_specialist', 'gloves', 'Mogul', 'mogul', 'classified', 'https://images.fraghub.gg/skins/gloves/specialist_mogul.png', FALSE),
  ('gloves_specialist', 'gloves', 'Emerald Web', 'emerald_web', 'legendary', 'https://images.fraghub.gg/skins/gloves/specialist_emerald_web.png', FALSE),

  ('gloves_moto', 'gloves', 'Pandora''s Box', 'pandoras_box', 'legendary', 'https://images.fraghub.gg/skins/gloves/moto_pandoras_box.png', TRUE),
  ('gloves_moto', 'gloves', 'Spearmint', 'spearmint', 'legendary', 'https://images.fraghub.gg/skins/gloves/moto_spearmint.png', FALSE),
  ('gloves_moto', 'gloves', 'POW!', 'pow', 'classified', 'https://images.fraghub.gg/skins/gloves/moto_pow.png', FALSE),
  ('gloves_moto', 'gloves', 'Transport', 'transport', 'restricted', 'https://images.fraghub.gg/skins/gloves/moto_transport.png', FALSE),
  ('gloves_moto', 'gloves', 'Turtle', 'turtle', 'restricted', 'https://images.fraghub.gg/skins/gloves/moto_turtle.png', FALSE),

  ('gloves_hand_wraps', 'gloves', 'Crimson Kimono', 'crimson_kimono', 'legendary', 'https://images.fraghub.gg/skins/gloves/handwraps_crimson_kimono.png', TRUE),
  ('gloves_hand_wraps', 'gloves', 'Overprint', 'overprint', 'classified', 'https://images.fraghub.gg/skins/gloves/handwraps_overprint.png', FALSE),
  ('gloves_hand_wraps', 'gloves', 'Cobalt Skulls', 'cobalt_skulls', 'classified', 'https://images.fraghub.gg/skins/gloves/handwraps_cobalt_skulls.png', FALSE),
  ('gloves_hand_wraps', 'gloves', 'CAUTION!', 'caution', 'classified', 'https://images.fraghub.gg/skins/gloves/handwraps_caution.png', FALSE),
  ('gloves_hand_wraps', 'gloves', 'Desert Shamagh', 'desert_shamagh', 'restricted', 'https://images.fraghub.gg/skins/gloves/handwraps_desert_shamagh.png', FALSE)
ON CONFLICT (weapon_name, skin_id) DO UPDATE SET
  skin_name = EXCLUDED.skin_name,
  rarity = EXCLUDED.rarity,
  image_url = EXCLUDED.image_url,
  category = EXCLUDED.category;

UPDATE weapon_skins ws
SET is_default = TRUE
WHERE ws.id IN (
  SELECT MIN(id)
  FROM weapon_skins
  GROUP BY weapon_name
);

CREATE OR REPLACE FUNCTION apply_default_player_skins()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO player_skins (player_id, weapon, skin_id, created_at, updated_at)
  SELECT NEW.id, ws.weapon_name, ws.skin_id, NOW(), NOW()
  FROM weapon_skins ws
  WHERE ws.is_default = TRUE
  ON CONFLICT (player_id, weapon) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_apply_default_player_skins ON players;
CREATE TRIGGER trg_apply_default_player_skins
AFTER INSERT ON players
FOR EACH ROW
EXECUTE FUNCTION apply_default_player_skins();

INSERT INTO player_skins (player_id, weapon, skin_id, created_at, updated_at)
SELECT p.id, ws.weapon_name, ws.skin_id, NOW(), NOW()
FROM players p
CROSS JOIN weapon_skins ws
WHERE ws.is_default = TRUE
ON CONFLICT (player_id, weapon) DO NOTHING;
