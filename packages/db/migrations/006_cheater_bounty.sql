ALTER TABLE players
  ADD COLUMN IF NOT EXISTS reputation_points INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bounty_score INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS confirmed_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL UNIQUE REFERENCES overwatch_cases(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  confirmation_type TEXT NOT NULL CHECK (confirmation_type IN ('cheating_ban')),
  confirmed_by UUID REFERENCES players(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bounty_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES confirmed_cases(case_id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  reputation_points INTEGER NOT NULL,
  bounty_score INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (case_id, reporter_id)
);

CREATE INDEX IF NOT EXISTS idx_bounty_rewards_reporter_created
  ON bounty_rewards (reporter_id, created_at DESC);
