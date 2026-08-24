-- Signup identity assurance and origin metadata.
-- Existing users are grandfathered as "legacy" to avoid a platform-wide lockout;
-- every new password signup is created unverified by application code.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_verification_method VARCHAR(30);

UPDATE public.users
SET email_verified_at = COALESCE(email_verified_at, created_at, now()),
    email_verification_method = COALESCE(email_verification_method, 'legacy')
WHERE email_verified_at IS NULL;

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS signup_country_code CHAR(2),
  ADD COLUMN IF NOT EXISTS signup_method VARCHAR(30);

-- Recover origin data for older workspaces when signup telemetry captured it.
UPDATE public.workspaces w
SET signup_country_code = source.country_code
FROM (
  SELECT DISTINCT ON (workspace_id)
         workspace_id,
         UPPER(country_code) AS country_code
  FROM public.growth_events
  WHERE event_name = 'product.signup_completed'
    AND country_code ~* '^[a-z]{2}$'
  ORDER BY workspace_id, occurred_at ASC
) source
WHERE source.workspace_id = w.id::text
  AND w.signup_country_code IS NULL;

UPDATE public.workspaces w
SET signup_method = source.method
FROM (
  SELECT DISTINCT ON (workspace_id)
         workspace_id,
         metadata->>'method' AS method
  FROM public.audit_logs
  WHERE action = 'workspace.signup'
    AND metadata->>'method' IS NOT NULL
  ORDER BY workspace_id, created_at ASC
) source
WHERE source.workspace_id = w.id
  AND w.signup_method IS NULL;

CREATE TABLE IF NOT EXISTS public.email_verification_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash  CHAR(64) NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user
  ON public.email_verification_tokens (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_expiry
  ON public.email_verification_tokens (expires_at)
  WHERE consumed_at IS NULL;

ALTER TABLE public.email_verification_tokens ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.email_verification_tokens IS
  'Hashed, single-use, time-limited credentials for proving mailbox ownership.';
