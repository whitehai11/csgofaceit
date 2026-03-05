CREATE TABLE IF NOT EXISTS verified_users (
  discord_id TEXT PRIMARY KEY,
  steam_id TEXT NOT NULL UNIQUE,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_verified_users_steam_id
  ON verified_users (steam_id);
