-- Dashboard performance indexes for high concurrency read paths

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_project_status_due_assigned
  ON tasks(workspace_id, project_id, status, due_date, assigned_to);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_assigned_project_status
  ON tasks(workspace_id, assigned_to, project_id, status);

CREATE INDEX IF NOT EXISTS idx_projects_workspace_added_by
  ON projects(workspace_id, added_by, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_attendance_daily_workspace_date_user
  ON attendance_daily(workspace_id, date, user_id);

-- workspace_monthly_scores does not always include project_id in all environments.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'workspace_monthly_scores'
      AND column_name = 'workspace_id'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'workspace_monthly_scores'
      AND column_name = 'month'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'workspace_monthly_scores'
      AND column_name = 'user_id'
  ) THEN
    EXECUTE '
      CREATE INDEX IF NOT EXISTS idx_workspace_monthly_scores_scope
      ON workspace_monthly_scores(workspace_id, month, user_id)
    ';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'workspace_project_monthly_scores'
      AND column_name = 'workspace_id'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'workspace_project_monthly_scores'
      AND column_name = 'month'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'workspace_project_monthly_scores'
      AND column_name = 'project_id'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'workspace_project_monthly_scores'
      AND column_name = 'user_id'
  ) THEN
    EXECUTE '
      CREATE INDEX IF NOT EXISTS idx_workspace_project_monthly_scores_scope
      ON workspace_project_monthly_scores(workspace_id, month, project_id, user_id)
    ';
  END IF;
END $$;
