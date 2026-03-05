ALTER TABLE players
  ADD COLUMN IF NOT EXISTS creator_badge BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS creator_code TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS referred_by_creator_id UUID REFERENCES players(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS creator_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
  requested_code TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES players(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS creator_stats (
  creator_id UUID PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  creator_referrals INTEGER NOT NULL DEFAULT 0,
  creator_matches INTEGER NOT NULL DEFAULT 0,
  creator_views INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS creator_referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  referred_player_id UUID NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
  code_used TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_creator_stats_leaderboard
  ON creator_stats (creator_referrals DESC, creator_matches DESC, creator_views DESC);

CREATE INDEX IF NOT EXISTS idx_creator_referrals_creator
  ON creator_referrals (creator_id, created_at DESC);
