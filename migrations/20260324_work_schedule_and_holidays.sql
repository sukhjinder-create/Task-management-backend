-- ============================================================
-- Work Schedule & Holiday Calendar
-- Enables calendar-based attendance scoring:
--   - Admin configures which days are working days (default Mon–Fri)
--   - Admin marks company holidays (excluded from attendance & scoring)
--   - Approved leave days are also excluded from scoring
-- ============================================================

-- ── Work Schedule ─────────────────────────────────────────────────────────────
-- Stores which days of the week are working days per workspace.
-- work_days: integer array using JS/SQL DOW convention (0=Sun, 1=Mon, ..., 6=Sat)
-- Default: Mon–Fri = [1,2,3,4,5]
CREATE TABLE IF NOT EXISTS workspace_work_schedule (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_days    integer[]   NOT NULL DEFAULT ARRAY[1,2,3,4,5],
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now(),
  UNIQUE(workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_work_schedule_workspace ON workspace_work_schedule(workspace_id);

-- ── Company Holidays ──────────────────────────────────────────────────────────
-- Admin-declared non-working days (public holidays, company shutdowns, etc.)
-- These dates are excluded from expected working days when scoring attendance.
CREATE TABLE IF NOT EXISTS workspace_holidays (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  date         date        NOT NULL,
  name         varchar(200) NOT NULL,
  created_by   uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz DEFAULT now(),
  UNIQUE(workspace_id, date)
);

CREATE INDEX IF NOT EXISTS idx_holidays_workspace_date ON workspace_holidays(workspace_id, date);
