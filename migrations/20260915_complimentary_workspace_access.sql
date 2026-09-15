ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS complimentary_access BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN workspaces.complimentary_access IS
  'Superadmin-managed lifetime access: all plan features and unlimited members without billing.';
