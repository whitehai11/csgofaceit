CREATE TABLE IF NOT EXISTS watchdog_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service TEXT NOT NULL,
  type TEXT NOT NULL,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_watchdog_incidents_service_created
  ON watchdog_incidents (service, created_at DESC);

