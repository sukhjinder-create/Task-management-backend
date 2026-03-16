-- Sprint system + ticket number infrastructure

-- 1. Project code column (for PROJ-123 style ticket IDs)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_code VARCHAR(20);

-- 2. Ticket number column on tasks
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ticket_number INTEGER;

-- 3. Sequence table to track per-project ticket counters
CREATE TABLE IF NOT EXISTS project_ticket_sequences (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  last_number INTEGER NOT NULL DEFAULT 0
);

-- 4. Sprints table
CREATE TABLE IF NOT EXISTS sprints (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  name         VARCHAR(255) NOT NULL,
  goal         TEXT,
  status       VARCHAR(20) NOT NULL DEFAULT 'planning'
                 CHECK (status IN ('planning', 'active', 'completed')),
  start_date   DATE,
  end_date     DATE,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Link tasks to sprints (NULL = backlog)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sprint_id UUID REFERENCES sprints(id) ON DELETE SET NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sprints_project_id   ON sprints(project_id);
CREATE INDEX IF NOT EXISTS idx_sprints_workspace_id ON sprints(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sprints_status       ON sprints(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_sprint_id      ON tasks(sprint_id);

COMMENT ON TABLE sprints IS 'Sprint planning: each sprint belongs to one project. Tasks link via sprint_id (NULL = backlog).';
COMMENT ON COLUMN tasks.ticket_number IS 'Auto-incrementing per-project ticket number (e.g. 42 for PROJ-42)';
COMMENT ON COLUMN tasks.sprint_id     IS 'NULL = backlog; set to sprint UUID when placed in a sprint';
