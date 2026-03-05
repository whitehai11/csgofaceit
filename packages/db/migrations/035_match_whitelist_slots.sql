ALTER TABLE match_players
  ADD COLUMN IF NOT EXISTS slot INTEGER;

CREATE INDEX IF NOT EXISTS idx_match_players_match_slot
  ON match_players (match_id, team, slot);

