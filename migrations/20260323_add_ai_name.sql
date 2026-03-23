-- Add ai_name column to workspace_ai_settings
-- Allows workspace admin to set a display name for the AI assistant
ALTER TABLE workspace_ai_settings
  ADD COLUMN IF NOT EXISTS ai_name TEXT NOT NULL DEFAULT 'AI Assistant';
