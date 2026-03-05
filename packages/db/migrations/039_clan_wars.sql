CREATE TABLE IF NOT EXISTS clan_ratings (
  clan_id UUID PRIMARY KEY REFERENCES clans(clan_id) ON DELETE CASCADE,
  rating INTEGER NOT NULL DEFAULT 1000,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  matches_played INTEGER NOT NULL DEFAULT 0,
  last_match TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS clan_war_matches (
  match_id UUID PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  season_id UUID REFERENCES seasons(season_id) ON DELETE SET NULL,
  clan_a_id UUID NOT NULL REFERENCES clans(clan_id) ON DELETE CASCADE,
  clan_b_id UUID NOT NULL REFERENCES clans(clan_id) ON DELETE CASCADE,
  clan_a_score INTEGER NOT NULL DEFAULT 0,
  clan_b_score INTEGER NOT NULL DEFAULT 0,
  winner_clan_id UUID REFERENCES clans(clan_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clan_leaderboard (
  season_id UUID NOT NULL REFERENCES seasons(season_id) ON DELETE CASCADE,
  clan_id UUID NOT NULL REFERENCES clans(clan_id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  rating INTEGER NOT NULL,
  wins INTEGER NOT NULL,
  losses INTEGER NOT NULL,
  matches_played INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (season_id, clan_id)
);

CREATE TABLE IF NOT EXISTS clan_season_results (
  season_id UUID NOT NULL REFERENCES seasons(season_id) ON DELETE CASCADE,
  clan_id UUID NOT NULL REFERENCES clans(clan_id) ON DELETE CASCADE,
  final_rating INTEGER NOT NULL,
  final_rank INTEGER NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  matches_played INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (season_id, clan_id)
);

CREATE TABLE IF NOT EXISTS clan_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clan_id UUID NOT NULL REFERENCES clans(clan_id) ON DELETE CASCADE,
  reward_type TEXT NOT NULL,
  season_id UUID REFERENCES seasons(season_id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
