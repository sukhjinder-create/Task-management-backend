-- Add story points, task type, and blocked flag to tasks
-- These are the core "sprint planning" fields missing from the current system

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS story_points  INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS task_type     VARCHAR(20) DEFAULT 'task'
    CHECK (task_type IN ('task', 'bug', 'feature', 'improvement', 'chore')),
  ADD COLUMN IF NOT EXISTS is_blocked    BOOLEAN NOT NULL DEFAULT false;

-- Index for filtering by type (common in board views)
CREATE INDEX IF NOT EXISTS idx_tasks_task_type  ON tasks(project_id, task_type);
CREATE INDEX IF NOT EXISTS idx_tasks_is_blocked ON tasks(project_id, is_blocked) WHERE is_blocked = true;

COMMENT ON COLUMN tasks.story_points IS 'Effort estimate in story points (Fibonacci: 1,2,3,5,8,13)';
COMMENT ON COLUMN tasks.task_type    IS 'task | bug | feature | improvement | chore';
COMMENT ON COLUMN tasks.is_blocked   IS 'True when task is waiting on something external';
