CREATE TABLE IF NOT EXISTS telemetry_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_events_match_ts
  ON telemetry_events (match_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_events_steam_ts
  ON telemetry_events (steam_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_events_unprocessed
  ON telemetry_events (processed, created_at ASC);

CREATE TABLE IF NOT EXISTS player_match_metrics (
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL,
  metrics_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (match_id, steam_id)
);

CREATE INDEX IF NOT EXISTS idx_player_match_metrics_steam_created
  ON player_match_metrics (steam_id, created_at DESC);

CREATE TABLE IF NOT EXISTS player_anti_cheat_profile (
  steam_id TEXT PRIMARY KEY,
  rolling_metrics_json JSONB NOT NULL,
  suspicion_level TEXT NOT NULL DEFAULT 'normal'
    CHECK (suspicion_level IN ('normal', 'flagged', 'review', 'critical')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS anti_cheat_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL,
  score NUMERIC(8, 3) NOT NULL,
  reasons_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'case_created', 'timeout_suggested', 'resolved', 'false_positive', 'timeout_applied')),
  case_id UUID REFERENCES overwatch_cases(id) ON DELETE SET NULL,
  resolved_by UUID REFERENCES players(id) ON DELETE SET NULL,
  resolved_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_anti_cheat_alert_unique_match_player
  ON anti_cheat_alerts (match_id, steam_id);

CREATE INDEX IF NOT EXISTS idx_anti_cheat_alerts_created
  ON anti_cheat_alerts (created_at DESC);

