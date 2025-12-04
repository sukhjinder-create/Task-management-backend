-- Non-destructive compatibility fixes for chat schema
-- BACKUP before running: you already created backup_before_chat_changes.sql

-- 1) Ensure pgcrypto (for gen_random_uuid) – if this fails due to permission, we can remove it.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2) Add attachments JSONB if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='chat_messages' AND column_name='attachments'
  ) THEN
    ALTER TABLE chat_messages ADD COLUMN attachments JSONB DEFAULT '[]'::jsonb;
  END IF;
END$$;

-- 3) Add reactions JSONB if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='chat_messages' AND column_name='reactions'
  ) THEN
    ALTER TABLE chat_messages ADD COLUMN reactions JSONB DEFAULT '{}'::jsonb;
  END IF;
END$$;

-- 4) Add thread_root_id (optional helper) if missing.
-- This fixes the "column thread_root_id does not exist" error caused by earlier SQL.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='chat_messages' AND column_name='thread_root_id'
  ) THEN
    ALTER TABLE chat_messages ADD COLUMN thread_root_id UUID;

    -- Optional: populate from parent_id for existing replies
    UPDATE chat_messages
    SET thread_root_id = parent_id
    WHERE parent_id IS NOT NULL AND thread_root_id IS NULL;
  END IF;
END$$;
