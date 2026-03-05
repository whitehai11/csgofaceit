CREATE TABLE IF NOT EXISTS match_highlights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('ace', '4k', 'clutch_1v3', 'noscope_kill')),
  round_number INTEGER,
  timestamp_seconds INTEGER NOT NULL CHECK (timestamp_seconds >= 0),
  demo_url TEXT,
  clip_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_match_highlights_match_created
  ON match_highlights (match_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_match_highlights_player_created
  ON match_highlights (player_id, created_at DESC);
