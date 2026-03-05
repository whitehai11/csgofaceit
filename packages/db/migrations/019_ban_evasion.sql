CREATE TABLE IF NOT EXISTS player_identifiers (
  steam_id TEXT PRIMARY KEY,
  discord_id TEXT,
  ip_hash TEXT,
  ip_range_hash TEXT,
  hardware_hash TEXT,
  discord_invite_source TEXT,
  discord_account_created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_player_identifiers_discord_id
  ON player_identifiers (discord_id);

CREATE INDEX IF NOT EXISTS idx_player_identifiers_ip_hash
  ON player_identifiers (ip_hash);

CREATE INDEX IF NOT EXISTS idx_player_identifiers_ip_range_hash
  ON player_identifiers (ip_range_hash);

CREATE INDEX IF NOT EXISTS idx_player_identifiers_hardware_hash
  ON player_identifiers (hardware_hash);

CREATE TABLE IF NOT EXISTS ban_evasion_cases (
  case_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id TEXT NOT NULL,
  discord_id TEXT,
  suspicion_score INTEGER NOT NULL,
  matched_account TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'flagged', 'blocked', 'allowed', 'monitoring', 'banned', 'dismissed')),
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_by UUID REFERENCES players(id) ON DELETE SET NULL,
  resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_ban_evasion_cases_created
  ON ban_evasion_cases (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ban_evasion_cases_steam_status
  ON ban_evasion_cases (steam_id, status, created_at DESC);
