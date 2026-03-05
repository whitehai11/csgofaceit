CREATE TABLE IF NOT EXISTS player_skins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  weapon TEXT NOT NULL,
  skin_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (player_id, weapon)
);

CREATE INDEX IF NOT EXISTS idx_player_skins_player ON player_skins (player_id);
