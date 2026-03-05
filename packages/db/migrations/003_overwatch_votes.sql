ALTER TABLE players
  ADD COLUMN IF NOT EXISTS banned_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS permanent_ban BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE overwatch_cases
  ADD COLUMN IF NOT EXISTS reports JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS case_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES overwatch_cases(id) ON DELETE CASCADE,
  moderator_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  vote TEXT NOT NULL CHECK (vote IN ('cheating', 'griefing', 'clean')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (case_id, moderator_id)
);
