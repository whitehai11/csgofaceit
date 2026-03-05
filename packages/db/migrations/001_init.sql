CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  elo INTEGER NOT NULL DEFAULT 1000,
  report_score INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'player',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  map TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  server_ip TEXT,
  server_port INTEGER,
  server_password TEXT,
  spectator_password TEXT,
  connect_string TEXT,
  demo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team TEXT NOT NULL,
  PRIMARY KEY (match_id, player_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  reported_player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS overwatch_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reported_player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open',
  demo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_by UUID REFERENCES players(id),
  resolution TEXT
);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID REFERENCES overwatch_cases(id) ON DELETE SET NULL,
  moderator_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  target_player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);