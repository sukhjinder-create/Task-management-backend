-- Additive compatibility migration for project CRUD.
-- Backend project repository stores an optional project description, while
-- older production schemas only contained name/added_by/workspace_id.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS description TEXT;
