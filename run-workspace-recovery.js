import dotenv from "dotenv";
import pg from "pg";
import pool from "./db.js";

dotenv.config();

const { Pool } = pg;

const TABLE_PLAN = [
  // Tenant root
  { table: "workspaces", where: "id = $1" },
  { table: "users", where: "workspace_id = $1" },
  { table: "workspace_users", where: "workspace_id = $1" },

  // Core PM
  { table: "projects", where: "workspace_id = $1" },
  { table: "project_ticket_sequences", where: "workspace_id = $1" },
  { table: "sprints", where: "workspace_id = $1" },
  { table: "tasks", where: "workspace_id = $1" },
  {
    table: "task_attachments",
    where: "task_id IN (SELECT id FROM tasks WHERE workspace_id = $1)",
  },
  { table: "task_activity_logs", where: "workspace_id = $1" },

  // Chat
  { table: "chat_channels", where: "workspace_id = $1" },
  { table: "chat_channel_members", where: "workspace_id = $1" },
  { table: "chat_channel_admins", where: "workspace_id = $1" },
  { table: "chat_messages", where: "workspace_id = $1" },

  // Wiki
  { table: "wiki_spaces", where: "workspace_id = $1" },
  {
    table: "wiki_pages",
    where: "space_id IN (SELECT id FROM wiki_spaces WHERE workspace_id = $1)",
  },
  {
    table: "wiki_page_versions",
    where: "page_id IN (SELECT wp.id FROM wiki_pages wp JOIN wiki_spaces ws ON ws.id = wp.space_id WHERE ws.workspace_id = $1)",
  },

  // Goals / reviews
  { table: "okr_objectives", where: "workspace_id = $1" },
  {
    table: "okr_key_results",
    where: "objective_id IN (SELECT id FROM okr_objectives WHERE workspace_id = $1)",
  },
  { table: "review_cycles", where: "workspace_id = $1" },
  {
    table: "performance_reviews",
    where: "cycle_id IN (SELECT id FROM review_cycles WHERE workspace_id = $1)",
  },

  // Leave / attendance
  { table: "leave_types", where: "workspace_id = $1" },
  { table: "leave_requests", where: "workspace_id = $1" },
  { table: "leave_balances", where: "workspace_id = $1" },
  { table: "attendance_daily", where: "workspace_id = $1" },

  // YouTrack parity + task graph
  { table: "tags", where: "workspace_id = $1" },
  {
    table: "task_tag_assignments",
    where: "task_id IN (SELECT id FROM tasks WHERE workspace_id = $1)",
  },
  { table: "task_links", where: "workspace_id = $1" },
  { table: "time_logs", where: "workspace_id = $1" },
  { table: "task_watchers", where: "workspace_id = $1" },
  { table: "task_votes", where: "workspace_id = $1" },
  { table: "issue_templates", where: "workspace_id = $1" },
  { table: "saved_filters", where: "workspace_id = $1" },
  { table: "task_assignees", where: "workspace_id = $1" },

  // AI / Ops / Automation
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

  // Billing / enterprise
  { table: "payment_customers", where: "workspace_id = $1" },
  { table: "workspace_subscriptions", where: "workspace_id = $1" },
  { table: "payment_checkout_sessions", where: "workspace_id = $1" },
  { table: "user_activation_payments", where: "workspace_id = $1" },
  { table: "workspace_sso_configs", where: "workspace_id = $1" },
  { table: "api_keys", where: "workspace_id = $1" },
  { table: "webhooks", where: "workspace_id = $1" },
  {
    table: "webhook_deliveries",
    where: "webhook_id IN (SELECT id FROM webhooks WHERE workspace_id = $1)",
  },
  { table: "workspace_work_schedule", where: "workspace_id = $1" },
  { table: "workspace_holidays", where: "workspace_id = $1" },
  { table: "gdpr_erasure_requests", where: "workspace_id = $1" },
  { table: "trial_ip_log", where: "workspace_id = $1" },
  { table: "migration_imports", where: "workspace_id = $1" },

  // User-scoped supporting tables (for workspace users)
  {
    table: "gdpr_consents",
    where: "user_id IN (SELECT id FROM users WHERE workspace_id = $1)",
  },
  {
    table: "user_sessions",
    where: "user_id IN (SELECT id FROM users WHERE workspace_id = $1)",
  },
  {
    table: "magic_link_tokens",
    where: "user_id IN (SELECT id FROM users WHERE workspace_id = $1)",
  },
  {
    table: "password_reset_tokens",
    where: "user_id IN (SELECT id FROM users WHERE workspace_id = $1)",
  },
];

function qIdent(name) {
  return `"${String(name).replace(/"/g, "\"\"")}"`;
}

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
    for (let c = 0; c < columns.length; c += 1) {
      rowParams.push(`$${p++}`);
    }
    valuesSql.push(`(${rowParams.join(", ")})`);
  }

  let sql = `INSERT INTO ${qTable} (${qCols.join(", ")}) VALUES ${valuesSql.join(", ")}`;

  const usablePk = pkColumns.filter((pk) => columns.includes(pk));
  if (usablePk.length > 0) {
    const qPk = usablePk.map(qIdent);
    const nonPk = columns.filter((c) => !usablePk.includes(c));
    if (nonPk.length > 0) {
      const updates = nonPk.map((c) => `${qIdent(c)} = EXCLUDED.${qIdent(c)}`);
      sql += ` ON CONFLICT (${qPk.join(", ")}) DO UPDATE SET ${updates.join(", ")}`;
    } else {
      sql += ` ON CONFLICT (${qPk.join(", ")}) DO NOTHING`;
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
            current_user      AS db_user`
  );
  return rows[0];
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.workspaceId || !args.sourceUrl) {
    console.error("Usage:");
    console.error("  node run-workspace-recovery.js --workspace-id <uuid> --source-url <postgres-url> [--dry-run] [--batch-size 500]");
    console.error("Env fallback for source URL: RESTORE_SOURCE_DATABASE_URL");
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const sourcePool = new Pool({ connectionString: args.sourceUrl });
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
      sourceId.db_user === targetId.db_user;

    if (sameDb && !args.allowSameDb) {
      throw new Error(
        "Source DB identity looks the same as target DB. Aborting for safety. Pass --allow-same-db only if intentional."
      );
    }

    console.log(`Workspace recovery ${args.dryRun ? "(dry-run)" : "(apply)"} for workspace ${args.workspaceId}`);
    console.log(`Batch size: ${args.batchSize}`);
    console.log(`Source DB: ${sourceId.db_name} (${sourceId.db_user})`);
    console.log(`Target DB: ${targetId.db_name} (${targetId.db_user})`);

    if (!args.dryRun) {
      await target.query("BEGIN");
    }

    let totalRead = 0;
    let totalWritten = 0;

    for (const step of TABLE_PLAN) {
      const { table, where } = step;

      const [sourceHasTable, targetHasTable] = await Promise.all([
        tableExists(source, table),
        tableExists(target, table),
      ]);

      if (!sourceHasTable || !targetHasTable) {
        console.log(`- ${table}: skipped (missing in ${!sourceHasTable ? "source" : "target"})`);
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
        console.log(`- ${table}: skipped (no common columns)`);
        continue;
      }

      const countRes = await source.query(
        `SELECT count(*)::bigint AS cnt FROM ${qIdent(table)} WHERE ${where}`,
        [args.workspaceId]
      );
      const total = Number(countRes.rows[0]?.cnt || 0);
      if (total === 0) {
        console.log(`- ${table}: 0 rows`);
        continue;
      }

      console.log(`- ${table}: ${total} rows`);
      totalRead += total;

      if (args.dryRun) continue;

      const orderCols = pkCols.filter((c) => commonCols.includes(c));
      const orderBy = orderCols.length ? ` ORDER BY ${orderCols.map(qIdent).join(", ")}` : "";

      let offset = 0;
      while (offset < total) {
        const batchRes = await source.query(
          `SELECT ${commonCols.map(qIdent).join(", ")}
             FROM ${qIdent(table)}
            WHERE ${where}${orderBy}
            LIMIT $2 OFFSET $3`,
          [args.workspaceId, args.batchSize, offset]
        );
        const rows = batchRes.rows;
        if (rows.length === 0) break;

        const sql = buildUpsertSql(table, commonCols, pkCols, rows.length);
        const values = [];
        for (const row of rows) {
          for (const col of commonCols) values.push(row[col]);
        }

        const upsertRes = await target.query(sql, values);
        totalWritten += upsertRes.rowCount || 0;
        offset += rows.length;
      }
    }

    if (!args.dryRun) {
      await target.query("COMMIT");
    }

    console.log(`\n✅ Workspace recovery ${args.dryRun ? "dry-run complete" : "completed"}:`);
    console.log(`   Rows scanned: ${totalRead}`);
    console.log(`   Rows written: ${args.dryRun ? 0 : totalWritten}`);
  } catch (err) {
    if (!args.dryRun && target) {
      try { await target.query("ROLLBACK"); } catch {}
    }
    console.error("❌ Workspace recovery failed:", err.message);
    process.exitCode = 1;
  } finally {
    if (source) source.release();
    if (target) target.release();
    await sourcePool.end().catch(() => {});
    await pool.end();
  }
}

run();
