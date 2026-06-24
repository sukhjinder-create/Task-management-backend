CREATE TABLE IF NOT EXISTS enterprise_intelligence_cutover_controls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  surface TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'legacy',
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT enterprise_intelligence_cutover_mode_check
    CHECK (mode IN ('legacy', 'unified', 'shadow')),
  CONSTRAINT enterprise_intelligence_cutover_surface_check
    CHECK (surface IN (
      'all_core',
      'dashboard_overview',
      'dashboard_executive_detail',
      'user_performance',
      'admin_insights',
      'coaching_effectiveness',
      'user_trend',
      'user_project_performance',
      'projects_health',
      'team_comparison',
      'workspace_dashboard',
      'workspace_health'
    ))
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_enterprise_intelligence_cutover_control
  ON enterprise_intelligence_cutover_controls (COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), surface);

CREATE INDEX IF NOT EXISTS idx_enterprise_intelligence_cutover_workspace
  ON enterprise_intelligence_cutover_controls (workspace_id, surface, mode);

CREATE OR REPLACE FUNCTION touch_enterprise_intelligence_cutover_controls()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enterprise_intelligence_cutover_controls_touch
  ON enterprise_intelligence_cutover_controls;

CREATE TRIGGER trg_enterprise_intelligence_cutover_controls_touch
BEFORE UPDATE ON enterprise_intelligence_cutover_controls
FOR EACH ROW
EXECUTE FUNCTION touch_enterprise_intelligence_cutover_controls();
