CREATE TABLE IF NOT EXISTS player_stats (
  player_id UUID PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  matches_played INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS player_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  reward_code TEXT NOT NULL,
  reward_type TEXT NOT NULL CHECK (reward_type IN ('basic_skins', 'rare_skins', 'knife_skins', 'gloves', 'exclusive_skins')),
  unlock_reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (player_id, reward_code)
);

CREATE INDEX IF NOT EXISTS idx_player_rewards_player_created
  ON player_rewards (player_id, created_at DESC);
