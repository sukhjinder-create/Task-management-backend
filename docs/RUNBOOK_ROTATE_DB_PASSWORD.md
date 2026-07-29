# Runbook — Rotate the Supabase database password

**Risk:** medium — the application cannot reach the database between the password
change and the environment update. Expect roughly **1–3 minutes of downtime**.
**Do this at a low-traffic time.**

## Why

The current production password has existed since before the July 2026 migration
and is present in more places than it should be (a plaintext file on a laptop,
CI secrets, chat history). Rotating invalidates every stale copy at once.

## Before you start

- [ ] Confirm a recent successful backup exists (see the last row):
      `SELECT status, storage_type, started_at FROM backup_logs ORDER BY started_at DESC LIMIT 3;`
- [ ] Have SSH access to the server ready and working.
- [ ] Note the current commit so nothing else changes mid-rotation.

## Steps

### 1. Generate the new password in Supabase

Dashboard → **Project Settings → Database → Database password → Reset password**.
Copy the new password immediately; it is shown only once.

> Supabase applies this instantly. From this moment the app is down until step 3.

### 2. Build the two new connection strings

Both point at the same pooler host, but different ports and modes:

```
# Application — TRANSACTION mode (high concurrency)
DATABASE_URL=postgresql://postgres.<PROJECT_REF>:<NEW_PASSWORD>@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres

# Backups — SESSION mode (pg_dump needs a consistent snapshot)
BACKUP_DATABASE_URL=postgresql://postgres.<PROJECT_REF>:<NEW_PASSWORD>@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres
```

If the password contains `@ : / ? # [ ] %`, URL-encode it (e.g. `@` → `%40`).

### 3. Update the server and restart

```bash
ssh -i ~/.ssh/oracle_asystence ubuntu@130.210.47.17

# Keep a rollback copy of the current env
cp ~/app/.env ~/app/.env.bak-$(date +%s)

# Update both URLs (use your editor of choice)
nano ~/app/.env      # replace DATABASE_URL and BACKUP_DATABASE_URL
nano ~/ai-task/.env  # replace DATABASE_URL (ai-task uses the app database too)

chmod 600 ~/app/.env ~/ai-task/.env

sudo docker compose -f ~/app/docker-compose.prod.yml up -d --force-recreate app
sudo docker compose -f ~/ai-task/docker-compose.prod.yml up -d --force-recreate ai-task
```

### 4. Verify (all four must pass)

```bash
# App is live
curl -s https://api.asystence.com/livez

# Database is actually reachable (not just the process running)
sudo docker exec app-app-1 node -e "import('./db.js').then(async ({default:p})=>{await p.query('select 1');console.log('DB OK');process.exit(0)}).catch(e=>{console.log('DB FAIL',e.message);process.exit(1)})"

# Login path works end to end (401 = reached the DB and rejected bad creds)
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.asystence.com/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"x@y.z","password":"wrong"}'

# Backups still work on the session-mode connection
sudo docker exec app-app-1 sh -c 'pg_dump --schema-only --no-password "$BACKUP_DATABASE_URL" | head -3'
```

### 5. Update the other copies

- [ ] GitHub repository secrets: `DATABASE_URL`, `DB_PASSWORD`
- [ ] Delete or re-encrypt `Desktop/task_m/envvars-deploy.yaml`
- [ ] Remove the `.env.bak-*` rollback copy once verified

## Rollback

If verification fails and the cause isn't obvious, restore the previous env and
restart — then reset the Supabase password back, or retry the rotation:

```bash
cp ~/app/.env.bak-<timestamp> ~/app/.env
sudo docker compose -f ~/app/docker-compose.prod.yml up -d --force-recreate app
```

Note this only helps if the *old* password still works; once Supabase has been
reset, the real fix is to correct the new connection string. The most common
failure is an un-encoded special character in the password.
