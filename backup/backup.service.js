/**
 * backup.service.js
 *
 * Handles automated and manual PostgreSQL database backups.
 *
 * Flow:
 *   1. Run pg_dump → write compressed .sql.gz to local backups/ folder
 *   2. If S3 env vars are configured → upload to S3-compatible storage
 *      (works with AWS S3, Backblaze B2, DigitalOcean Spaces, Cloudflare R2)
 *   3. Log result (success / failed) to backup_logs table
 *   4. Clean up local files older than BACKUP_RETENTION_DAYS (default: 30)
 *
 * Required env vars (DB — already in your .env):
 *   DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
 *
 * Optional env vars (S3 upload):
 *   BACKUP_S3_ENDPOINT    — leave empty for AWS, e.g. https://s3.us-west-004.backblazeb2.com for B2
 *   BACKUP_S3_BUCKET      — your bucket name
 *   BACKUP_S3_REGION      — e.g. us-east-1
 *   BACKUP_S3_ACCESS_KEY  — access key id
 *   BACKUP_S3_SECRET_KEY  — secret access key
 *   BACKUP_LOCAL_DIR      — where to store local files (default: ./backups)
 *   BACKUP_RETENTION_DAYS — how many days to keep local files (default: 30)
 */

import { spawn } from "child_process";
import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { createGzip } from "zlib";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import pool from "../db.js";
import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createReadStream } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let backupLogsReady = false;
let backupLogsInitPromise = null;

async function ensureBackupLogsTable() {
  if (backupLogsReady) return;
  if (backupLogsInitPromise) {
    await backupLogsInitPromise;
    return;
  }

  backupLogsInitPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS backup_logs (
        id              UUID        PRIMARY KEY,
        status          TEXT        NOT NULL CHECK (status IN ('running', 'success', 'failed')),
        triggered_by    TEXT        NOT NULL DEFAULT 'cron',
        file_name       TEXT,
        file_size_bytes BIGINT,
        storage_type    TEXT,
        storage_path    TEXT,
        error_message   TEXT,
        started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at    TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_backup_logs_started_at
      ON backup_logs(started_at DESC);
    `);
    backupLogsReady = true;
  })();

  try {
    await backupLogsInitPromise;
  } finally {
    backupLogsInitPromise = null;
  }
}

// ── Config ────────────────────────────────────────────────────────────────────
const BACKUP_DIR      = process.env.BACKUP_LOCAL_DIR
  ? path.resolve(process.env.BACKUP_LOCAL_DIR)
  : path.join(__dirname, "..", "backups");

const RETENTION_DAYS  = parseInt(process.env.BACKUP_RETENTION_DAYS || "30", 10);
const RUNNING_TIMEOUT_MINUTES = parseInt(process.env.BACKUP_RUNNING_TIMEOUT_MINUTES || "180", 10);

const S3_BUCKET       = process.env.BACKUP_S3_BUCKET || null;
const S3_REGION       = process.env.BACKUP_S3_REGION || "us-east-1";
const S3_ENDPOINT     = process.env.BACKUP_S3_ENDPOINT || null; // null = AWS
const S3_ACCESS_KEY   = process.env.BACKUP_S3_ACCESS_KEY || null;
const S3_SECRET_KEY   = process.env.BACKUP_S3_SECRET_KEY || null;

const DB_HOST     = process.env.DB_HOST     || "localhost";
const DB_PORT     = process.env.DB_PORT     || "5432";
const DB_USER     = process.env.DB_USER     || "postgres";
const DB_PASSWORD = process.env.DB_PASSWORD || "";
const DB_NAME     = process.env.DB_NAME     || "postgres";

// ── S3 client (only created if credentials provided) ─────────────────────────
function getS3Client() {
  if (!S3_BUCKET || !S3_ACCESS_KEY || !S3_SECRET_KEY) return null;
  const config = {
    region: S3_REGION,
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  };
  if (S3_ENDPOINT) config.endpoint = S3_ENDPOINT;
  return new S3Client(config);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

async function logBackup(fields) {
  try {
    await ensureBackupLogsTable();
    await pool.query(
      `INSERT INTO backup_logs
         (id, status, triggered_by, file_name, file_size_bytes, storage_type,
           storage_path, error_message, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        randomUUID(),
        fields.status,
        fields.triggeredBy || "cron",
        fields.fileName    || null,
        fields.fileSizeBytes || null,
        fields.storageType || null,
        fields.storagePath || null,
        fields.errorMessage || null,
        fields.startedAt   || new Date(),
        fields.completedAt || null,
      ]
    );
  } catch (e) {
    console.error("[backup] Failed to write backup_log:", e.message);
  }
}

function getFileSizeBytes(filePath) {
  try { return statSync(filePath).size; } catch { return null; }
}

async function markStaleRunningBackupsAsFailed() {
  const timeout = Math.max(5, RUNNING_TIMEOUT_MINUTES);
  const { rowCount } = await pool.query(
    `UPDATE backup_logs
        SET status = 'failed',
            error_message = COALESCE(error_message, 'Backup marked failed automatically (stale running state).'),
            completed_at = now()
      WHERE status = 'running'
        AND completed_at IS NULL
        AND started_at < now() - ($1::int * interval '1 minute')`,
    [timeout]
  );
  if (rowCount > 0) {
    console.warn(`[backup] Marked ${rowCount} stale running backup(s) as failed (>${timeout} min).`);
  }
}

export async function getActiveRunningBackup() {
  const timeout = Math.max(5, RUNNING_TIMEOUT_MINUTES);
  const { rows } = await pool.query(
    `SELECT *
       FROM backup_logs
      WHERE status = 'running'
        AND completed_at IS NULL
        AND started_at >= now() - ($1::int * interval '1 minute')
      ORDER BY started_at DESC
      LIMIT 1`,
    [timeout]
  );
  return rows[0] || null;
}

// ── Core: run pg_dump and write compressed file ───────────────────────────────
function runPgDump(outputPath) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PGPASSWORD: DB_PASSWORD };

    const pg = spawn(
      "pg_dump",
      ["-h", DB_HOST, "-p", DB_PORT, "-U", DB_USER, "-d", DB_NAME, "--no-password"],
      { env }
    );

    const gzip   = createGzip();
    const output = createWriteStream(outputPath);

    pg.stdout.pipe(gzip).pipe(output);

    let stderrOut = "";
    pg.stderr.on("data", (d) => { stderrOut += d.toString(); });

    pg.on("error", (err) => reject(new Error(`pg_dump not found: ${err.message}. Is PostgreSQL client installed?`)));

    output.on("finish", () => resolve());
    output.on("error", reject);

    pg.on("close", (code) => {
      if (code !== 0) reject(new Error(`pg_dump exited with code ${code}: ${stderrOut}`));
    });
  });
}

// ── Core: upload to S3-compatible storage ────────────────────────────────────
async function uploadToS3(localPath, s3Key) {
  const s3 = getS3Client();
  if (!s3) throw new Error("S3 not configured");

  const stream = createReadStream(localPath);
  await s3.send(new PutObjectCommand({
    Bucket:      S3_BUCKET,
    Key:         s3Key,
    Body:        stream,
    ContentType: "application/gzip",
  }));

  return `s3://${S3_BUCKET}/${s3Key}`;
}

// ── Core: delete local files older than retention period ─────────────────────
function pruneOldBackups() {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    const files  = readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".sql.gz"));
    for (const file of files) {
      const full = path.join(BACKUP_DIR, file);
      if (statSync(full).mtimeMs < cutoff) {
        unlinkSync(full);
        console.log(`[backup] Pruned old backup: ${file}`);
      }
    }
  } catch (e) {
    console.warn("[backup] Prune warning:", e.message);
  }
}

// ── Public: run a full backup ─────────────────────────────────────────────────
export async function runBackup(triggeredBy = "cron") {
  await ensureBackupLogsTable();
  await markStaleRunningBackupsAsFailed();

  const activeRunning = await getActiveRunningBackup();
  if (activeRunning) {
    return {
      success: false,
      error: `A backup is already running since ${activeRunning.started_at}. Please wait for it to finish.`,
    };
  }

  const startedAt = new Date();
  const fileName  = `asystence_backup_${timestamp()}.sql.gz`;
  const localPath = path.join(BACKUP_DIR, fileName);

  // Ensure backup dir exists
  mkdirSync(BACKUP_DIR, { recursive: true });

  console.log(`[backup] Starting backup → ${fileName} (triggered by: ${triggeredBy})`);

  // Mark as running
  const logId = randomUUID();
  await pool.query(
    `INSERT INTO backup_logs
       (id, status, triggered_by, file_name, started_at)
     VALUES ($1, 'running', $2, $3, $4)
     RETURNING id`,
    [logId, triggeredBy, fileName, startedAt]
  ).catch(() => {});

  try {
    // 1. Run pg_dump
    await runPgDump(localPath);
    const fileSizeBytes = getFileSizeBytes(localPath);

    // 2. Optionally upload to S3
    let storageType = "local";
    let storagePath = localPath;

    const s3 = getS3Client();
    if (s3) {
      const s3Key = `backups/${fileName}`;
      storagePath = await uploadToS3(localPath, s3Key);
      storageType = "s3";
      console.log(`[backup] Uploaded to S3: ${storagePath}`);
    }

    const completedAt = new Date();
    const duration    = ((completedAt - startedAt) / 1000).toFixed(1);

    // 3. Update log to success
    if (logId) {
      await pool.query(
        `UPDATE backup_logs
         SET status = 'success', file_size_bytes = $1, storage_type = $2,
             storage_path = $3, completed_at = $4
         WHERE id = $5`,
        [fileSizeBytes, storageType, storagePath, completedAt, logId]
      );
    }

    console.log(`[backup] ✅ Backup complete in ${duration}s — ${(fileSizeBytes / 1024 / 1024).toFixed(2)} MB`);

    // 4. Prune old local files
    pruneOldBackups();

    return { success: true, fileName, fileSizeBytes, storageType, storagePath, duration };
  } catch (err) {
    console.error("[backup] ❌ Backup failed:", err.message);

    if (logId) {
      await pool.query(
        `UPDATE backup_logs
         SET status = 'failed', error_message = $1, completed_at = now()
         WHERE id = $2`,
        [err.message, logId]
      ).catch(() => {});
    }

    return { success: false, error: err.message };
  }
}

// ── Public: get recent backup logs ───────────────────────────────────────────
export async function getBackupLogs(limit = 50) {
  await ensureBackupLogsTable();
  await markStaleRunningBackupsAsFailed();
  const { rows } = await pool.query(
    `SELECT * FROM backup_logs ORDER BY started_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

// ── Public: get latest successful backup info ────────────────────────────────
export async function getLastSuccessfulBackup() {
  await ensureBackupLogsTable();
  await markStaleRunningBackupsAsFailed();
  const { rows } = await pool.query(
    `SELECT * FROM backup_logs WHERE status = 'success' ORDER BY completed_at DESC LIMIT 1`
  );
  return rows[0] || null;
}
