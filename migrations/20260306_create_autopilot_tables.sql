-- AI Autopilot Mode Tables
-- These tables power the autonomous task management system

-- ============================================
-- AUTOPILOT SETTINGS (per project/workspace)
-- ============================================
CREATE TABLE IF NOT EXISTS autopilot_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NULL, -- NULL = workspace-level default

  -- Autopilot configuration
  enabled boolean DEFAULT false,
  mode varchar(20) DEFAULT 'assisted', -- 'assisted' | 'autonomous' | 'monitoring'

  -- Feature toggles
  auto_assign boolean DEFAULT true,
  auto_deadline_adjust boolean DEFAULT true,
  auto_escalate_blockers boolean DEFAULT true,
  auto_generate_standup boolean DEFAULT true,

  -- Thresholds
  max_tasks_per_user integer DEFAULT 10, -- Don't auto-assign if user has more
  blocker_threshold_hours integer DEFAULT 48, -- Escalate if no update in X hours
  velocity_drop_threshold decimal DEFAULT 0.20, -- 20% drop triggers action

  -- Approval settings
  require_approval boolean DEFAULT true,
  auto_approve_after_hours integer DEFAULT 24, -- Auto-approve if no response
  approval_user_id uuid NULL, -- Who approves actions

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  CONSTRAINT fk_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_autopilot_settings_workspace ON autopilot_settings(workspace_id);
CREATE INDEX idx_autopilot_settings_project ON autopilot_settings(project_id);
CREATE UNIQUE INDEX idx_autopilot_settings_unique ON autopilot_settings(workspace_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ============================================
-- AUTOPILOT ACTIONS (pending approvals)
-- ============================================
CREATE TABLE IF NOT EXISTS autopilot_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NULL,
  task_id uuid NULL,

  -- Action details
  action_type varchar(50) NOT NULL, -- 'reassign' | 'adjust_deadline' | 'escalate' | 'create_task'
  status varchar(20) DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected' | 'auto_approved' | 'executed'

  -- Action data
  reason text NOT NULL, -- AI-generated explanation
  current_state jsonb, -- What is now
  proposed_changes jsonb, -- What AI wants to do
  confidence_score decimal, -- 0.0-1.0

  -- Approval tracking
  created_by varchar(20) DEFAULT 'autopilot', -- 'autopilot' | 'user_id'
  approved_by uuid NULL,
  approved_at timestamptz NULL,
  executed_at timestamptz NULL,

  -- Metadata
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz, -- Auto-approve after this time if configured

  CONSTRAINT fk_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_autopilot_actions_workspace ON autopilot_actions(workspace_id);
CREATE INDEX idx_autopilot_actions_status ON autopilot_actions(status);
CREATE INDEX idx_autopilot_actions_pending ON autopilot_actions(workspace_id, status) WHERE status = 'pending';
CREATE INDEX idx_autopilot_actions_expires ON autopilot_actions(expires_at) WHERE status = 'pending';

-- ============================================
-- AUTOPILOT DECISIONS (audit trail)
-- ============================================
CREATE TABLE IF NOT EXISTS autopilot_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  action_id uuid NOT NULL,

  -- Decision record
  decision varchar(20) NOT NULL, -- 'executed' | 'rejected' | 'expired'
  decision_by uuid NULL, -- User who made decision (NULL = auto)
  decision_at timestamptz DEFAULT now(),

  -- Outcome tracking
  outcome_status varchar(20), -- 'success' | 'failed' | 'partial'
  outcome_data jsonb,

  -- Learning data (for improving AI)
  user_feedback text,
  effectiveness_score decimal, -- Did this help? 0.0-1.0

  created_at timestamptz DEFAULT now(),

  CONSTRAINT fk_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_action FOREIGN KEY (action_id) REFERENCES autopilot_actions(id) ON DELETE CASCADE
);

CREATE INDEX idx_autopilot_decisions_workspace ON autopilot_decisions(workspace_id);
CREATE INDEX idx_autopilot_decisions_action ON autopilot_decisions(action_id);
CREATE INDEX idx_autopilot_decisions_effectiveness ON autopilot_decisions(effectiveness_score) WHERE effectiveness_score IS NOT NULL;

-- ============================================
-- USER WORKLOAD VIEW (for auto-assignment)
-- ============================================
CREATE OR REPLACE VIEW user_workload_view AS
SELECT
  t.workspace_id,
  t.assigned_to AS user_id,
  COUNT(*) FILTER (WHERE t.status NOT IN ('completed', 'cancelled')) AS active_tasks,
  COUNT(*) FILTER (WHERE t.status = 'completed' AND t.completed_at > NOW() - INTERVAL '7 days') AS completed_last_week,
  COUNT(*) FILTER (WHERE t.due_date < NOW() AND t.status NOT IN ('completed', 'cancelled')) AS overdue_tasks,
  AVG(EXTRACT(EPOCH FROM (COALESCE(t.completed_at, NOW()) - t.created_at)) / 86400) AS avg_completion_days
FROM tasks t
WHERE t.assigned_to IS NOT NULL
GROUP BY t.workspace_id, t.assigned_to;

COMMENT ON VIEW user_workload_view IS 'Aggregated user workload metrics for auto-assignment decisions';

-- ============================================
-- COMMENTS
-- ============================================
COMMENT ON TABLE autopilot_settings IS 'Configuration for AI Autopilot per workspace/project';
COMMENT ON TABLE autopilot_actions IS 'Pending and historical AI-proposed actions requiring approval';
COMMENT ON TABLE autopilot_decisions IS 'Audit trail of all autopilot decisions and their outcomes';
