import pool from "./db.js";
import { runAutopilotAnalysis } from "./autopilot/autopilot.engine.js";

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [key, value] = raw.slice(2).split("=");
    args[key] = value === undefined ? true : value;
  }
  return args;
}

function parseDateInput(value) {
  if (value instanceof Date) return new Date(value);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }
  return new Date(value);
}

function startOfDay(value) {
  const date = parseDateInput(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toIsoDate(date) {
  const local = startOfDay(date);
  const year = local.getFullYear();
  const month = String(local.getMonth() + 1).padStart(2, "0");
  const day = String(local.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function isWorkingDayForWorkspace(workspaceId, date) {
  const { rows: scheduleRows } = await pool.query(
    `SELECT work_days FROM workspace_work_schedule WHERE workspace_id = $1`,
    [workspaceId]
  );
  const workDays = scheduleRows[0]?.work_days ?? [1, 2, 3, 4, 5];
  if (!workDays.includes(date.getDay())) return false;

  const { rows: holidays } = await pool.query(
    `SELECT 1 FROM workspace_holidays WHERE workspace_id = $1 AND date = $2`,
    [workspaceId, toIsoDate(date)]
  );
  return holidays.length === 0;
}

async function getStandupWindowForReportDate(workspaceId, reportDate, standupHour = 11) {
  const cursor = startOfDay(reportDate);
  cursor.setDate(cursor.getDate() - 1);

  for (let i = 0; i < 14; i += 1) {
    if (await isWorkingDayForWorkspace(workspaceId, cursor)) {
      const since = new Date(cursor);
      since.setHours(standupHour, 0, 0, 0);

      const isYesterday = i === 0;
      const dayName = cursor.toLocaleDateString("en-US", { weekday: "long" });
      const dateLabel = cursor.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      return {
        sinceTimestamp: since,
        periodLabel: isYesterday ? "since yesterday" : `since ${dayName} (${dateLabel})`,
      };
    }
    cursor.setDate(cursor.getDate() - 1);
  }

  return {
    sinceTimestamp: new Date(reportDate.getTime() - 24 * 60 * 60 * 1000),
    periodLabel: "last 24 hours",
  };
}

async function listReplayProjects(workspaceId, sinceTimestamp) {
  const { rows } = await pool.query(
    `
    SELECT p.id, p.name
    FROM projects p
    WHERE p.workspace_id = $1
      AND (
        EXISTS (
          SELECT 1 FROM sprints s
          WHERE s.workspace_id = $1
            AND s.project_id = p.id
            AND s.status = 'active'
        )
        OR EXISTS (
          SELECT 1 FROM tasks t
          WHERE t.workspace_id = $1
            AND t.project_id = p.id
            AND LOWER(COALESCE(t.status, '')) NOT IN ('completed', 'cancelled', 'done', 'closed')
        )
        OR EXISTS (
          SELECT 1
          FROM task_activity_logs al
          JOIN tasks t ON t.id = al.task_id
          WHERE al.workspace_id = $1
            AND t.project_id = p.id
            AND al.created_at > $2::timestamptz
        )
      )
    ORDER BY p.name ASC
    `,
    [workspaceId, sinceTimestamp]
  );
  return rows;
}

async function hasExistingStandupAction(workspaceId, projectId, reportDateIso) {
  const { rows } = await pool.query(
    `
    SELECT 1
    FROM autopilot_actions
    WHERE workspace_id = $1
      AND project_id = $2
      AND action_type = 'create_standup'
      AND status IN ('auto_approved', 'executed', 'approved', 'pending')
      AND COALESCE(current_state->>'report_date', created_at::date::text) = $3
    LIMIT 1
    `,
    [workspaceId, projectId, reportDateIso]
  );
  return rows.length > 0;
}

async function hasHistoricalStandupMessage(workspaceId, projectName, reportDateIso) {
  const prefix = `${projectName} Daily Standup%`;
  const { rows } = await pool.query(
    `
    SELECT 1
    FROM chat_messages
    WHERE workspace_id = $1
      AND channel_key = 'daily-standups'
      AND created_at::date = $2::date
      AND fallback_text ILIKE $3
    LIMIT 1
    `,
    [workspaceId, reportDateIso, prefix]
  );
  return rows.length > 0;
}

async function getDefaultStartDate(workspaceId) {
  const { rows } = await pool.query(
    `
    SELECT MAX(COALESCE((current_state->>'report_date')::date, executed_at::date, created_at::date)) AS last_report_date
    FROM autopilot_actions
    WHERE workspace_id = $1
      AND action_type = 'create_standup'
      AND status = 'executed'
    `,
    [workspaceId]
  );

  if (!rows[0]?.last_report_date) {
    return addDays(startOfDay(new Date()), -14);
  }

  return addDays(startOfDay(rows[0].last_report_date), 1);
}

async function getReplayWorkspaces(workspaceId = null) {
  const params = [];
  let whereClause = `WHERE enabled = true AND auto_generate_standup = true`;
  if (workspaceId) {
    params.push(workspaceId);
    whereClause += ` AND workspace_id = $1`;
  }

  const { rows } = await pool.query(
    `
    SELECT DISTINCT s.workspace_id, w.name AS workspace_name
    FROM autopilot_settings s
    JOIN workspaces w ON w.id = s.workspace_id
    ${whereClause}
    ORDER BY w.name ASC
    `,
    params
  );
  return rows;
}

async function replayWorkspace({ workspaceId, workspaceName, fromDate, toDate, dryRun, standupHour }) {
  let examinedDays = 0;
  let replayedProjects = 0;
  let skippedExisting = 0;

  for (let cursor = startOfDay(fromDate); cursor <= toDate; cursor = addDays(cursor, 1)) {
    if (!(await isWorkingDayForWorkspace(workspaceId, cursor))) continue;
    examinedDays += 1;

    const reportDateIso = toIsoDate(cursor);
    const { sinceTimestamp, periodLabel } = await getStandupWindowForReportDate(workspaceId, cursor, standupHour);
    const projects = await listReplayProjects(workspaceId, sinceTimestamp);

    console.log(`\n[workspace:${workspaceName}] ${reportDateIso} | ${projects.length} candidate project(s) | ${periodLabel}`);

    for (const project of projects) {
      const existsInActions = await hasExistingStandupAction(workspaceId, project.id, reportDateIso);
      const existsInChat = await hasHistoricalStandupMessage(workspaceId, project.name, reportDateIso);

      if (existsInActions || existsInChat) {
        skippedExisting += 1;
        console.log(`  skip  ${project.name} (${existsInActions ? "action" : "chat"} already exists)`);
        continue;
      }

      if (dryRun) {
        replayedProjects += 1;
        console.log(`  dry   ${project.name}`);
        continue;
      }

      const result = await runAutopilotAnalysis({
        workspaceId,
        projectId: project.id,
        skipStandup: false,
        sinceTimestamp,
        periodLabel,
        standupOnly: true,
        reportDate: cursor,
      });

      replayedProjects += result.actionsCreated;
      console.log(`  post  ${project.name} (${result.actionsCreated} action(s))`);
    }
  }

  return { examinedDays, replayedProjects, skippedExisting };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspaceId = typeof args.workspace === "string" ? args.workspace : null;
  const dryRun = Boolean(args["dry-run"]);
  const standupHour = Number(args.hour || 11);

  const workspaces = await getReplayWorkspaces(workspaceId);
  if (!workspaces.length) {
    console.log("No workspaces found for standup replay.");
    return;
  }

  for (const ws of workspaces) {
    const fromDate = args.from ? startOfDay(args.from) : await getDefaultStartDate(ws.workspace_id);
    const toDate = args.to ? startOfDay(args.to) : addDays(startOfDay(new Date()), -1);

    if (fromDate > toDate) {
      console.log(`[workspace:${ws.workspace_name}] nothing to replay (${toIsoDate(fromDate)} > ${toIsoDate(toDate)})`);
      continue;
    }

    console.log(`\nReplaying standups for ${ws.workspace_name} (${ws.workspace_id})`);
    console.log(`Range: ${toIsoDate(fromDate)} -> ${toIsoDate(toDate)}${dryRun ? " [dry-run]" : ""}`);

    const summary = await replayWorkspace({
      workspaceId: ws.workspace_id,
      workspaceName: ws.workspace_name,
      fromDate,
      toDate,
      dryRun,
      standupHour,
    });

    console.log(
      `\n[workspace:${ws.workspace_name}] examined ${summary.examinedDays} working day(s), replayed ${summary.replayedProjects} project standup(s), skipped ${summary.skippedExisting} existing record(s).`
    );
  }
}

main()
  .catch(err => {
    console.error("Standup replay failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
