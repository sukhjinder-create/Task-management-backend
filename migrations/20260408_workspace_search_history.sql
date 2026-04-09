-- Workspace search history
-- Additive table to persist admin workspace-search usage and expose recent history

CREATE TABLE IF NOT EXISTS workspace_search_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  result_count INTEGER NOT NULL DEFAULT 0,
  result_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  searched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_search_history_scope_time
  ON workspace_search_history(workspace_id, user_id, searched_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_search_history_normalized_query
  ON workspace_search_history(workspace_id, user_id, normalized_query, searched_at DESC);
