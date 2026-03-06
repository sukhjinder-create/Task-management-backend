-- Task Activity Logs for AI Intelligence
-- Tracks all changes to tasks for strategic analysis

CREATE TABLE IF NOT EXISTS task_activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action_type VARCHAR(50) NOT NULL,
  old_value JSONB,
  new_value JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for efficient querying by task
CREATE INDEX IF NOT EXISTS idx_task_activity_logs_task_id
  ON task_activity_logs(task_id);

-- Index for workspace-level queries
CREATE INDEX IF NOT EXISTS idx_task_activity_logs_workspace_id
  ON task_activity_logs(workspace_id);

-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_task_activity_logs_created_at
  ON task_activity_logs(created_at DESC);

-- Index for action type filtering
CREATE INDEX IF NOT EXISTS idx_task_activity_logs_action_type
  ON task_activity_logs(action_type);

-- Composite index for common query patterns
CREATE INDEX IF NOT EXISTS idx_task_activity_logs_workspace_created
  ON task_activity_logs(workspace_id, created_at DESC);

-- Comment documentation
COMMENT ON TABLE task_activity_logs IS 'Activity log for all task changes - used by AI Strategic Intelligence';
COMMENT ON COLUMN task_activity_logs.action_type IS 'TASK_CREATED, STATUS_CHANGED, ASSIGNEE_CHANGED, PRIORITY_CHANGED, DESCRIPTION_UPDATED, COMMENT_ADDED, TASK_DELETED';
COMMENT ON COLUMN task_activity_logs.old_value IS 'Previous state (JSON)';
COMMENT ON COLUMN task_activity_logs.new_value IS 'New state (JSON)';
