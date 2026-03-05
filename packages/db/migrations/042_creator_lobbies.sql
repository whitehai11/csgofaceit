CREATE TABLE IF NOT EXISTS creator_lobbies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  map_pool JSONB NOT NULL DEFAULT '[]'::jsonb,
  max_players INTEGER NOT NULL DEFAULT 10,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'starting', 'live', 'closed', 'cancelled')),
  match_id UUID REFERENCES matches(id) ON DELETE SET NULL,
  server_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_creator_lobbies_status_created
  ON creator_lobbies (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_creator_lobbies_creator_status
  ON creator_lobbies (creator_player_id, status);

CREATE TABLE IF NOT EXISTS creator_lobby_players (
  lobby_id UUID NOT NULL REFERENCES creator_lobbies(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (lobby_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_creator_lobby_players_joined
  ON creator_lobby_players (lobby_id, joined_at ASC);
