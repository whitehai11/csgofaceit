CREATE TABLE IF NOT EXISTS battlepass_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id TEXT NOT NULL,
  season_id UUID NOT NULL REFERENCES seasons(season_id) ON DELETE CASCADE,
  level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1 AND level <= 50),
  xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
  is_premium BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (steam_id, season_id)
);

CREATE INDEX IF NOT EXISTS idx_battlepass_progress_season
  ON battlepass_progress (season_id, level DESC, xp DESC);

CREATE TABLE IF NOT EXISTS battlepass_reward_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id TEXT NOT NULL,
  season_id UUID NOT NULL REFERENCES seasons(season_id) ON DELETE CASCADE,
  track TEXT NOT NULL CHECK (track IN ('free', 'premium')),
  level INTEGER NOT NULL CHECK (level >= 1 AND level <= 50),
  reward_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (steam_id, season_id, track, level, reward_code)
);
