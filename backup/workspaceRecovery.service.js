import pg from "pg";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { createReadStream, existsSync, statSync } from "fs";
import { Transform } from "stream";
import { createGunzip } from "zlib";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../db.js";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_HOST = process.env.DB_HOST || "localhost";
const DB_PORT = Number(process.env.DB_PORT || 5432);
const DB_USER = process.env.DB_USER || "postgres";
const DB_PASSWORD = process.env.DB_PASSWORD || "";
const DB_NAME = process.env.DB_NAME || "postgres";
const DB_ADMIN_DATABASE = process.env.BACKUP_RESTORE_ADMIN_DB || "postgres";
const MANAGED_SNAPSHOT_DB = (
  process.env.RESTORE_MANAGED_SNAPSHOT_DB ||
  `${DB_NAME}_snapshot`
).slice(0, 63);
const RECOVERY_HEARTBEAT_TIMEOUT_MINUTES = Math.max(
  1,
  Number(process.env.RECOVERY_HEARTBEAT_TIMEOUT_MINUTES || 5)
);
const BACKUP_DIR = process.env.BACKUP_LOCAL_DIR
  ? path.resolve(process.env.BACKUP_LOCAL_DIR)
  : path.join(__dirname, "..", "backups");

const TABLE_PLAN = [
  { table: "workspaces", where: "id = $1" },
  { table: "users", where: "workspace_id = $1" },
  { table: "workspace_users", where: "workspace_id = $1" },
  { table: "projects", where: "workspace_id = $1" },
  { table: "project_ticket_sequences", where: "workspace_id = $1" },
  { table: "sprints", where: "workspace_id = $1" },
  { table: "tasks", where: "workspace_id = $1" },
  { table: "task_attachments", where: "task_id IN (SELECT id FROM tasks WHERE workspace_id = $1)" },
  { table: "task_activity_logs", where: "workspace_id = $1" },
  { table: "chat_channels", where: "workspace_id = $1" },
  { table: "chat_channel_members", where: "workspace_id = $1" },
  { table: "chat_channel_admins", where: "workspace_id = $1" },
  { table: "chat_messages", where: "workspace_id = $1" },
  { table: "wiki_spaces", where: "workspace_id = $1" },
  { table: "wiki_pages", where: "space_id IN (SELECT id FROM wiki_spaces WHERE workspace_id = $1)" },
  {
    table: "wiki_page_versions",
    where: "page_id IN (SELECT wp.id FROM wiki_pages wp JOIN wiki_spaces ws ON ws.id = wp.space_id WHERE ws.workspace_id = $1)",
  },
  { table: "okr_objectives", where: "workspace_id = $1" },
  { table: "okr_key_results", where: "objective_id IN (SELECT id FROM okr_objectives WHERE workspace_id = $1)" },
  { table: "review_cycles", where: "workspace_id = $1" },
  { table: "performance_reviews", where: "cycle_id IN (SELECT id FROM review_cycles WHERE workspace_id = $1)" },
  { table: "leave_types", where: "workspace_id = $1" },
  { table: "leave_requests", where: "workspace_id = $1" },
  { table: "leave_balances", where: "workspace_id = $1" },
  { table: "attendance_daily", where: "workspace_id = $1" },
  { table: "tags", where: "workspace_id = $1" },
  { table: "task_tag_assignments", where: "task_id IN (SELECT id FROM tasks WHERE workspace_id = $1)" },
  { table: "task_links", where: "workspace_id = $1" },
  { table: "time_logs", where: "workspace_id = $1" },
  { table: "task_watchers", where: "workspace_id = $1" },
  { table: "task_votes", where: "workspace_id = $1" },
  { table: "issue_templates", where: "workspace_id = $1" },
  { table: "saved_filters", where: "workspace_id = $1" },
  { table: "task_assignees", where: "workspace_id = $1" },
  { table: "workspace_ai_settings", where: "workspace_id = $1" },
  { table: "ai_memory", where: "workspace_id = $1" },
  { table: "ai_decision_provenance", where: "workspace_id = $1" },
  { table: "autopilot_settings", where: "workspace_id = $1" },
  { table: "autopilot_actions", where: "workspace_id = $1" },
  { table: "autopilot_decisions", where: "workspace_id = $1" },
  { table: "testing_agent_settings", where: "workspace_id = $1" },
  { table: "testing_agent_runs", where: "workspace_id = $1" },
  { table: "testing_agent_project_profiles", where: "workspace_id = $1" },
  { table: "workspace_memory_entries", where: "workspace_id = $1" },
  { table: "operations_ai_actions", where: "workspace_id = $1" },
  { table: "operations_ai_action_decisions", where: "workspace_id = $1" },
  { table: "workspace_digest_preferences", where: "workspace_id = $1" },
  { table: "workspace_digest_runs", where: "workspace_id = $1" },
  { table: "operations_automation_rules", where: "workspace_id = $1" },
  { table: "workspace_search_history", where: "workspace_id = $1" },
  { table: "workspace_search_click_history", where: "workspace_id = $1" },
  { table: "payment_customers", where: "workspace_id = $1" },
  { table: "workspace_subscriptions", where: "workspace_id = $1" },
  { table: "payment_checkout_sessions", where: "workspace_id = $1" },
  { table: "user_activation_payments", where: "workspace_id = $1" },
  { table: "workspace_sso_configs", where: "workspace_id = $1" },
  { table: "api_keys", where: "workspace_id = $1" },
  { table: "webhooks", where: "workspace_id = $1" },
  { table: "webhook_deliveries", where: "webhook_id IN (SELECT id FROM webhooks WHERE workspace_id = $1)" },
  { table: "workspace_work_schedule", where: "workspace_id = $1" },
  { table: "workspace_holidays", where: "workspace_id = $1" },
  { table: "gdpr_erasure_requests", where: "workspace_id = $1" },
  { table: "trial_ip_log", where: "workspace_id = $1" },
  { table: "migration_imports", where: "workspace_id = $1" },
  { table: "gdpr_consents", where: "user_id IN (SELECT id FROM users WHERE workspace_id = $1)" },
  { table: "user_sessions", where: "user_id IN (SELECT id FROM users WHERE workspace_id = $1)" },
  { table: "magic_link_tokens", where: "user_id IN (SELECT id FROM users WHERE workspace_id = $1)" },
  { table: "password_reset_tokens", where: "user_id IN (SELECT id FROM users WHERE workspace_id = $1)" },
];

let recoveryJobsReady = false;
let recoveryJobsInitPromise = null;

function qIdent(name) {
  return `"${String(name).replace(/"/g, "\"\"")}"`;
}

function maskSourceUrl(urlValue) {
  try {
    const url = new URL(urlValue);
    const dbName = url.pathname?.replace(/^\//, "") || "db";
    return `${url.hostname}/${dbName}`;
  } catch {
    return "custom-source";
  }
}

function getPoolConfig(database) {
  return {
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database,
  };
}

function buildDatabaseUrl(database) {
  const user = encodeURIComponent(DB_USER);
  const pass = encodeURIComponent(DB_PASSWORD);
  const host = DB_HOST;
  const port = String(DB_PORT);
  const db = encodeURIComponent(database);
  return `postgresql://${user}:${pass}@${host}:${port}/${db}`;
}

async function ensureDatabaseExists(database) {
  const adminPool = new Pool(getPoolConfig(DB_ADMIN_DATABASE));
  let client = null;
  try {
    client = await adminPool.connect();
    const { rows } = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1 LIMIT 1`,
      [database]
    );
    if (rows.length === 0) {
      await client.query(`CREATE DATABASE ${qIdent(database)}`);
    }
  } finally {
    if (client) client.release();
    await adminPool.end().catch(() => {});
  }
}

async function resetDatabasePublicSchema(database) {
  const snapshotPool = new Pool(getPoolConfig(database));
  try {
    await snapshotPool.query(`DROP SCHEMA IF EXISTS public CASCADE`);
    await snapshotPool.query(`CREATE SCHEMA public`);
  } finally {
    await snapshotPool.end().catch(() => {});
  }
}

function isPublicSchemaOwnershipError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("must be owner of schema public");
}

function buildManagedSnapshotDbName() {
  const suffix = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const name = `${MANAGED_SNAPSHOT_DB}_${suffix}`;
  return name.slice(0, 63);
}

function restoreGzipSqlToDatabase({ gzipFilePath, database, onProgress = null }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PGPASSWORD: DB_PASSWORD };
    const psql = spawn(
      "psql",
      [
        "-h", DB_HOST,
        "-p", String(DB_PORT),
        "-U", DB_USER,
        "-d", database,
        "-v", "ON_ERROR_STOP=1",
        "-q",
      ],
      { env }
    );

    let stderrOut = "";
    let done = false;
    let input = null;
    let gunzip = null;
    let compatFilter = null;
    let processedBytes = 0;
    let lastProgressAt = 0;
    const totalBytes = (() => {
      try { return statSync(gzipFilePath).size || 0; } catch { return 0; }
    })();

    const emitProgress = (force = false) => {
      if (!onProgress) return;
      const now = Date.now();
      if (!force && now - lastProgressAt < 1500) return;
      lastProgressAt = now;
      Promise.resolve(onProgress({
        processedBytes,
        totalBytes,
      })).catch(() => {});
    };
    const cleanup = () => {
      try { if (input && gunzip) input.unpipe(gunzip); } catch {}
      try { if (gunzip && compatFilter) gunzip.unpipe(compatFilter); } catch {}
      try { if (compatFilter) compatFilter.unpipe(psql.stdin); } catch {}
      try { if (input) input.destroy(); } catch {}
      try { if (gunzip) gunzip.destroy(); } catch {}
      try { if (compatFilter) compatFilter.destroy(); } catch {}
      try { psql.stdin.end(); } catch {}
    };
    const fail = (err) => {
      if (done) return;
      done = true;
      cleanup();
      try { psql.kill("SIGTERM"); } catch {}
      reject(err);
    };

    psql.stderr.on("data", (d) => { stderrOut += d.toString(); });
    psql.on("error", (err) => {
      fail(new Error(`psql not found: ${err.message}. Install PostgreSQL client tools on server.`));
    });

    input = createReadStream(gzipFilePath);
    gunzip = createGunzip();
    compatFilter = createSqlCompatibilityFilter();

    input.on("data", (chunk) => {
      processedBytes += chunk?.length || 0;
      emitProgress(false);
    });

    input.on("error", (err) => fail(new Error(`Failed to read backup file: ${err.message}`)));
    gunzip.on("error", (err) => fail(new Error(`Failed to decompress backup file: ${err.message}`)));
    psql.stdin.on("error", (err) => {
      // psql may terminate early on SQL errors; writes after that raise EPIPE.
      // We handle final outcome from psql close event to avoid crashing Node.
      if (err?.code === "EPIPE") return;
      fail(new Error(`psql stdin error: ${err.message}`));
    });

    psql.on("close", (code) => {
      if (done) return;
      done = true;
       cleanup();
      emitProgress(true);
      if (code === 0) return resolve();
      reject(new Error(`psql restore failed with code ${code}: ${stderrOut || "unknown error"}`));
    });

    input.pipe(gunzip).pipe(compatFilter).pipe(psql.stdin);
  });
}

function createSqlCompatibilityFilter() {
  let buffer = "";
  return new Transform({
    transform(chunk, _enc, cb) {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      const out = [];
      for (const line of lines) {
        if (/^\s*SET\s+transaction_timeout\s*=.+;?\s*$/i.test(line)) continue;
        out.push(line);
      }
      cb(null, out.length ? `${out.join("\n")}\n` : "");
    },
    flush(cb) {
      if (buffer) {
        if (!/^\s*SET\s+transaction_timeout\s*=.+;?\s*$/i.test(buffer)) {
          this.push(buffer);
        }
      }
      cb();
    },
  });
}

async function getLatestSuccessfulBackupRow() {
  try {
    const { rows } = await pool.query(
      `SELECT *
         FROM backup_logs
        WHERE status = 'success'
        ORDER BY completed_at DESC NULLS LAST, started_at DESC
        LIMIT 1`
    );
    return rows[0] || null;
  } catch (err) {
    if (err?.code === "42P01") return null; // backup_logs table missing
    throw err;
  }
}

function resolveLocalBackupPath(latestBackup) {
  if (!latestBackup) return null;
  const candidates = [];
  if (latestBackup.storage_type === "local" && latestBackup.storage_path) {
    candidates.push(String(latestBackup.storage_path));
  }
  if (latestBackup.file_name) {
    candidates.push(path.join(BACKUP_DIR, String(latestBackup.file_name)));
  }
  return candidates.find((p) => existsSync(p)) || null;
}

async function buildManagedSnapshotSource({ onStatus }) {
  const send = async (payload) => {
    if (!onStatus) return;
    try { await onStatus(payload); } catch {}
  };

  const latestBackup = await getLatestSuccessfulBackupRow();
  const localBackupPath = resolveLocalBackupPath(latestBackup);
  if (!latestBackup || !localBackupPath) {
    throw new Error(
      "No usable local successful backup found for auto-recovery. Run a successful backup first, or configure RESTORE_SOURCE_DATABASE_URL."
    );
  }

  let snapshotDb = MANAGED_SNAPSHOT_DB;
  await send({ message: `Preparing managed snapshot from ${latestBackup.file_name || "latest backup"}...` });
  await ensureDatabaseExists(snapshotDb);
  await send({ message: `Resetting snapshot database ${snapshotDb}...` });
  try {
    await resetDatabasePublicSchema(snapshotDb);
  } catch (err) {
    if (!isPublicSchemaOwnershipError(err)) throw err;
    snapshotDb = buildManagedSnapshotDbName();
    await send({
      message: `Cannot reset existing snapshot DB due permissions. Creating fresh snapshot DB ${snapshotDb}...`,
    });
    await ensureDatabaseExists(snapshotDb);
  }

  await send({ message: "Restoring latest backup into managed snapshot database..." });
  await restoreGzipSqlToDatabase({
    gzipFilePath: localBackupPath,
    database: snapshotDb,
    onProgress: ({ processedBytes, totalBytes }) => {
      const processedMb = (processedBytes / 1024 / 1024).toFixed(1);
      const totalMb = totalBytes > 0 ? (totalBytes / 1024 / 1024).toFixed(1) : null;
      const rawPct = totalBytes > 0 ? (processedBytes / totalBytes) * 100 : null;
      return send({
        message: totalMb
          ? `Restoring latest backup... ${processedMb}/${totalMb} MB`
          : `Restoring latest backup... ${processedMb} MB`,
        restorePct: rawPct == null ? null : Math.max(0, Math.min(100, rawPct)),
      });
    },
  });
  await send({ message: `Managed snapshot is ready (${snapshotDb}).`, restorePct: 100 });

  return {
    sourceDatabaseUrl: buildDatabaseUrl(snapshotDb),
    sourceLabel: `managed:${snapshotDb}`,
  };
}

export async function ensureRecoveryJobsTable() {
  if (recoveryJobsReady) return;
  if (recoveryJobsInitPromise) {
    await recoveryJobsInitPromise;
    return;
  }

  recoveryJobsInitPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS workspace_recovery_jobs (
        id              UUID PRIMARY KEY,
        workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        status          TEXT NOT NULL CHECK (status IN ('pending','running','success','failed')),
        requested_by    TEXT,
        dry_run         BOOLEAN NOT NULL DEFAULT false,
        batch_size      INT NOT NULL DEFAULT 500,
        source_label    TEXT,
        rows_scanned    BIGINT NOT NULL DEFAULT 0,
        rows_written    BIGINT NOT NULL DEFAULT 0,
        table_summary   JSONB NOT NULL DEFAULT '[]'::jsonb,
        progress_pct    NUMERIC(6,2) NOT NULL DEFAULT 0,
        current_table   TEXT,
        progress_message TEXT,
        event_log       JSONB NOT NULL DEFAULT '[]'::jsonb,
        error_message   TEXT,
        started_at      TIMESTAMPTZ,
        completed_at    TIMESTAMPTZ,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`
      ALTER TABLE workspace_recovery_jobs
      ADD COLUMN IF NOT EXISTS progress_pct NUMERIC(6,2) NOT NULL DEFAULT 0;
    `);
    await pool.query(`
      ALTER TABLE workspace_recovery_jobs
      ADD COLUMN IF NOT EXISTS current_table TEXT;
    `);
    await pool.query(`
      ALTER TABLE workspace_recovery_jobs
      ADD COLUMN IF NOT EXISTS progress_message TEXT;
    `);
    await pool.query(`
      ALTER TABLE workspace_recovery_jobs
      ADD COLUMN IF NOT EXISTS event_log JSONB NOT NULL DEFAULT '[]'::jsonb;
    `);
    await pool.query(`
      ALTER TABLE workspace_recovery_jobs
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_workspace_recovery_jobs_workspace_created
      ON workspace_recovery_jobs(workspace_id, created_at DESC);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_workspace_recovery_jobs_status_created
      ON workspace_recovery_jobs(status, created_at DESC);
    `);
    recoveryJobsReady = true;
  })();

  try {
    await recoveryJobsInitPromise;
  } finally {
    recoveryJobsInitPromise = null;
  }
}

async function markStaleRecoveryJobsAsFailed() {
  await ensureRecoveryJobsTable();
  const timeout = Math.max(1, RECOVERY_HEARTBEAT_TIMEOUT_MINUTES);
  const { rowCount } = await pool.query(
    `UPDATE workspace_recovery_jobs
        SET status = 'failed',
            error_message = COALESCE(
              error_message,
              'Recovery job marked failed automatically (worker stopped before completion).'
            ),
            progress_message = COALESCE(
              progress_message,
              'Marked failed automatically after stale heartbeat.'
            ),
            completed_at = COALESCE(completed_at, now()),
            updated_at = now()
      WHERE status IN ('pending', 'running')
        AND completed_at IS NULL
        AND updated_at < now() - ($1::int * interval '1 minute')`,
    [timeout]
  );
  if (rowCount > 0) {
    console.warn(
      `[recovery] Marked ${rowCount} stale recovery job(s) as failed (>${timeout} min without heartbeat).`
    );
  }
}

async function tableExists(client, table) {
  const { rows } = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS ok`,
    [table]
  );
  return !!rows[0]?.ok;
}

async function getColumns(client, table) {
  const { rows } = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table]
  );
  return rows.map((r) => r.column_name);
}

async function getPrimaryKeyColumns(client, table) {
  const { rows } = await client.query(
    `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name = $1
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position`,
    [table]
  );
  return rows.map((r) => r.column_name);
}

function buildUpsertSql(table, columns, pkColumns, rowCount) {
  const qTable = qIdent(table);
  const qCols = columns.map(qIdent);
  const valuesSql = [];
  let p = 1;
  for (let r = 0; r < rowCount; r += 1) {
    const rowParams = [];
    for (let c = 0; c < columns.length; c += 1) rowParams.push(`$${p++}`);
    valuesSql.push(`(${rowParams.join(", ")})`);
  }

  let sql = `INSERT INTO ${qTable} (${qCols.join(", ")}) VALUES ${valuesSql.join(", ")}`;
  const usablePk = pkColumns.filter((pk) => columns.includes(pk));

  if (usablePk.length > 0) {
    const nonPk = columns.filter((c) => !usablePk.includes(c));
    if (nonPk.length > 0) {
      sql += ` ON CONFLICT (${usablePk.map(qIdent).join(", ")}) DO UPDATE SET ${
        nonPk.map((c) => `${qIdent(c)} = EXCLUDED.${qIdent(c)}`).join(", ")
      }`;
    } else {
      sql += ` ON CONFLICT (${usablePk.map(qIdent).join(", ")}) DO NOTHING`;
    }
  } else {
    sql += " ON CONFLICT DO NOTHING";
  }
  return sql;
}

async function getDbIdentity(client) {
  const { rows } = await client.query(
    `SELECT current_database() AS db_name,
            current_schema()  AS schema_name,
            current_user      AS db_user,
            COALESCE(inet_server_addr()::text, 'local') AS host`
  );
  return rows[0];
}

export async function listRecoveryJobs(limit = 20) {
  await ensureRecoveryJobsTable();
  await markStaleRecoveryJobsAsFailed();
  const capped = Math.max(1, Math.min(Number(limit) || 20, 100));
  const { rows } = await pool.query(
    `SELECT *
       FROM workspace_recovery_jobs
      ORDER BY created_at DESC
      LIMIT $1`,
    [capped]
  );
  return rows;
}

export async function getRunningRecoveryJob() {
  await ensureRecoveryJobsTable();
  await markStaleRecoveryJobsAsFailed();
  const { rows } = await pool.query(
    `SELECT * FROM workspace_recovery_jobs WHERE status IN ('pending','running') ORDER BY created_at DESC LIMIT 1`
  );
  return rows[0] || null;
}

export async function createRecoveryJob({
  workspaceId,
  requestedBy,
  dryRun = false,
  batchSize = 500,
  sourceDatabaseUrl = "",
}) {
  await ensureRecoveryJobsTable();
  await markStaleRecoveryJobsAsFailed();
  const id = randomUUID();
  const sourceLabel = sourceDatabaseUrl
    ? maskSourceUrl(sourceDatabaseUrl)
    : (process.env.RESTORE_SOURCE_DATABASE_URL ? "env:RESTORE_SOURCE_DATABASE_URL" : "managed:auto-latest-backup");

  const { rows } = await pool.query(
    `INSERT INTO workspace_recovery_jobs
       (id, workspace_id, status, requested_by, dry_run, batch_size, source_label)
     VALUES ($1, $2, 'pending', $3, $4, $5, $6)
     RETURNING *`,
    [id, workspaceId, requestedBy || "superadmin", !!dryRun, Math.max(1, Math.min(Number(batchSize) || 500, 2000)), sourceLabel]
  );
  return rows[0];
}

function toProgressPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Number(n.toFixed(2));
}

async function updateRecoveryJobProgress({
  jobId,
  rowsScanned = 0,
  rowsWritten = 0,
  tableSummary = [],
  progressPct = 0,
  currentTable = null,
  progressMessage = null,
  appendEvent = false,
}) {
  const safeProgressPct = toProgressPct(progressPct);
  const eventPayload = appendEvent
    ? JSON.stringify([{
      at: new Date().toISOString(),
      message: progressMessage || "",
      currentTable: currentTable || null,
      rowsScanned: Number(rowsScanned) || 0,
      rowsWritten: Number(rowsWritten) || 0,
      progressPct: safeProgressPct,
    }])
    : null;

  await pool.query(
    `UPDATE workspace_recovery_jobs
        SET rows_scanned = $2,
            rows_written = $3,
            table_summary = $4::jsonb,
            progress_pct = $5,
            current_table = $6,
            progress_message = $7,
            event_log = CASE
              WHEN $8::jsonb IS NULL THEN event_log
              ELSE COALESCE(event_log, '[]'::jsonb) || $8::jsonb
            END,
            updated_at = now()
      WHERE id = $1`,
    [
      jobId,
      Number(rowsScanned) || 0,
      Number(rowsWritten) || 0,
      JSON.stringify(tableSummary || []),
      safeProgressPct,
      currentTable || null,
      progressMessage || null,
      eventPayload,
    ]
  );
}

export async function runRecoveryJob({
  jobId,
  workspaceId,
  dryRun = false,
  batchSize = 500,
  sourceDatabaseUrl = "",
}) {
  await ensureRecoveryJobsTable();
  let effectiveSourceUrl = sourceDatabaseUrl || process.env.RESTORE_SOURCE_DATABASE_URL || "";
  let usingManagedAutoSnapshot = false;
  let sourceLabel = sourceDatabaseUrl
    ? maskSourceUrl(sourceDatabaseUrl)
    : (process.env.RESTORE_SOURCE_DATABASE_URL
      ? "env:RESTORE_SOURCE_DATABASE_URL"
      : "managed:auto-latest-backup");

  await pool.query(
    `UPDATE workspace_recovery_jobs
        SET status = 'running',
            started_at = now(),
            completed_at = NULL,
            error_message = NULL,
            rows_scanned = 0,
            rows_written = 0,
            table_summary = '[]'::jsonb,
            progress_pct = 0,
            current_table = NULL,
            progress_message = 'Initializing workspace recovery...',
            event_log = '[]'::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [jobId]
  );

  let heartbeatTimer = null;
  const touchHeartbeat = async () => {
    await pool.query(
      `UPDATE workspace_recovery_jobs
          SET updated_at = now()
        WHERE id = $1
          AND status IN ('pending', 'running')`,
      [jobId]
    ).catch(() => {});
  };

  try {
    await touchHeartbeat();
    heartbeatTimer = setInterval(() => {
      touchHeartbeat();
    }, 20_000);

    let lastProgressWriteAt = 0;
    const writeProgress = async (progress, { force = false, event = false } = {}) => {
      const now = Date.now();
      if (!force && !event && now - lastProgressWriteAt < 1200) return;
      lastProgressWriteAt = now;
      await updateRecoveryJobProgress({
        jobId,
        rowsScanned: progress.rowsScanned,
        rowsWritten: progress.rowsWritten,
        tableSummary: progress.tableSummary,
        progressPct: progress.progressPct,
        currentTable: progress.currentTable,
        progressMessage: progress.progressMessage,
        appendEvent: event,
      }).catch(() => {});
    };

    await writeProgress(
      {
        rowsScanned: 0,
        rowsWritten: 0,
        tableSummary: [],
        progressPct: 0,
        currentTable: null,
        progressMessage: "Recovery job accepted. Preparing source and target connections...",
      },
      { force: true, event: true }
    );

    if (!effectiveSourceUrl) {
      usingManagedAutoSnapshot = true;
      const managed = await buildManagedSnapshotSource({
        onStatus: async (payload) => {
          const info = typeof payload === "string"
            ? { message: payload, restorePct: null }
            : (payload || {});
          const snapshotStagePct = info.restorePct == null
            ? 0
            : (5 + (Math.max(0, Math.min(100, Number(info.restorePct) || 0)) * 0.2));
          await writeProgress(
            {
              rowsScanned: 0,
              rowsWritten: 0,
              tableSummary: [],
              progressPct: snapshotStagePct,
              currentTable: null,
              progressMessage: info.message || "Preparing managed snapshot...",
            },
            { force: !!info.restorePct, event: info.restorePct == null }
          );
        },
      });
      effectiveSourceUrl = managed.sourceDatabaseUrl;
      sourceLabel = managed.sourceLabel;
    }

    await pool.query(
      `UPDATE workspace_recovery_jobs
          SET source_label = $2,
              updated_at = now()
        WHERE id = $1`,
      [jobId, sourceLabel]
    ).catch(() => {});

    const result = await recoverWorkspaceFromSource({
      workspaceId,
      sourceDatabaseUrl: effectiveSourceUrl,
      dryRun,
      batchSize,
      allowSameDb: false,
      onProgress: async (progress) => {
        const finalProgress = usingManagedAutoSnapshot
          ? {
            ...progress,
            progressPct: 25 + (Math.max(0, Math.min(100, Number(progress.progressPct) || 0)) * 0.75),
          }
          : progress;
        await writeProgress(finalProgress, {
          force: !!progress.force,
          event: !!progress.event,
        });
      },
    });

    await updateRecoveryJobProgress({
      jobId,
      rowsScanned: result.rowsScanned,
      rowsWritten: result.rowsWritten,
      tableSummary: result.tableSummary,
      progressPct: 100,
      currentTable: null,
      progressMessage: dryRun
        ? "Dry-run completed. No rows were written."
        : "Workspace recovery completed successfully.",
      appendEvent: true,
    });

    await pool.query(
      `UPDATE workspace_recovery_jobs
          SET status = 'success',
              completed_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [jobId]
    );
    return result;
  } catch (err) {
    await updateRecoveryJobProgress({
      jobId,
      progressMessage: `Recovery failed: ${err.message || "Unknown error"}`,
      appendEvent: true,
    }).catch(() => {});

    await pool.query(
      `UPDATE workspace_recovery_jobs
          SET status = 'failed',
              error_message = $2,
              completed_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [jobId, err.message || "Recovery failed"]
    ).catch(() => {});
    throw err;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

export async function recoverWorkspaceFromSource({
  workspaceId,
  sourceDatabaseUrl,
  dryRun = false,
  batchSize = 500,
  allowSameDb = false,
  onProgress = null,
}) {
  const sourcePool = new Pool({ connectionString: sourceDatabaseUrl });
  let source = null;
  let target = null;

  try {
    source = await sourcePool.connect();
    target = await pool.connect();

    const sourceId = await getDbIdentity(source);
    const targetId = await getDbIdentity(target);
    const sameDb =
      sourceId.db_name === targetId.db_name &&
      sourceId.schema_name === targetId.schema_name &&
      sourceId.db_user === targetId.db_user &&
      sourceId.host === targetId.host;

    if (sameDb && !allowSameDb) {
      throw new Error("Source DB appears identical to target DB. Recovery aborted for safety.");
    }

    const sendProgress = async (payload) => {
      if (!onProgress) return;
      try { await onProgress(payload); } catch {}
    };

    const totalTables = TABLE_PLAN.length || 1;
    let completedTables = 0;
    const getProgressPct = (tableFraction = 0) =>
      ((completedTables + Math.max(0, Math.min(1, Number(tableFraction) || 0))) / totalTables) * 100;

    if (!dryRun) await target.query("BEGIN");

    let rowsScanned = 0;
    let totalWritten = 0;
    const tableSummary = [];
    const batchLimit = Math.max(1, Math.min(Number(batchSize) || 500, 2000));

    await sendProgress({
      rowsScanned,
      rowsWritten: totalWritten,
      tableSummary,
      progressPct: getProgressPct(0),
      currentTable: null,
      progressMessage: "Connection ready. Starting workspace table scan...",
      event: true,
      force: true,
    });

    for (const step of TABLE_PLAN) {
      const { table, where } = step;
      await sendProgress({
        rowsScanned,
        rowsWritten: totalWritten,
        tableSummary,
        progressPct: getProgressPct(0),
        currentTable: table,
        progressMessage: `Scanning ${table}...`,
        event: true,
        force: true,
      });

      const [sourceHasTable, targetHasTable] = await Promise.all([
        tableExists(source, table),
        tableExists(target, table),
      ]);

      if (!sourceHasTable || !targetHasTable) {
        tableSummary.push({ table, scanned: 0, written: 0, skipped: true });
        completedTables += 1;
        await sendProgress({
          rowsScanned,
          rowsWritten: totalWritten,
          tableSummary,
          progressPct: getProgressPct(0),
          currentTable: table,
          progressMessage: `Skipped ${table} (missing in source/target schema).`,
          event: true,
          force: true,
        });
        continue;
      }

      const [sourceCols, targetCols, pkCols] = await Promise.all([
        getColumns(source, table),
        getColumns(target, table),
        getPrimaryKeyColumns(target, table),
      ]);
      const targetColSet = new Set(targetCols);
      const commonCols = sourceCols.filter((c) => targetColSet.has(c));
      if (commonCols.length === 0) {
        tableSummary.push({ table, scanned: 0, written: 0, skipped: true });
        completedTables += 1;
        await sendProgress({
          rowsScanned,
          rowsWritten: totalWritten,
          tableSummary,
          progressPct: getProgressPct(0),
          currentTable: table,
          progressMessage: `Skipped ${table} (no compatible columns).`,
          event: true,
          force: true,
        });
        continue;
      }

      let total = 0;
      try {
        const countRes = await source.query(
          `SELECT count(*)::bigint AS cnt FROM ${qIdent(table)} WHERE ${where}`,
          [workspaceId]
        );
        total = Number(countRes.rows[0]?.cnt || 0);
      } catch (err) {
        // If the WHERE clause references columns that don't exist in the source database,
        // skip this table (e.g., workspace_id column missing in older backups)
        if (err.message && err.message.includes('column') && err.message.includes('does not exist')) {
          console.warn(`Skipping table ${table}: ${err.message}`);
          tableSummary.push({ table, scanned: 0, written: 0, skipped: true });
          completedTables += 1;
          await sendProgress({
            rowsScanned,
            rowsWritten: totalWritten,
            tableSummary,
            progressPct: getProgressPct(0),
            currentTable: table,
            progressMessage: `Skipped ${table} (schema mismatch: ${err.message.split('\n')[0]}).`,
            event: true,
            force: true,
          });
          continue;
        }
        // Re-throw other errors
        throw err;
      }
      if (total === 0) {
        tableSummary.push({ table, scanned: 0, written: 0, skipped: false });
        completedTables += 1;
        await sendProgress({
          rowsScanned,
          rowsWritten: totalWritten,
          tableSummary,
          progressPct: getProgressPct(0),
          currentTable: table,
          progressMessage: `No rows to recover for ${table}.`,
          event: true,
          force: true,
        });
        continue;
      }

      if (dryRun) {
        rowsScanned += total;
        tableSummary.push({ table, scanned: total, written: 0, skipped: false });
        completedTables += 1;
        await sendProgress({
          rowsScanned,
          rowsWritten: totalWritten,
          tableSummary,
          progressPct: getProgressPct(0),
          currentTable: table,
          progressMessage: `Dry-run: ${table} would recover ${total} rows.`,
          event: true,
          force: true,
        });
        continue;
      }

      const orderCols = pkCols.filter((c) => commonCols.includes(c));
      const orderBy = orderCols.length ? ` ORDER BY ${orderCols.map(qIdent).join(", ")}` : "";

      let offset = 0;
      let writtenForTable = 0;
      while (offset < total) {
        const batch = await source.query(
          `SELECT ${commonCols.map(qIdent).join(", ")}
             FROM ${qIdent(table)}
            WHERE ${where}${orderBy}
            LIMIT $2 OFFSET $3`,
          [workspaceId, batchLimit, offset]
        );
        const rows = batch.rows;
        if (rows.length === 0) break;

        const sql = buildUpsertSql(table, commonCols, pkCols, rows.length);
        const values = [];
        for (const row of rows) {
          for (const col of commonCols) values.push(row[col]);
        }
        const upsertRes = await target.query(sql, values);
        writtenForTable += upsertRes.rowCount || 0;
        offset += rows.length;
        rowsScanned += rows.length;

        if (
          offset === rows.length ||
          offset >= total ||
          offset % (batchLimit * 5) === 0
        ) {
          await sendProgress({
            rowsScanned,
            rowsWritten: totalWritten + writtenForTable,
            tableSummary,
            progressPct: getProgressPct(offset / total),
            currentTable: table,
            progressMessage: `Recovering ${table}: ${Math.min(offset, total)}/${total} rows`,
            event: false,
            force: false,
          });
        }
      }

      totalWritten += writtenForTable;
      tableSummary.push({ table, scanned: total, written: writtenForTable, skipped: false });
      completedTables += 1;
      await sendProgress({
        rowsScanned,
        rowsWritten: totalWritten,
        tableSummary,
        progressPct: getProgressPct(0),
        currentTable: table,
        progressMessage: `Completed ${table}: scanned ${total}, wrote ${writtenForTable}.`,
        event: true,
        force: true,
      });
    }

    if (!dryRun) await target.query("COMMIT");

    await sendProgress({
      rowsScanned,
      rowsWritten: dryRun ? 0 : totalWritten,
      tableSummary,
      progressPct: 100,
      currentTable: null,
      progressMessage: dryRun
        ? "Dry-run completed for all tables."
        : "Workspace recovery completed for all tables.",
      event: true,
      force: true,
    });

    return {
      rowsScanned,
      rowsWritten: dryRun ? 0 : totalWritten,
      tableSummary,
    };
  } catch (err) {
    if (!dryRun && target) {
      try { await target.query("ROLLBACK"); } catch {}
    }
    throw err;
  } finally {
    if (source) source.release();
    if (target) target.release();
    await sourcePool.end().catch(() => {});
  }
}
