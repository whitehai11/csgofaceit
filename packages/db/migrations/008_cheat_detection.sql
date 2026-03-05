CREATE TABLE IF NOT EXISTS player_suspicion_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  metrics JSONB NOT NULL,
  suspicion_score INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('normal', 'flagged', 'overwatch', 'discord_alert')),
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_player_suspicion_player_created
  ON player_suspicion_events (player_id, created_at DESC);
