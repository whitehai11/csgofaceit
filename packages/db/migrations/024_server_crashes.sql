CREATE TABLE IF NOT EXISTS server_crashes (
  server_id TEXT NOT NULL,
  match_id UUID,
  reason TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_server_crashes_server_time
  ON server_crashes (server_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_server_crashes_match_time
  ON server_crashes (match_id, timestamp DESC);
