-- ─── SPRINT HIDDEN FLAG ────────────────────────────────────────────────────────
-- Admins can create "hidden" sprints (planning sprints) invisible to managers/users
ALTER TABLE sprints ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE;

-- ─── OKR ↔ SPRINT LINKS ────────────────────────────────────────────────────────
-- Many-to-many: one objective can span multiple sprints; one sprint can feed multiple objectives
CREATE TABLE IF NOT EXISTS okr_sprint_links (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  objective_id UUID NOT NULL REFERENCES okr_objectives(id) ON DELETE CASCADE,
  sprint_id    UUID NOT NULL REFERENCES sprints(id)        ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (objective_id, sprint_id)
);

CREATE INDEX IF NOT EXISTS idx_okr_sprint_links_obj    ON okr_sprint_links(objective_id);
CREATE INDEX IF NOT EXISTS idx_okr_sprint_links_sprint ON okr_sprint_links(sprint_id);
