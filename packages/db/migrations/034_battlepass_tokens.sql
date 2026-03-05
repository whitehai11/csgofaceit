CREATE TABLE IF NOT EXISTS battlepass_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id TEXT NOT NULL,
  season_id UUID NOT NULL REFERENCES seasons(season_id) ON DELETE CASCADE,
  consumed BOOLEAN NOT NULL DEFAULT FALSE,
  obtained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMPTZ,
  UNIQUE (steam_id, season_id, consumed)
);

CREATE INDEX IF NOT EXISTS idx_battlepass_tokens_steam
  ON battlepass_tokens (steam_id, season_id, consumed);

ALTER TABLE player_inventory
  ALTER COLUMN item_id DROP NOT NULL;

ALTER TABLE player_inventory
  ADD COLUMN IF NOT EXISTS item_type TEXT NOT NULL DEFAULT 'box_reward',
  ADD COLUMN IF NOT EXISTS season_id UUID REFERENCES seasons(season_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS obtained_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE player_inventory
SET obtained_at = COALESCE(obtained_at, created_at),
    item_type = COALESCE(NULLIF(item_type, ''), 'box_reward')
WHERE TRUE;

CREATE INDEX IF NOT EXISTS idx_player_inventory_item_type
  ON player_inventory (steam_id, item_type, obtained_at DESC);
