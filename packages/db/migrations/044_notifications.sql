CREATE TABLE IF NOT EXISTS player_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_player_notifications_player_created
  ON player_notifications (player_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_player_notifications_unread
  ON player_notifications (player_id, read_at, created_at DESC);
