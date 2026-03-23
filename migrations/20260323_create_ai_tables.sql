-- ============================================================
-- AI SYSTEM TABLES
-- All tables needed for AI auto-reply and workspace AI settings
-- ============================================================

-- Workspace-level AI settings (master switch + auto-reply toggle)
CREATE TABLE IF NOT EXISTS workspace_ai_settings (
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ai_enabled    BOOLEAN     NOT NULL DEFAULT true,
  ai_auto_reply BOOLEAN     NOT NULL DEFAULT false,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id)
);

-- Per-user AI auto-reply preference (opt-in, defaults OFF)
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ai_reply_enabled BOOLEAN     NOT NULL DEFAULT false,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id)
);

-- System/bot users per workspace (one AI user per workspace)
CREATE TABLE IF NOT EXISTS system_users (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id)
);

-- AI memory: opaque key-value store per workspace
CREATE TABLE IF NOT EXISTS ai_memory (
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type         TEXT        NOT NULL,
  payload      JSONB       NOT NULL DEFAULT '{}',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, type)
);

-- AI decision provenance: why the AI replied to a specific message
CREATE TABLE IF NOT EXISTS ai_decision_provenance (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id         UUID        NOT NULL,
  channel_key        TEXT,
  trigger_message_id UUID,
  explanation        JSONB,
  confidence         FLOAT,
  model              TEXT,
  context            JSONB       DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_provenance_message    ON ai_decision_provenance(message_id);
CREATE INDEX IF NOT EXISTS idx_ai_provenance_workspace  ON ai_decision_provenance(workspace_id);
