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

-- Row Level Security. Enabled with no policies, which is deny-all for every
-- role that RLS applies to. The backend is unaffected because it connects as
-- the table owner, and owners bypass RLS unless FORCE is set (it is not).
--
-- This matters more here than for most tables, and storing only the hash is not
-- sufficient on its own. Supabase grants anon and authenticated full DML on
-- public tables, so the danger is not reading this table -- it is writing to
-- it. Anyone able to INSERT could pick a code, store its SHA-256 against any
-- victim's user_id with a future expires_at, then redeem that code at the
-- exchange endpoint and receive a valid session as that user. Hash-only storage
-- defeats a table dump; only RLS defeats a forged row.
--
-- Idempotent, and already true in production: the auto_enable_rls_on_new_table
-- event trigger from 20260805b caught this table at creation. Stating it here
-- anyway is the point -- an environment provisioned from migrations alone, or
-- one where that trigger is ever dropped, must not create this table exposed.
ALTER TABLE public.auth_handoff_codes ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE auth_handoff_codes IS
  'Single-use, short-lived codes for cross-origin session handoff to workspace subdomains. Stores only SHA-256 of the code.';
