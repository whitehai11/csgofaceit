CREATE TABLE IF NOT EXISTS ban_logs (
  ban_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id TEXT NOT NULL,
  discord_id TEXT,
  reason TEXT NOT NULL,
  evidence_url TEXT,
  match_id UUID,
  case_id UUID,
  demo_timestamp_seconds INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ban_logs_created_at
  ON ban_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ban_logs_steam_id
  ON ban_logs (steam_id, created_at DESC);
