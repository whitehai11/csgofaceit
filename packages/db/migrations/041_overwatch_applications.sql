CREATE TABLE IF NOT EXISTS overwatch_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
  fraghub_username TEXT NOT NULL,
  motivation TEXT NOT NULL,
  moderation_experience TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES players(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_overwatch_applications_status_created
  ON overwatch_applications (status, created_at DESC);
