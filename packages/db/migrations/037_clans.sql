CREATE TABLE IF NOT EXISTS clans (
  clan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clan_name TEXT NOT NULL UNIQUE,
  clan_tag TEXT NOT NULL UNIQUE,
  owner_steam_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clans_upper_tag_unique
  ON clans (UPPER(clan_tag));

CREATE UNIQUE INDEX IF NOT EXISTS idx_clans_lower_name_unique
  ON clans (LOWER(clan_name));

CREATE TABLE IF NOT EXISTS clan_members (
  clan_id UUID NOT NULL REFERENCES clans(clan_id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (clan_id, steam_id)
);

CREATE TABLE IF NOT EXISTS clan_creation_requests (
  request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_steam_id TEXT NOT NULL,
  clan_name TEXT NOT NULL,
  clan_tag TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewer_steam_id TEXT,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS clan_join_requests (
  request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clan_id UUID NOT NULL REFERENCES clans(clan_id) ON DELETE CASCADE,
  player_steam_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewer_steam_id TEXT,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clan_join_requests_unique_pending
  ON clan_join_requests (clan_id, player_steam_id)
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS idx_clan_creation_unique_pending_by_applicant
  ON clan_creation_requests (applicant_steam_id)
  WHERE status = 'pending';
