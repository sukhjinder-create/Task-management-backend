# Backup & Workspace Recovery Runbook

This project now supports:
- Full DB backups (`pg_dump` + gzip) via cron/manual trigger
- Workspace-level targeted recovery from a restored snapshot DB

## 1) Backup Reliability Settings

Set these env vars in production:

```env
BACKUP_RETENTION_DAYS=30
```

Notes:
- Backup schedule is fixed to daily at 2:00 AM (Asia/Kolkata) in app code.
- `BACKUP_RETENTION_DAYS` only controls local file pruning.
- If S3 envs are configured, backups are uploaded off-machine.

## 2) Workspace Recovery (From App)

Superadmin UI now supports:
- Trigger workspace recovery job
- Dry-run mode
- Job status/history
- Upsert behavior (existing rows are skipped/updated safely)

Route used by UI:
- `POST /superadmin/backups/recover-workspace`
- `GET /superadmin/backups/recovery-jobs`

Server-side source config:

```env
RESTORE_SOURCE_DATABASE_URL=postgres://user:pass@host:5432/restored_snapshot_db
```

You can still override source URL from UI for one-off jobs if needed.

## 3) If One Workspace Loses Data

High-level safe flow:
1. Restore latest full backup into a temporary DB.
2. Dry-run workspace recovery to validate row counts.
3. Run workspace recovery apply mode.
4. Validate workspace health in app.

### Step A: Restore snapshot into temp DB

Example:
```bash
gunzip -c backups/asystence_backup_YYYY-MM-DD_HH-MM-SS.sql.gz | psql "$TEMP_DB_URL"
```

### Step B: Dry run (no writes to prod)

```bash
RESTORE_SOURCE_DATABASE_URL="$TEMP_DB_URL" \
node run-workspace-recovery.js \
  --workspace-id <workspace_uuid> \
  --dry-run
```

### Step C: Apply restore

```bash
RESTORE_SOURCE_DATABASE_URL="$TEMP_DB_URL" \
node run-workspace-recovery.js \
  --workspace-id <workspace_uuid>
```

Optional:
```bash
npm run recover:workspace:dry -- --workspace-id <workspace_uuid> --source-url "$TEMP_DB_URL"
npm run recover:workspace -- --workspace-id <workspace_uuid> --source-url "$TEMP_DB_URL"
```

## 4) Safety Rules

- Never restore directly from backup file into production for tenant-only incidents.
- Always restore backup into a temporary DB first.
- Always run `--dry-run` before apply.
- Pause writes for that workspace during the restore window if possible.
- Keep old backups immutable; do not overwrite snapshots.

## 5) Current Limit

This is snapshot-based recovery. Data created after the latest successful snapshot is not recoverable from backup alone.
For near-zero data loss, enable PostgreSQL WAL archiving + PITR at infrastructure level.
