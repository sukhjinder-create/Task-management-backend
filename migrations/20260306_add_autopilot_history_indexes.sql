-- Performance indexes for autopilot history (search/date/pagination)

CREATE INDEX IF NOT EXISTS idx_autopilot_actions_workspace_created_at
  ON autopilot_actions(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_autopilot_actions_workspace_project_created_at
  ON autopilot_actions(workspace_id, project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_autopilot_actions_workspace_status_created_at
  ON autopilot_actions(workspace_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_autopilot_actions_workspace_action_type
  ON autopilot_actions(workspace_id, action_type);

CREATE INDEX IF NOT EXISTS idx_autopilot_decisions_action_decision_at
  ON autopilot_decisions(action_id, decision_at DESC);
