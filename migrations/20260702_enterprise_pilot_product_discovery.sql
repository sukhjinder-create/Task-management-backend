-- Enterprise Pilot Product Discovery telemetry snapshots.
-- Additive and rollback-safe: uses existing growth_events as the source of truth.

CREATE TABLE IF NOT EXISTS growth_product_weekly_insights (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start      DATE NOT NULL,
  week_end        DATE NOT NULL,
  insight_key     VARCHAR(160) NOT NULL,
  insight_type    VARCHAR(80) NOT NULL,
  priority        VARCHAR(24) NOT NULL DEFAULT 'medium',
  title           TEXT NOT NULL,
  summary         TEXT NOT NULL,
  evidence        JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendation  TEXT,
  confidence      NUMERIC(5, 4) NOT NULL DEFAULT 0,
  status          VARCHAR(24) NOT NULL DEFAULT 'open',
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     UUID,
  notes           TEXT,
  CONSTRAINT growth_product_weekly_insights_priority_check
    CHECK (priority IN ('critical', 'high', 'medium', 'low')),
  CONSTRAINT growth_product_weekly_insights_status_check
    CHECK (status IN ('open', 'reviewed', 'accepted', 'dismissed')),
  CONSTRAINT growth_product_weekly_insights_confidence_check
    CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT growth_product_weekly_insights_week_check
    CHECK (week_end >= week_start),
  CONSTRAINT growth_product_weekly_insights_unique
    UNIQUE (week_start, insight_key)
);

CREATE INDEX IF NOT EXISTS idx_growth_product_weekly_insights_week
  ON growth_product_weekly_insights (week_start DESC, priority, insight_type);

CREATE INDEX IF NOT EXISTS idx_growth_product_weekly_insights_type_status
  ON growth_product_weekly_insights (insight_type, status, generated_at DESC);

COMMENT ON TABLE growth_product_weekly_insights IS
  'Weekly privacy-minimized product discovery insights generated from growth_events for enterprise pilot review.';

COMMENT ON COLUMN growth_product_weekly_insights.evidence IS
  'Aggregate evidence only. Must not contain message text, prompt text, raw search query text, or customer content.';

ALTER TABLE growth_product_weekly_insights ENABLE ROW LEVEL SECURITY;
