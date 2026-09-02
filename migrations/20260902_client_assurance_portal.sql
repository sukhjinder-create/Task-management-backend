-- Passwordless Client Assurance Portal
--
-- Extends the existing outcome commitment instead of creating a second project
-- model. Existing outcomes remain internal by default. Client identities are
-- deliberately separate from users/workspace_users, so they are not billable
-- seats and cannot cross the internal authentication boundary.

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_workspace_id_id
  ON public.users (workspace_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_okr_objectives_workspace_id_id
  ON public.okr_objectives (workspace_id, id);

CREATE TABLE IF NOT EXISTS public.assurance_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assurance_clients_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT assurance_clients_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT assurance_clients_created_by_workspace_fkey
    FOREIGN KEY (workspace_id, created_by)
    REFERENCES public.users(workspace_id, id) ON DELETE SET NULL (created_by),
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_assurance_clients_workspace_name
  ON public.assurance_clients (workspace_id, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS public.assurance_client_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  client_id UUID NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  invited_by UUID,
  last_accessed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assurance_client_contacts_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT assurance_client_contacts_email_check CHECK (
    char_length(email) BETWEEN 3 AND 320 AND email = lower(btrim(email)) AND position('@' IN email) > 1
  ),
  CONSTRAINT assurance_client_contacts_status_check CHECK (status IN ('active', 'revoked')),
  CONSTRAINT assurance_client_contacts_client_fkey
    FOREIGN KEY (workspace_id, client_id)
    REFERENCES public.assurance_clients(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT assurance_client_contacts_invited_by_workspace_fkey
    FOREIGN KEY (workspace_id, invited_by)
    REFERENCES public.users(workspace_id, id) ON DELETE SET NULL (invited_by),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, client_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_assurance_client_contacts_workspace_email
  ON public.assurance_client_contacts (workspace_id, email);

CREATE INDEX IF NOT EXISTS idx_assurance_client_contacts_client
  ON public.assurance_client_contacts (workspace_id, client_id, status, name);

ALTER TABLE public.okr_objectives
  ADD COLUMN IF NOT EXISTS is_client_facing BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS client_id UUID,
  ADD COLUMN IF NOT EXISTS client_approver_contact_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_okr_objectives_workspace_client_id
  ON public.okr_objectives (workspace_id, client_id, id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'okr_objectives_client_workspace_fkey'
      AND conrelid = 'public.okr_objectives'::regclass
  ) THEN
    ALTER TABLE public.okr_objectives
      ADD CONSTRAINT okr_objectives_client_workspace_fkey
      FOREIGN KEY (workspace_id, client_id)
      REFERENCES public.assurance_clients(workspace_id, id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'okr_objectives_client_contact_workspace_fkey'
      AND conrelid = 'public.okr_objectives'::regclass
  ) THEN
    ALTER TABLE public.okr_objectives
      ADD CONSTRAINT okr_objectives_client_contact_workspace_fkey
      FOREIGN KEY (workspace_id, client_id, client_approver_contact_id)
      REFERENCES public.assurance_client_contacts(workspace_id, client_id, id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'okr_objectives_client_assignment_check'
      AND conrelid = 'public.okr_objectives'::regclass
  ) THEN
    ALTER TABLE public.okr_objectives
      ADD CONSTRAINT okr_objectives_client_assignment_check
      CHECK (
        is_client_facing = FALSE
        OR (client_id IS NOT NULL AND client_approver_contact_id IS NOT NULL)
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.okr_objectives
  VALIDATE CONSTRAINT okr_objectives_client_assignment_check;

CREATE INDEX IF NOT EXISTS idx_okr_objectives_client_portal
  ON public.okr_objectives (workspace_id, client_id, target_date, updated_at DESC)
  WHERE is_client_facing = TRUE;

CREATE TABLE IF NOT EXISTS public.assurance_client_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  goal_id UUID NOT NULL,
  client_id UUID NOT NULL,
  contact_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  snapshot JSONB NOT NULL,
  decision_note TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  delivery_error TEXT,
  requested_by UUID,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  last_delivered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assurance_client_reviews_status_check
    CHECK (status IN ('pending', 'accepted', 'changes_requested', 'cancelled')),
  CONSTRAINT assurance_client_reviews_snapshot_check CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT assurance_client_reviews_delivery_check
    CHECK (delivery_status IN ('pending', 'sent', 'failed')),
  CONSTRAINT assurance_client_reviews_goal_fkey
    FOREIGN KEY (workspace_id, client_id, goal_id)
    REFERENCES public.okr_objectives(workspace_id, client_id, id) ON DELETE CASCADE,
  CONSTRAINT assurance_client_reviews_contact_fkey
    FOREIGN KEY (workspace_id, client_id, contact_id)
    REFERENCES public.assurance_client_contacts(workspace_id, client_id, id),
  CONSTRAINT assurance_client_reviews_requested_by_workspace_fkey
    FOREIGN KEY (workspace_id, requested_by)
    REFERENCES public.users(workspace_id, id) ON DELETE SET NULL (requested_by),
  UNIQUE (workspace_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_assurance_client_reviews_one_pending
  ON public.assurance_client_reviews (workspace_id, goal_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_assurance_client_reviews_portal
  ON public.assurance_client_reviews (workspace_id, client_id, contact_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS public.client_portal_magic_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL,
  review_id UUID,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT client_portal_magic_links_token_check CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT client_portal_magic_links_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT client_portal_magic_links_contact_fkey
    FOREIGN KEY (workspace_id, contact_id)
    REFERENCES public.assurance_client_contacts(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT client_portal_magic_links_review_fkey
    FOREIGN KEY (workspace_id, review_id)
    REFERENCES public.assurance_client_reviews(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_client_portal_magic_links_contact
  ON public.client_portal_magic_links (workspace_id, contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.client_portal_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT client_portal_sessions_token_check CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT client_portal_sessions_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT client_portal_sessions_contact_fkey
    FOREIGN KEY (workspace_id, contact_id)
    REFERENCES public.assurance_client_contacts(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_client_portal_sessions_contact
  ON public.client_portal_sessions (workspace_id, contact_id, expires_at DESC)
  WHERE revoked_at IS NULL;

-- The reconciliation snapshot accepts the two client decision states while all
-- existing state values and meanings remain unchanged.
ALTER TABLE public.assurance_state_snapshots
  DROP CONSTRAINT IF EXISTS assurance_state_value_check;

ALTER TABLE public.assurance_state_snapshots
  ADD CONSTRAINT assurance_state_value_check CHECK (state IN (
    'insufficient_evidence', 'on_track', 'at_risk', 'off_track',
    'needs_evidence', 'awaiting_client_acceptance',
    'client_changes_requested', 'verified'
  )) NOT VALID;

ALTER TABLE public.assurance_state_snapshots
  VALIDATE CONSTRAINT assurance_state_value_check;

ALTER TABLE public.assurance_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assurance_client_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assurance_client_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_portal_magic_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_portal_sessions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.assurance_clients IS
  'Workspace-scoped external client organizations. They are not workspace users or billable seats.';
COMMENT ON TABLE public.assurance_client_reviews IS
  'Immutable client-safe outcome snapshots with historical acceptance decisions.';
COMMENT ON TABLE public.client_portal_magic_links IS
  'One-time passwordless access tokens stored only as SHA-256 digests.';
COMMENT ON TABLE public.client_portal_sessions IS
  'Revocable external portal sessions stored only as opaque-token digests.';
