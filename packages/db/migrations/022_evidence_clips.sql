CREATE TABLE IF NOT EXISTS evidence_clips (
  clip_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id UUID REFERENCES players(id) ON DELETE SET NULL,
  timestamp INTEGER NOT NULL CHECK (timestamp >= 0),
  clip_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evidence_clips_match_timestamp
  ON evidence_clips (match_id, timestamp DESC);
