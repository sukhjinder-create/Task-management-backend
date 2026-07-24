import assert from "assert";
import fs from "fs";

function read(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function includes(file, needle, message) {
  assert.ok(file.includes(needle), message);
}

function notIncludes(file, needle, message) {
  assert.ok(!file.includes(needle), message);
}

const backupService = read("backup/backup.service.js");
const recoveryService = read("backup/workspaceRecovery.service.js");
const databaseTarget = read("backup/databaseTarget.js");
const backupRoutes = read("routes/backup.routes.js");
const recoveryMigration = read("migrations/20260409_workspace_recovery_jobs.sql");
const cli = read("run-workspace-recovery.js");
const runbook = read("BACKUP_RECOVERY_RUNBOOK.md");

includes(backupRoutes, "router.use(requireSuperadmin)", "Backup routes must stay behind Super Admin auth");
includes(backupRoutes, "confirmApply=true", "Apply recovery route must require explicit confirmation");
includes(backupRoutes, "missingWorkspaceRecoverySupported", "Recovery config must advertise missing workspace support");

includes(databaseTarget, "process.env.DATABASE_URL", "Database target helper must support DATABASE_URL");
includes(databaseTarget, "PGSSLMODE", "Libpq env must carry SSL mode for pg_dump/psql");
includes(backupService, "getLibpqEnv()", "Backup service must use shared libpq DB target resolution");
includes(recoveryService, "getLibpqEnv(database)", "Recovery restore must use shared libpq DB target resolution");
includes(recoveryService, "createPoolFromConnectionString(sourceDatabaseUrl)", "Recovery source pools must use shared URL/SSL handling");

notIncludes(
  recoveryMigration,
  "workspace_id    UUID NOT NULL REFERENCES workspaces",
  "Recovery job table must not FK to workspaces because deleted workspaces need recovery"
);
includes(recoveryMigration, "DROP CONSTRAINT", "Recovery migration must drop older workspace_id FK constraints");
includes(recoveryMigration, "target_workspace_exists", "Recovery jobs must persist live workspace existence metadata");

for (const table of [
  "system_users",
  "comments",
  "notifications",
  "huddle_sessions",
  "workspace_events",
  "adaptive_runtime_runs",
  "adaptive_execution_plans",
  "adaptive_intelligence_evaluations",
  "exec_decisions",
  "ei_events",
]) {
  includes(recoveryService, `table: "${table}"`, `Recovery table plan must include ${table}`);
}

includes(recoveryService, "syncTableSequences", "Recovery must resync serial/bigserial sequences after explicit ID restore");
includes(recoveryService, "isRecoverableSchemaMismatch", "Recovery must skip old-schema mismatches instead of aborting");
includes(cli, "recoverWorkspaceFromSource", "CLI must use the shared recovery service implementation");
notIncludes(cli, "const TABLE_PLAN", "CLI must not maintain a duplicate recovery table plan");
includes(runbook, "manual workspace UUID", "Runbook must document deleted/missing workspace recovery");
includes(runbook, "database safety guard", "Runbook must document guarded CLI recovery commands");

console.log("Backup and workspace recovery contract verification passed.");
