CREATE TABLE IF NOT EXISTS rank_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  match_id UUID REFERENCES matches(id) ON DELETE SET NULL,
  previous_rank TEXT NOT NULL,
  new_rank TEXT NOT NULL,
  mmr_delta INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rank_history_player_created
  ON rank_history (player_id, created_at DESC);
