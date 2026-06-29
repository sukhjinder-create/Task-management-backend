-- Dedicated, single-use password recovery tokens for platform Super Admins.

CREATE TABLE IF NOT EXISTS superadmin_password_reset_tokens (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  superadmin_id       UUID NOT NULL REFERENCES superadmins(id) ON DELETE CASCADE,
  token_hash          TEXT NOT NULL UNIQUE,
  requested_ip_hash   TEXT,
  expires_at          TIMESTAMPTZ NOT NULL,
  used_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_superadmin_password_reset_token
  ON superadmin_password_reset_tokens (token_hash)
  WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_superadmin_password_reset_admin
  ON superadmin_password_reset_tokens (superadmin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_superadmin_password_reset_expiry
  ON superadmin_password_reset_tokens (expires_at)
  WHERE used_at IS NULL;

ALTER TABLE superadmin_password_reset_tokens ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE superadmin_password_reset_tokens IS
  'Hashed, short-lived, single-use recovery tokens for dedicated Super Admin authentication.';
