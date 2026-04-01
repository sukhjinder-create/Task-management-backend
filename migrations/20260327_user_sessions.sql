-- ──────────────────────────────────────────────────────────────────────────────
-- user_sessions: persistent refresh-token sessions
--
-- Each row = one active session (device/browser).
-- refresh_token_hash: SHA-256 of the plaintext refresh token (never stored plain).
-- Tokens rotate on every use (old row deleted, new row inserted).
-- Sessions expire after 7 days of inactivity.
-- All sessions for a user are deleted on password change.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_sessions (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id         TEXT        NOT NULL,
  refresh_token_hash   TEXT        NOT NULL UNIQUE,
  ip_address           TEXT,
  user_agent           TEXT,
  last_used_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token   ON user_sessions(refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);

-- Clean up expired sessions automatically (best-effort; also cleaned lazily on use)
-- Run as a periodic cron or on each login
