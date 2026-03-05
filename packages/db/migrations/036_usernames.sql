CREATE TABLE IF NOT EXISTS users (
  discord_id TEXT PRIMARY KEY,
  steam_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  username_changed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_steam_id
  ON users (steam_id);

CREATE INDEX IF NOT EXISTS idx_users_username
  ON users (username);
