import dotenv from "dotenv";
import pool from "./db.js";
import { recoverWorkspaceFromSource } from "./backup/workspaceRecovery.service.js";

dotenv.config();

function parseArgs(argv) {
  const out = {
    workspaceId: "",
    sourceUrl: process.env.RESTORE_SOURCE_DATABASE_URL || "",
    dryRun: false,
    batchSize: 500,
    allowSameDb: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace-id" && argv[i + 1]) out.workspaceId = argv[++i];
    else if (arg === "--source-url" && argv[i + 1]) out.sourceUrl = argv[++i];
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--allow-same-db") out.allowSameDb = true;
    else if (arg === "--batch-size" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) out.batchSize = Math.min(Math.floor(n), 2000);
    }
  }

  return out;
}

function printUsage() {
  console.error("Usage:");
  console.error("  node run-workspace-recovery.js --workspace-id <uuid> --source-url <postgres-url> [--dry-run] [--batch-size 500]");
  console.error("Env fallback for source URL: RESTORE_SOURCE_DATABASE_URL");
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.workspaceId || !args.sourceUrl) {
    printUsage();
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.workspaceId);
  if (!isUuid) {
    console.error("Workspace recovery failed: --workspace-id must be a valid UUID");
    process.exitCode = 1;
    await pool.end();
    return;
  }

  try {
    console.log(`Workspace recovery ${args.dryRun ? "(dry-run)" : "(apply)"} for workspace ${args.workspaceId}`);
    console.log(`Batch size: ${args.batchSize}`);

    const result = await recoverWorkspaceFromSource({
      workspaceId: args.workspaceId,
      sourceDatabaseUrl: args.sourceUrl,
      dryRun: args.dryRun,
      batchSize: args.batchSize,
      allowSameDb: args.allowSameDb,
      onProgress: async (progress) => {
        if (!progress.force && !progress.event) return;
        const pct = Number(progress.progressPct || 0).toFixed(1);
        const table = progress.currentTable ? ` [${progress.currentTable}]` : "";
        console.log(`${pct}%${table} ${progress.progressMessage || ""}`.trim());
      },
    });

    console.log("");
    console.log(`Workspace recovery ${args.dryRun ? "dry-run complete" : "completed"}:`);
    console.log(`  Rows scanned: ${result.rowsScanned}`);
    console.log(`  Rows written: ${args.dryRun ? 0 : result.rowsWritten}`);
  } catch (err) {
    console.error("Workspace recovery failed:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run();
