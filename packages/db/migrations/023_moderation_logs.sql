CREATE TABLE IF NOT EXISTS moderation_logs (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  player_id UUID REFERENCES players(id) ON DELETE SET NULL,
  moderator_id UUID REFERENCES players(id) ON DELETE SET NULL,
  reason TEXT,
  match_id UUID REFERENCES matches(id) ON DELETE SET NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_moderation_logs_player_timestamp
  ON moderation_logs (player_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_moderation_logs_action_timestamp
  ON moderation_logs (action, timestamp DESC);
