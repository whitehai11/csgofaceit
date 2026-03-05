CREATE TABLE IF NOT EXISTS seasons (
  season_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('upcoming', 'active', 'ended', 'frozen')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seasons_status_dates
  ON seasons (status, start_date, end_date);

CREATE TABLE IF NOT EXISTS season_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id UUID NOT NULL REFERENCES seasons(season_id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL,
  season_xp INTEGER NOT NULL DEFAULT 0,
  season_level INTEGER NOT NULL DEFAULT 1,
  wins INTEGER NOT NULL DEFAULT 0,
  matches INTEGER NOT NULL DEFAULT 0,
  mmr INTEGER NOT NULL DEFAULT 1000,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (season_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_season_progress_player
  ON season_progress (player_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS season_leaderboard (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id TEXT NOT NULL,
  season_id UUID NOT NULL REFERENCES seasons(season_id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  mmr INTEGER NOT NULL DEFAULT 1000,
  wins INTEGER NOT NULL DEFAULT 0,
  matches INTEGER NOT NULL DEFAULT 0,
  frozen BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (season_id, steam_id)
);

CREATE INDEX IF NOT EXISTS idx_season_leaderboard_rank
  ON season_leaderboard (season_id, rank ASC, mmr DESC);

CREATE TABLE IF NOT EXISTS season_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id UUID NOT NULL REFERENCES seasons(season_id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL,
  reward_code TEXT NOT NULL,
  reward_type TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('level', 'leaderboard', 'event', 'season_end')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (season_id, player_id, reward_code, source)
);

CREATE INDEX IF NOT EXISTS idx_season_rewards_player
  ON season_rewards (player_id, granted_at DESC);

INSERT INTO seasons (name, start_date, end_date, status)
SELECT
  'Season 1',
  CURRENT_DATE,
  (CURRENT_DATE + INTERVAL '90 days')::date,
  'active'
WHERE NOT EXISTS (SELECT 1 FROM seasons);
