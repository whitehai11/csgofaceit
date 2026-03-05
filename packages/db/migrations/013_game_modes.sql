ALTER TABLE players
  ADD COLUMN IF NOT EXISTS wingman_mmr INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS wingman_rank TEXT NOT NULL DEFAULT 'Gold Nova';

UPDATE players
SET wingman_rank = calculate_rank_from_mmr(wingman_mmr)
WHERE wingman_rank IS NULL OR wingman_rank = '';

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'ranked',
  ADD COLUMN IF NOT EXISTS unranked BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_matches_mode_status_created
  ON matches (mode, status, created_at DESC);
