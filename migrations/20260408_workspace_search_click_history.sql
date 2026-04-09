-- Extend workspace_search_history for clicked-result history

ALTER TABLE workspace_search_history
  ADD COLUMN IF NOT EXISTS clicked_result_type TEXT,
  ADD COLUMN IF NOT EXISTS clicked_result_id TEXT,
  ADD COLUMN IF NOT EXISTS clicked_result_title TEXT,
  ADD COLUMN IF NOT EXISTS clicked_result_path TEXT,
  ADD COLUMN IF NOT EXISTS clicked_result_meta JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_workspace_search_history_clicked_path
  ON workspace_search_history(workspace_id, user_id, clicked_result_path, searched_at DESC);
