# Asystence Secret Rotation and Re-Provisioning Runbook

**Date:** 30 June 2026
**Purpose:** Complete the remaining operator-owned secret rotation and re-provisioning before production deployment.
**Status:** Partially completed by Codex; provider-owned secret values are still required before production rollout.

---

## 1. Why this is required

Production deployment is blocked until provider-owned secrets are rotated and re-provisioned securely.

The current release workflows have been adjusted so application credentials should be supplied to Cloud Run through Google Secret Manager using `--set-secrets`, not by injecting raw values into Cloud Run environment variables.

This runbook does not contain secret values. It lists only secret IDs, commands, and validation steps.

Already completed:

- Google Secret Manager API enabled for `asystence-backend`.
- Required Secret Manager IDs created.
- Runtime service account access granted and verified on representative secrets.
- Generated Secret Manager versions created for:
  - `JWT_SECRET`
  - `AI_SERVICE_SECRET`
  - `INTERNAL_SERVICE_SECRET`
  - `VAPID_PUBLIC_KEY`
  - `VAPID_PRIVATE_KEY`

Still required:

- Add rotated versions for the provider-owned secrets listed in section 5.2.
- Confirm the GitHub Actions deploy service account from `GCP_SA_KEY` and grant it required access if missing.

---

## 2. Required operator access

The operator needs:

1. Google Cloud project access for `asystence-backend`.
2. Permission to enable APIs.
3. Permission to create/update Secret Manager secrets.
4. Permission to grant Cloud Run runtime service account secret access.
5. GitHub repository admin access for:
   - `sukhjinder-create/Task-management-backend`
   - `sukhjinder-create/ai-task`
   - `sukhjinder-create/Task-management`
   - landing repository, if deployed from GitHub
6. Vercel project access for frontend and landing.
7. Provider access to rotate external credentials.

---

## 3. Enable Secret Manager

```powershell
gcloud services enable secretmanager.googleapis.com --project asystence-backend
```

Current status: completed.

Console location:

```text
Google Cloud Console -> APIs & Services -> Enabled APIs & services -> Secret Manager API
```

Validation command:

```powershell
gcloud services list --enabled --project asystence-backend --filter="secretmanager.googleapis.com" --format="value(config.name)"
```

Expected result:

```text
secretmanager.googleapis.com
```

---

## 4. Create or update Secret Manager secrets

Use this pattern for every remaining zero-version secret ID listed in section 5.2.

```powershell
$secretName = "SECRET_ID_HERE"
$secretValue = Read-Host "Enter rotated value for $secretName" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secretValue)
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

gcloud secrets describe $secretName --project asystence-backend *> $null
if ($LASTEXITCODE -ne 0) {
  gcloud secrets create $secretName --replication-policy="automatic" --project asystence-backend
}

$tempPath = Join-Path $env:TEMP ("asystence-secret-" + [guid]::NewGuid().ToString("N"))
Set-Content -LiteralPath $tempPath -NoNewline -Value $plain
gcloud secrets versions add $secretName --data-file=$tempPath --project asystence-backend
Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
Remove-Variable plain -ErrorAction SilentlyContinue
```

Do not paste secret values into documentation, commits, issue comments, or chat.

---

## 5. Required Google Secret Manager IDs

Backend and AI service workflows now expect these Secret Manager IDs.

| Secret ID | Used by |
|---|---|
| `DATABASE_URL` | Backend, AI service |
| `JWT_SECRET` | Backend |
| `GOOGLE_CLIENT_ID` | Backend |
| `GOOGLE_CLIENT_SECRET` | Backend |
| `STRIPE_SECRET_KEY` | Backend |
| `STRIPE_PUBLISHABLE_KEY` | Backend |
| `STRIPE_WEBHOOK_SECRET` | Backend |
| `RAZORPAY_KEY_ID` | Backend |
| `RAZORPAY_KEY_SECRET` | Backend |
| `RAZORPAY_WEBHOOK_SECRET` | Backend |
| `VAPID_PUBLIC_KEY` | Backend |
| `VAPID_PRIVATE_KEY` | Backend |
| `SLACK_WEBHOOK_URL` | Backend |
| `ATTENDANCE_SLACK_WEBHOOK_URL` | Backend |
| `AI_SERVICE_SECRET` | Backend, AI service |
| `INTERNAL_SERVICE_SECRET` | Backend, AI service |
| `ASANA_CLIENT_ID` | Backend |
| `ASANA_CLIENT_SECRET` | Backend |
| `DB_PASSWORD` | Backend, AI service |
| `GROQ_API_KEY` | Backend, AI service |
| `FIREBASE_SERVICE_ACCOUNT_B64` | Backend |
| `TURN_USERNAME` | Backend |
| `TURN_CREDENTIAL` | Backend |
| `R2_ACCOUNT_ID` | Backend |
| `AWS_ACCESS_KEY_ID` | Backend |
| `AWS_SECRET_ACCESS_KEY` | Backend |
| `SUPABASE_SERVICE_KEY` | Backend |
| `LIVEKIT_URL` | Backend |
| `LIVEKIT_API_KEY` | Backend |
| `LIVEKIT_API_SECRET` | Backend |
| `DEEPGRAM_API_KEY` | Backend |

### 5.1 Secret IDs already provisioned with versions

These have 1 Secret Manager version as of the latest validation:

```text
AI_SERVICE_SECRET
DATABASE_URL
DB_PASSWORD
GROQ_API_KEY
INTERNAL_SERVICE_SECRET
JWT_SECRET
VAPID_PRIVATE_KEY
VAPID_PUBLIC_KEY
```

`DATABASE_URL`, `DB_PASSWORD`, and `GROQ_API_KEY` were provisioned by copying the current live backend values into Secret Manager after operator authorization. They are usable for AI service deployment, but this does not count as provider credential rotation.

Do not replace the generated secrets unless you intentionally want another rotation. Rotate the copied provider credentials later if strict credential rotation is required.

### 5.2 Secret IDs still requiring provider/operator values

These have 0 Secret Manager versions as of the latest validation:

```text
ASANA_CLIENT_ID
ASANA_CLIENT_SECRET
ATTENDANCE_SLACK_WEBHOOK_URL
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
DEEPGRAM_API_KEY
FIREBASE_SERVICE_ACCOUNT_B64
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
LIVEKIT_URL
R2_ACCOUNT_ID
RAZORPAY_KEY_ID
RAZORPAY_KEY_SECRET
RAZORPAY_WEBHOOK_SECRET
SLACK_WEBHOOK_URL
STRIPE_PUBLISHABLE_KEY
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
SUPABASE_SERVICE_KEY
TURN_CREDENTIAL
TURN_USERNAME
```

Console location:

```text
Google Cloud Console -> Security -> Secret Manager -> select secret -> Versions -> Add new version
```

Validation command for one secret:

```powershell
gcloud secrets versions list DATABASE_URL --project asystence-backend --format="table(name,state,createTime)"
```

Expected result:

- At least one `ENABLED` version exists.
- Secret value is not displayed.

### 5.3 Provider-owned secret action matrix

For every row below, use the same safe upload pattern from section 4. Do not paste values into command history, documentation, chat, tickets, or commits.

Rollback pattern for any incorrect secret version:

```powershell
gcloud secrets versions disable latest --secret=SECRET_ID --project asystence-backend
```

| Secret | Reason | Provider / source | Where value comes from | Secret Manager command | Validation command | Rollback |
|---|---|---|---|---|---|---|
| `DATABASE_URL` | Backend and AI database connection. | Supabase PostgreSQL | Supabase project database connection string; use rotated DB password. | `gcloud secrets versions add DATABASE_URL --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list DATABASE_URL --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=DATABASE_URL --project asystence-backend` |
| `DB_PASSWORD` | Non-URL DB fallback and AI service DB config. | Supabase PostgreSQL | Rotated database password. | `gcloud secrets versions add DB_PASSWORD --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list DB_PASSWORD --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=DB_PASSWORD --project asystence-backend` |
| `GOOGLE_CLIENT_ID` | Google OAuth login. | Google Cloud OAuth consent / credentials | OAuth 2.0 web client ID. | `gcloud secrets versions add GOOGLE_CLIENT_ID --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list GOOGLE_CLIENT_ID --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=GOOGLE_CLIENT_ID --project asystence-backend` |
| `GOOGLE_CLIENT_SECRET` | Google OAuth login. | Google Cloud OAuth consent / credentials | Rotated OAuth 2.0 web client secret. | `gcloud secrets versions add GOOGLE_CLIENT_SECRET --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list GOOGLE_CLIENT_SECRET --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=GOOGLE_CLIENT_SECRET --project asystence-backend` |
| `STRIPE_SECRET_KEY` | Stripe server-side billing. | Stripe dashboard | Live restricted/secret key. | `gcloud secrets versions add STRIPE_SECRET_KEY --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list STRIPE_SECRET_KEY --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=STRIPE_SECRET_KEY --project asystence-backend` |
| `STRIPE_PUBLISHABLE_KEY` | Stripe client billing flow. | Stripe dashboard | Live publishable key. | `gcloud secrets versions add STRIPE_PUBLISHABLE_KEY --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list STRIPE_PUBLISHABLE_KEY --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=STRIPE_PUBLISHABLE_KEY --project asystence-backend` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook verification. | Stripe dashboard webhook endpoint | Signing secret for production webhook endpoint. | `gcloud secrets versions add STRIPE_WEBHOOK_SECRET --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list STRIPE_WEBHOOK_SECRET --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=STRIPE_WEBHOOK_SECRET --project asystence-backend` |
| `RAZORPAY_KEY_ID` | Razorpay billing. | Razorpay dashboard | Live key ID. | `gcloud secrets versions add RAZORPAY_KEY_ID --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list RAZORPAY_KEY_ID --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=RAZORPAY_KEY_ID --project asystence-backend` |
| `RAZORPAY_KEY_SECRET` | Razorpay billing. | Razorpay dashboard | Rotated live key secret. | `gcloud secrets versions add RAZORPAY_KEY_SECRET --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list RAZORPAY_KEY_SECRET --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=RAZORPAY_KEY_SECRET --project asystence-backend` |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay webhook verification. | Razorpay dashboard webhook endpoint | Webhook signing secret. | `gcloud secrets versions add RAZORPAY_WEBHOOK_SECRET --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list RAZORPAY_WEBHOOK_SECRET --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=RAZORPAY_WEBHOOK_SECRET --project asystence-backend` |
| `SLACK_WEBHOOK_URL` | Slack notification integration. | Slack app / incoming webhook | Rotated incoming webhook URL. | `gcloud secrets versions add SLACK_WEBHOOK_URL --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list SLACK_WEBHOOK_URL --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=SLACK_WEBHOOK_URL --project asystence-backend` |
| `ATTENDANCE_SLACK_WEBHOOK_URL` | Attendance Slack alerts. | Slack app / incoming webhook | Rotated attendance webhook URL. | `gcloud secrets versions add ATTENDANCE_SLACK_WEBHOOK_URL --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list ATTENDANCE_SLACK_WEBHOOK_URL --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=ATTENDANCE_SLACK_WEBHOOK_URL --project asystence-backend` |
| `ASANA_CLIENT_ID` | Asana OAuth integration. | Asana developer console | OAuth client ID. | `gcloud secrets versions add ASANA_CLIENT_ID --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list ASANA_CLIENT_ID --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=ASANA_CLIENT_ID --project asystence-backend` |
| `ASANA_CLIENT_SECRET` | Asana OAuth integration. | Asana developer console | Rotated OAuth client secret. | `gcloud secrets versions add ASANA_CLIENT_SECRET --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list ASANA_CLIENT_SECRET --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=ASANA_CLIENT_SECRET --project asystence-backend` |
| `GROQ_API_KEY` | AI service LLM provider. | Groq console | Rotated production API key. | `gcloud secrets versions add GROQ_API_KEY --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list GROQ_API_KEY --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=GROQ_API_KEY --project asystence-backend` |
| `FIREBASE_SERVICE_ACCOUNT_B64` | FCM push notifications. | Firebase / Google Cloud IAM service account | Base64-encoded service-account JSON for Firebase Admin. | `gcloud secrets versions add FIREBASE_SERVICE_ACCOUNT_B64 --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list FIREBASE_SERVICE_ACCOUNT_B64 --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=FIREBASE_SERVICE_ACCOUNT_B64 --project asystence-backend` |
| `TURN_USERNAME` | WebRTC TURN fallback. | TURN provider / infrastructure | TURN username. | `gcloud secrets versions add TURN_USERNAME --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list TURN_USERNAME --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=TURN_USERNAME --project asystence-backend` |
| `TURN_CREDENTIAL` | WebRTC TURN fallback. | TURN provider / infrastructure | TURN credential/password. | `gcloud secrets versions add TURN_CREDENTIAL --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list TURN_CREDENTIAL --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=TURN_CREDENTIAL --project asystence-backend` |
| `R2_ACCOUNT_ID` | Cloudflare R2 object storage. | Cloudflare dashboard | R2 account ID. | `gcloud secrets versions add R2_ACCOUNT_ID --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list R2_ACCOUNT_ID --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=R2_ACCOUNT_ID --project asystence-backend` |
| `AWS_ACCESS_KEY_ID` | R2/S3-compatible storage access. | Cloudflare R2 or AWS IAM | Rotated access key ID. | `gcloud secrets versions add AWS_ACCESS_KEY_ID --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list AWS_ACCESS_KEY_ID --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=AWS_ACCESS_KEY_ID --project asystence-backend` |
| `AWS_SECRET_ACCESS_KEY` | R2/S3-compatible storage access. | Cloudflare R2 or AWS IAM | Rotated secret access key. | `gcloud secrets versions add AWS_SECRET_ACCESS_KEY --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list AWS_SECRET_ACCESS_KEY --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=AWS_SECRET_ACCESS_KEY --project asystence-backend` |
| `SUPABASE_SERVICE_KEY` | Supabase privileged service operations. | Supabase project API settings | Rotated service-role key. | `gcloud secrets versions add SUPABASE_SERVICE_KEY --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list SUPABASE_SERVICE_KEY --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=SUPABASE_SERVICE_KEY --project asystence-backend` |
| `LIVEKIT_URL` | Huddles/live media. | LiveKit Cloud or self-hosted LiveKit | Production LiveKit server URL. | `gcloud secrets versions add LIVEKIT_URL --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list LIVEKIT_URL --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=LIVEKIT_URL --project asystence-backend` |
| `LIVEKIT_API_KEY` | Huddles/live media token generation. | LiveKit Cloud or self-hosted LiveKit | API key. | `gcloud secrets versions add LIVEKIT_API_KEY --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list LIVEKIT_API_KEY --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=LIVEKIT_API_KEY --project asystence-backend` |
| `LIVEKIT_API_SECRET` | Huddles/live media token generation. | LiveKit Cloud or self-hosted LiveKit | Rotated API secret. | `gcloud secrets versions add LIVEKIT_API_SECRET --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list LIVEKIT_API_SECRET --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=LIVEKIT_API_SECRET --project asystence-backend` |
| `DEEPGRAM_API_KEY` | Meeting transcription/intelligence. | Deepgram console | Rotated production API key. | `gcloud secrets versions add DEEPGRAM_API_KEY --data-file=<temp-file> --project asystence-backend` | `gcloud secrets versions list DEEPGRAM_API_KEY --project asystence-backend --format="table(name,state)"` | `gcloud secrets versions disable latest --secret=DEEPGRAM_API_KEY --project asystence-backend` |

---

## 6. Grant deployer and Cloud Run runtime access to secrets

The current Cloud Run services use the default compute service account.

Runtime service account access has already been applied for the required secret IDs. The remaining unknown is the GitHub Actions deploy service account because `GCP_SA_KEY` cannot be inspected from this machine.

Grant secret access:

```powershell
$serviceAccount = "616077735050-compute@developer.gserviceaccount.com"
$githubDeployServiceAccount = "REPLACE_WITH_GCP_SA_KEY_CLIENT_EMAIL"

$secrets = @(
  "DATABASE_URL",
  "JWT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "SLACK_WEBHOOK_URL",
  "ATTENDANCE_SLACK_WEBHOOK_URL",
  "AI_SERVICE_SECRET",
  "INTERNAL_SERVICE_SECRET",
  "ASANA_CLIENT_ID",
  "ASANA_CLIENT_SECRET",
  "DB_PASSWORD",
  "GROQ_API_KEY",
  "FIREBASE_SERVICE_ACCOUNT_B64",
  "TURN_USERNAME",
  "TURN_CREDENTIAL",
  "R2_ACCOUNT_ID",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "SUPABASE_SERVICE_KEY",
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "DEEPGRAM_API_KEY"
)

foreach ($secret in $secrets) {
  gcloud secrets add-iam-policy-binding $secret `
    --member="serviceAccount:$serviceAccount" `
    --role="roles/secretmanager.secretAccessor" `
    --project asystence-backend

  gcloud secrets add-iam-policy-binding $secret `
    --member="serviceAccount:$githubDeployServiceAccount" `
    --role="roles/secretmanager.secretAccessor" `
    --project asystence-backend
}
```

`$githubDeployServiceAccount` should be the `client_email` inside the `GCP_SA_KEY` GitHub secret used by the deployment workflows.

Console location:

```text
GitHub repo -> Settings -> Secrets and variables -> Actions -> GCP_SA_KEY
Google Cloud Console -> IAM & Admin -> IAM
```

Validation command for runtime access:

```powershell
$runtimeSa = "serviceAccount:616077735050-compute@developer.gserviceaccount.com"
gcloud secrets get-iam-policy DATABASE_URL `
  --project asystence-backend `
  --flatten="bindings[].members" `
  --filter="bindings.role:roles/secretmanager.secretAccessor AND bindings.members:$runtimeSa" `
  --format="value(bindings.role)"
```

Expected result:

```text
roles/secretmanager.secretAccessor
```

Rollback:

```powershell
gcloud secrets remove-iam-policy-binding DATABASE_URL `
  --member="serviceAccount:ACCOUNT_TO_REMOVE" `
  --role="roles/secretmanager.secretAccessor" `
  --project asystence-backend
```

---

## 7. Required GitHub Secrets

After switching Cloud Run application credentials to Secret Manager, GitHub Actions should only need deployment credentials and any non-Cloud-Run deployment secrets.

Backend repo:

| GitHub Secret | Purpose |
|---|---|
| `GCP_SA_KEY` | Authenticate GitHub Actions to Google Cloud. |

AI service repo:

| GitHub Secret | Purpose |
|---|---|
| `GCP_SA_KEY` | Authenticate GitHub Actions to Google Cloud. |

Set or rotate:

```powershell
gh secret set GCP_SA_KEY --repo sukhjinder-create/Task-management-backend
gh secret set GCP_SA_KEY --repo sukhjinder-create/ai-task
```

If `gh` is not installed or authenticated, install GitHub CLI and run:

```powershell
gh auth login
gh auth status
```

---

## 8. Verify no raw secrets are deployed as Cloud Run env values

After deployment, use:

```powershell
gcloud run services describe asystence-api `
  --region asia-south1 `
  --project asystence-backend `
  --format="json(spec.template.spec.containers[0].env)"

gcloud run services describe asystence-ai `
  --region asia-south1 `
  --project asystence-backend `
  --format="json(spec.template.spec.containers[0].env)"
```

Expected result:

- Secret-backed env vars should have `valueFrom.secretKeyRef`.
- Raw credential values should not appear under `value`.

---

## 9. Verify workflows use Secret Manager

Backend workflow should include:

```text
--set-secrets="$SECRET_ENV_VARS"
```

AI workflow should include:

```text
--set-secrets="$SECRET_ENV_VARS"
```

Do not deploy if workflows pass provider credentials through `--update-env-vars` or `--set-env-vars`.

---

## 10. Post-rotation deploy sequence

After all secrets are rotated and provisioned:

1. Run local validation.
2. Commit intended release files only.
3. Push backend.
4. Wait for Cloud Run backend revision to become ready.
5. Verify backend env uses secret refs.
6. Push AI service.
7. Wait for Cloud Run AI revision to become ready.
8. Verify AI env uses secret refs.
9. Deploy frontend.
10. Deploy landing only if required.
11. Run authenticated production certification.

Do not enable `ADAPTIVE_RUNTIME_WORKER_ENABLED=true` until canary validation passes.
