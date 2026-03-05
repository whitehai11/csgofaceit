CREATE TABLE IF NOT EXISTS match_timeline_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_match_timeline_events_match_created
  ON match_timeline_events (match_id, created_at);

CREATE TABLE IF NOT EXISTS server_status (
  server_id TEXT PRIMARY KEY,
  map TEXT,
  mode TEXT,
  state TEXT NOT NULL DEFAULT 'unknown',
  server_ip TEXT,
  port INTEGER,
  players_online INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_server_status_state_updated
  ON server_status (state, updated_at DESC);

CREATE TABLE IF NOT EXISTS admin_test_matches (
  match_id UUID PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL,
  started_by_player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  map TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stopped_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_test_matches_status_created
  ON admin_test_matches (status, created_at DESC);
