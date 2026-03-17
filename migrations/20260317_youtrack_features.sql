-- YouTrack parity features migration
-- Tags, Issue Links, Time Tracking, Watchers, Votes, Templates, Saved Filters,
-- Multiple Assignees, WIP Limits, Estimation Hours

-- ─────────────────────────────────────────────
-- 1. TAGS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tags (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  name         VARCHAR(80) NOT NULL,
  color        VARCHAR(20) NOT NULL DEFAULT '#6366f1',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS task_tag_assignments (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id  UUID NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_tags_workspace ON tags(workspace_id);
CREATE INDEX IF NOT EXISTS idx_task_tags_task ON task_tag_assignments(task_id);
CREATE INDEX IF NOT EXISTS idx_task_tags_tag  ON task_tag_assignments(tag_id);

-- ─────────────────────────────────────────────
-- 2. ISSUE LINKS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_task_id  UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  target_task_id  UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  link_type       VARCHAR(30) NOT NULL
                    CHECK (link_type IN ('blocks','is_blocked_by','relates_to','duplicates','duplicate_of','parent_of','child_of')),
  workspace_id    UUID NOT NULL,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (source_task_id, target_task_id, link_type)
);

CREATE INDEX IF NOT EXISTS idx_task_links_source ON task_links(source_task_id);
CREATE INDEX IF NOT EXISTS idx_task_links_target ON task_links(target_task_id);
CREATE INDEX IF NOT EXISTS idx_task_links_workspace ON task_links(workspace_id);

-- ─────────────────────────────────────────────
-- 3. TIME TRACKING
-- ─────────────────────────────────────────────
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimation_hours NUMERIC(6,2);

CREATE TABLE IF NOT EXISTS time_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  hours        NUMERIC(5,2) NOT NULL CHECK (hours > 0),
  log_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  description  TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_time_logs_task      ON time_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_time_logs_user      ON time_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_time_logs_workspace ON time_logs(workspace_id);

-- ─────────────────────────────────────────────
-- 4. WATCHERS / SUBSCRIBERS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_watchers (
  task_id      UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (task_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_task_watchers_task ON task_watchers(task_id);
CREATE INDEX IF NOT EXISTS idx_task_watchers_user ON task_watchers(user_id);

-- ─────────────────────────────────────────────
-- 5. VOTES / UPVOTES
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_votes (
  task_id      UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (task_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_task_votes_task ON task_votes(task_id);

-- ─────────────────────────────────────────────
-- 6. ISSUE TEMPLATES
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS issue_templates (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL,
  project_id     UUID REFERENCES projects(id) ON DELETE CASCADE,
  name           VARCHAR(120) NOT NULL,
  description    TEXT,
  default_fields JSONB NOT NULL DEFAULT '{}',
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_templates_workspace ON issue_templates(workspace_id);
CREATE INDEX IF NOT EXISTS idx_templates_project   ON issue_templates(project_id);

-- ─────────────────────────────────────────────
-- 7. SAVED FILTERS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saved_filters (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    UUID REFERENCES projects(id) ON DELETE CASCADE,
  name          VARCHAR(100) NOT NULL,
  filter_config JSONB NOT NULL DEFAULT '{}',
  is_shared     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_filters_workspace ON saved_filters(workspace_id);
CREATE INDEX IF NOT EXISTS idx_saved_filters_user      ON saved_filters(user_id);

-- ─────────────────────────────────────────────
-- 8. MULTIPLE ASSIGNEES
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_assignees (
  task_id      UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  assigned_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (task_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_task_assignees_task ON task_assignees(task_id);
CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON task_assignees(user_id);

-- ─────────────────────────────────────────────
-- 9. WIP LIMITS (per project, per status column)
-- ─────────────────────────────────────────────
ALTER TABLE projects ADD COLUMN IF NOT EXISTS wip_limits JSONB DEFAULT '{}';
-- Usage: { "in-progress": 5, "pending": null, "completed": null }
-- null = no limit

COMMENT ON COLUMN projects.wip_limits IS 'Per-status WIP limits: {"in-progress": 5}. null value = unlimited.';
