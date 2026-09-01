CREATE TABLE IF NOT EXISTS web_analytics_events (
  id UUID PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('page_view', 'cta_click')),
  path TEXT NOT NULL CHECK (char_length(path) BETWEEN 1 AND 300),
  label TEXT,
  session_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_web_analytics_events_occurred_at ON web_analytics_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_analytics_events_path ON web_analytics_events (path, occurred_at DESC);
