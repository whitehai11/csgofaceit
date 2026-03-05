ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS round_number INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS interrupted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_deadline_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS match_mmr_snapshots (
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  mmr_before INTEGER NOT NULL,
  wingman_mmr_before INTEGER NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (match_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_match_mmr_snapshots_match
  ON match_mmr_snapshots (match_id);
