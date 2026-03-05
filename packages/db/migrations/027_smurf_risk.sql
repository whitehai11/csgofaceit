CREATE TABLE IF NOT EXISTS player_risk_profile (
  steam_id TEXT PRIMARY KEY,
  smurf_score INTEGER NOT NULL DEFAULT 0,
  ban_evasion_score INTEGER NOT NULL DEFAULT 0,
  reasons_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'normal'
    CHECK (status IN ('normal', 'suspected_smurf', 'high_suspicion', 'ban_evasion_likely')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS risk_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('smurf', 'ban_evasion')),
  score INTEGER NOT NULL,
  reasons_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  matched_accounts JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'monitor', 'allow', 'false_positive', 'true_positive', 'block_ranked', 'blocked', 'banned', 'resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_by UUID REFERENCES players(id) ON DELETE SET NULL,
  resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_risk_alerts_steam_created
  ON risk_alerts (steam_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_risk_alerts_type_status_created
  ON risk_alerts (type, status, created_at DESC);

CREATE TABLE IF NOT EXISTS identifier_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id TEXT NOT NULL,
  discord_id TEXT,
  ip_hash TEXT,
  device_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_identifier_links_steam
  ON identifier_links (steam_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_identifier_links_ip_hash
  ON identifier_links (ip_hash);

CREATE INDEX IF NOT EXISTS idx_identifier_links_device_hash
  ON identifier_links (device_hash);

