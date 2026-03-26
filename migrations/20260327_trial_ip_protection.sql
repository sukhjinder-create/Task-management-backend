-- Migration: IP-based trial anti-abuse protection
-- Adds ip_hash to trial_fingerprints and a log table for IPs accessing trial workspaces

-- Track the IP used when creating a trial workspace
ALTER TABLE trial_fingerprints
  ADD COLUMN IF NOT EXISTS ip_hash TEXT;

CREATE INDEX IF NOT EXISTS trial_fingerprints_ip_hash_idx
  ON trial_fingerprints(ip_hash)
  WHERE ip_hash IS NOT NULL;

-- Audit log: every IP that accesses a trial workspace gets recorded here
-- Used to detect device/account switching abuse (same IP, new account)
CREATE TABLE IF NOT EXISTS trial_ip_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_hash      TEXT        NOT NULL,
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      UUID        REFERENCES users(id) ON DELETE SET NULL,
  accessed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trial_ip_log_ip_hash_idx    ON trial_ip_log(ip_hash);
CREATE INDEX IF NOT EXISTS trial_ip_log_workspace_idx  ON trial_ip_log(workspace_id);
