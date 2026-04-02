-- Add temp_id column for client-side deduplication
-- Prevents duplicate inserts when the frontend retries a message (socket + REST fallback)

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS temp_id TEXT DEFAULT NULL;

-- Partial unique index: only deduplicate where temp_id is set
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_dedup
  ON chat_messages (workspace_id, temp_id)
  WHERE temp_id IS NOT NULL;
