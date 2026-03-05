CREATE TABLE IF NOT EXISTS steam_links (
  discord_id TEXT PRIMARY KEY,
  steam_id TEXT NOT NULL UNIQUE,
  steam_profile_url TEXT NOT NULL,
  steam_account_age INTEGER,
  cs_hours INTEGER,
  vac_bans INTEGER NOT NULL DEFAULT 0,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_steam_links_steam_id
  ON steam_links (steam_id);
