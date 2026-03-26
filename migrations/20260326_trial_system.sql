-- Trial system: add trial columns to workspaces + anti-abuse fingerprints table

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_ends_at    TIMESTAMPTZ;

-- Tracks which email domains have already consumed a free trial (anti-abuse)
CREATE TABLE IF NOT EXISTS trial_fingerprints (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint_hash TEXT        NOT NULL UNIQUE,  -- SHA-256 of lowercased email domain
  workspace_id     UUID        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tf_hash ON trial_fingerprints (fingerprint_hash);
