-- Create attendance_daily table for daily aggregations
-- This table stores the daily attendance summary calculated from attendance_events

CREATE TABLE IF NOT EXISTS attendance_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  date date NOT NULL,
  signed_in_minutes integer DEFAULT 0,
  available_minutes integer DEFAULT 0,
  aws_minutes integer DEFAULT 0,
  lunch_minutes integer DEFAULT 0,
  screen_on_minutes integer DEFAULT 0,
  screen_off_minutes integer DEFAULT 0,
  recalculated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create unique constraint to prevent duplicate entries
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_daily_unique
  ON attendance_daily (workspace_id, user_id, date);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_attendance_daily_workspace_id
  ON attendance_daily (workspace_id);

CREATE INDEX IF NOT EXISTS idx_attendance_daily_user_id
  ON attendance_daily (user_id);

CREATE INDEX IF NOT EXISTS idx_attendance_daily_date
  ON attendance_daily (date);

CREATE INDEX IF NOT EXISTS idx_attendance_daily_workspace_user
  ON attendance_daily (workspace_id, user_id);

-- Add comment to explain the table
COMMENT ON TABLE attendance_daily IS 'Daily attendance aggregations calculated from attendance_events table';
