-- Autopilot performance optimization indexes

-- Faster scans for unassigned-task analysis
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_project_assigned_status
  ON tasks(workspace_id, project_id, assigned_to, status);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_assigned_status
  ON tasks(workspace_id, assigned_to, status);

-- Faster scans for due-date analysis
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_project_due_active
  ON tasks(workspace_id, project_id, due_date)
  WHERE due_date IS NOT NULL
    AND status NOT IN ('completed', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_due_active
  ON tasks(workspace_id, due_date)
  WHERE due_date IS NOT NULL
    AND status NOT IN ('completed', 'cancelled');

-- Faster scans for blocker analysis
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_project_updated_active
  ON tasks(workspace_id, project_id, updated_at)
  WHERE status NOT IN ('completed', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_updated_active
  ON tasks(workspace_id, updated_at)
  WHERE status NOT IN ('completed', 'cancelled');

-- Faster dedupe/lookup for autopilot actions
CREATE INDEX IF NOT EXISTS idx_autopilot_actions_dedupe_window
  ON autopilot_actions(workspace_id, project_id, task_id, action_type, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_autopilot_actions_pending_workspace_expires
  ON autopilot_actions(workspace_id, status, expires_at)
  WHERE status = 'pending';
