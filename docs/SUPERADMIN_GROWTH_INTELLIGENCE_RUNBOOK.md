# Super Admin Stability and Growth Intelligence

## Authentication architecture

Super Admin authentication is deliberately separate from workspace-user authentication:

- `POST /superadmin/login` validates the `superadmins` table and creates a dedicated `superadmin_sessions` row.
- Access tokens are short-lived, carry `type=superadmin`, and are restricted by issuer and audience.
- `POST /superadmin/refresh` renews access from a hashed, server-side refresh session.
- `POST /superadmin/logout` revokes that dedicated session.
- Every protected Super Admin request verifies that its server-side session is still active, so password changes and explicit revocation invalidate access immediately.
- Workspace JWTs cannot pass `requireSuperadmin`, and Super Admin JWTs are not placed in normal user storage.
- Configure `SUPERADMIN_JWT_SECRET` in production. `JWT_SECRET` is accepted as a migration fallback, but a separate high-entropy value is preferred.

The former implementation had two competing `/superadmin/login` routers and a hard-coded signing secret. It did not create refresh sessions, while the frontend created one-off Axios clients with captured tokens. In addition, the normal user auth provider redirected every stored workspace session from `app.asystence.com` to its workspace subdomain without excluding `/superadmin`. That redirect ran before the dedicated guard could take ownership. These combined faults made routing and session behavior inconsistent.

## Credential storage and recovery

Super Admin accounts are database records in `superadmins`; no credential seed or recoverable plaintext password exists. Passwords are bcrypt hashes. Before this change there was no Super Admin reset utility.

Three recovery paths are now available:

- An authenticated Super Admin can change their password under **Settings → Security**. The current password is required and all Super Admin sessions are revoked after success.
- **Forgot password?** on `/superadmin/login` creates a random, one-hour, single-use reset link. Only the SHA-256 token hash is stored in `superadmin_password_reset_tokens`; completing the reset revokes every existing Super Admin session.
- The guarded CLI below remains the emergency recovery path when email delivery or interactive login is unavailable.

Email recovery requires `SMTP_HOST`, `SMTP_USER`, and `SMTP_PASS` in the deployed backend. The endpoint deliberately returns the same response for existing and unknown email addresses. It is rate-limited and timing-padded to reduce account enumeration.

The reset utility never accepts a password as a command-line argument and never prints it. It updates one explicitly named account, optionally bootstraps a missing account only when separately authorized, and revokes existing dedicated sessions.

For a production database, the repository database safety guard also requires `ALLOW_PRODUCTION_MIGRATION=true` and the exact `CONFIRM_PRODUCTION_MIGRATION` target token in the current shell. The guard prints that token when it refuses an unconfirmed run. Do not store either override in `.env`.

PowerShell recovery procedure:

```powershell
$env:SUPERADMIN_RESET_EMAIL = "owner@example.com"
$env:CONFIRM_SUPERADMIN_RESET = "RESET"
$secure = Read-Host "New Super Admin password" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:SUPERADMIN_RESET_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  npm run superadmin:reset
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  Remove-Item Env:SUPERADMIN_RESET_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:CONFIRM_SUPERADMIN_RESET -ErrorAction SilentlyContinue
}
```

If and only if no account exists and bootstrap creation is intended, set `SUPERADMIN_RESET_CREATE=true` for that one run. Never put the password in source, a deployment manifest, or shell history.

## Growth telemetry architecture

`growth_events` is an append-only, platform-level event stream. Browser events enter through a constrained public collector; product lifecycle events are emitted only by trusted server paths. Both use the same normalizer and asynchronous bounded batch writer.

Event identity uses a UUID primary key and `ON CONFLICT DO NOTHING`, making client retries idempotent. Browser requests are capped at 25 events and 64 KB, rate-limited, and restricted to `website.page_view` and `website.session_started`. Product actions are recorded only after a successful server response.

Core event names:

- Acquisition: `website.page_view`, `website.session_started`, `product.signup_completed`
- Activation: `product.login_attempt`, `product.login_succeeded`, `product.workspace_created`, `product.project_created`, `product.task_created`, `product.team_member_added`
- Engagement: `product.chat_message_sent`, `product.huddle_created`, `product.ai_used`, `product.attendance_signed_in`, `product.attendance_signed_out`

The dashboard API is `GET /superadmin/growth/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD`. It returns overview, daily series, acquisition dimensions, funnel, feature adoption, weekly retention, privacy-safe journey signals, and operational insights. Insights include a `generator` field so an AI provider can replace or augment `rules_v1` without changing the UI contract.

## Privacy and performance

- Passwords, message bodies, AI prompts, and private conversation content are rejected by the property allowlist.
- Referrers are reduced to hostname, page URLs are reduced to path, and country is accepted only as a coarse edge-provided code.
- IP addresses are not stored in growth telemetry. Super Admin session IPs are HMAC-hashed.
- User actions never wait for telemetry storage. The writer flushes in batches of up to 100 with a bounded queue and rate-limited failure logging.
- Date queries are capped at 366 days and use event/time, actor, workspace, and session indexes.

## Deployment and rollback

1. Set `SUPERADMIN_JWT_SECRET` to a high-entropy secret.
2. Apply `npm run migrate:superadmin-growth` using the repository database safety confirmation process.
3. Apply `npm run migrate:superadmin-password-recovery` for the additive recovery-token table.
4. Configure SMTP if email-delivered recovery links are required.
5. Deploy the backend, then the frontend.
6. Existing Super Admin access tokens are intentionally invalid after cutover; sign in through the dedicated page or use the reset utility.
7. Validate `/superadmin/me`, refresh, logout, password change/reset, `/growth/events`, and `/superadmin/growth/dashboard`.

Rollback is additive: revert application code first. The two new tables can remain dormant without affecting existing modules. Drop them only after confirming no retained telemetry or sessions are required.
