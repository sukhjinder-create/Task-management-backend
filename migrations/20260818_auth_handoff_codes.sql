-- Single-use codes for handing a session to a workspace subdomain.
--
-- Moving a signed-in user from app.<domain> to <slug>.<domain> crosses an
-- origin boundary, and localStorage does not cross it. The previous design
-- carried the access AND refresh token in the redirect query string, which
-- puts long-lived credentials into browser history, Referer headers and every
-- access log in the path (Cloudflare's included).
--
-- This is the OAuth authorization-code pattern instead: the redirect carries an
-- opaque code that is single-use and expires in seconds, and the real tokens
-- are fetched over POST. A code captured from a log is worthless.

CREATE TABLE IF NOT EXISTS auth_handoff_codes (
  -- The code itself is never stored, only its SHA-256. A dump of this table
  -- therefore yields nothing usable, exactly as for refresh tokens.
  code_hash     text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  text,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_ip    text
);

-- Supports expiry sweeps.
CREATE INDEX IF NOT EXISTS idx_auth_handoff_codes_expires_at
  ON auth_handoff_codes (expires_at);

-- Consumed and expired rows are worthless; this makes the sweep cheap.
CREATE INDEX IF NOT EXISTS idx_auth_handoff_codes_live
  ON auth_handoff_codes (expires_at)
  WHERE consumed_at IS NULL;

COMMENT ON TABLE auth_handoff_codes IS
  'Single-use, short-lived codes for cross-origin session handoff to workspace subdomains. Stores only SHA-256 of the code.';
