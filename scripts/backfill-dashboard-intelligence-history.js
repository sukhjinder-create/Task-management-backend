import { assertDatabaseScriptSafety } from "../utils/databaseSafety.js";

function readArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function readNumber(name, fallback) {
  const value = Number(readArg(name, fallback));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const execute = process.argv.includes("--execute");
const workspaceId = readArg("workspace-id", null);
const days = readNumber("days", 366);
const intervalDays = readNumber("interval-days", 7);
const maxAnchors = readNumber("max-anchors", 64);
const windowDays = readNumber("window-days", 30);

if (execute) {
  assertDatabaseScriptSafety({
    operation: "dashboard intelligence historical snapshot backfill",
    force: true,
  });
}

const [{ backfillDashboardIntelligenceHistory }, { default: pool }] = await Promise.all([
  import("../intelligence/snapshots/historicalBackfill.service.js"),
  import("../db.js"),
]);

try {
  const result = await backfillDashboardIntelligenceHistory({
    workspaceId,
    days,
    intervalDays,
    maxAnchors,
    windowDays,
    execute,
  });
  console.log(JSON.stringify({
    status: execute ? "executed" : "dry_run",
    result,
  }, null, 2));
} catch (err) {
  console.error(JSON.stringify({
    status: "failed",
    execute,
    code: err?.code || null,
    message: err?.message || "Dashboard intelligence history backfill failed",
  }, null, 2));
  process.exitCode = 1;
} finally {
  await pool.end();
}
