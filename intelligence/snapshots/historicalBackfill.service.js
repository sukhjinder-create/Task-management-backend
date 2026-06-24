import pool from "../../db.js";
import { collectProjectEvidence, collectUserEvidence, collectWorkspaceEvidence, collectWorkspaceScope } from "../engine/evidenceCollector.js";
import { INTELLIGENCE_VERSION, compactJson } from "../engine/scorePrimitives.js";
import { evaluateProjectIntelligence } from "../evaluators/projectEvaluator.js";
import { evaluateTeamIntelligence } from "../evaluators/teamEvaluator.js";
import { evaluateUserIntelligence } from "../evaluators/userEvaluator.js";
import { evaluateWorkspaceIntelligence } from "../evaluators/workspaceEvaluator.js";
import {
  hasEnterpriseIntelligenceSchema,
  recordRecalculationEvent,
  writeSnapshot,
} from "../repositories/unifiedIntelligence.repository.js";

const DEFAULT_DAYS = 0;
const DEFAULT_INTERVAL_DAYS = 7;
const DEFAULT_MAX_ANCHORS = 96;
const DEFAULT_WINDOW_DAYS = 30;
const MATERIALIZATION_VERSION = "dashboard_history_materialization_v2";

function dateKey(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const raw = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function utcDate(key) {
  return new Date(`${key}T00:00:00.000Z`);
}

function endOfDay(key) {
  return new Date(`${key}T23:59:59.999Z`);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function maxDateKey(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return a >= b ? a : b;
}

function minDateKey(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return a <= b ? a : b;
}

function withVersion(result) {
  return {
    ...result,
    calculationVersion: result.calculationVersion || INTELLIGENCE_VERSION,
  };
}

async function listWorkspaceIds(workspaceId = null) {
  if (workspaceId) return [workspaceId];
  const { rows } = await pool.query(
    `SELECT DISTINCT workspace_id
     FROM (
       SELECT workspace_id FROM workspace_users WHERE workspace_id IS NOT NULL
       UNION
       SELECT workspace_id FROM tasks WHERE workspace_id IS NOT NULL
       UNION
       SELECT workspace_id FROM projects WHERE workspace_id IS NOT NULL
       UNION
       SELECT workspace_id FROM workspace_intelligence WHERE workspace_id IS NOT NULL
     ) ws
     ORDER BY workspace_id`
  );
  return rows.map((row) => row.workspace_id).filter(Boolean);
}

async function dateBoundsFromQuery(sql, params) {
  const { rows } = await pool.query(sql, params).catch(() => ({ rows: [] }));
  return {
    minDate: dateKey(rows[0]?.min_date),
    maxDate: dateKey(rows[0]?.max_date),
  };
}

async function getOperationalDateBounds({ workspaceId }) {
  const bounds = await Promise.all([
    dateBoundsFromQuery(
      `SELECT MIN(created_at)::date AS min_date,
              MAX(COALESCE(completed_at, updated_at, created_at))::date AS max_date
       FROM tasks
       WHERE workspace_id = $1`,
      [workspaceId]
    ),
    dateBoundsFromQuery(
      `SELECT MIN(date)::date AS min_date,
              MAX(date)::date AS max_date
       FROM attendance_daily
       WHERE workspace_id = $1`,
      [workspaceId]
    ),
    dateBoundsFromQuery(
      `SELECT MIN(log_date)::date AS min_date,
              MAX(log_date)::date AS max_date
       FROM time_logs
       WHERE workspace_id = $1`,
      [workspaceId]
    ),
    dateBoundsFromQuery(
      `SELECT MIN(c.created_at)::date AS min_date,
              MAX(c.created_at)::date AS max_date
       FROM comments c
       JOIN tasks t ON t.id = c.task_id
       WHERE t.workspace_id = $1`,
      [workspaceId]
    ),
    dateBoundsFromQuery(
      `SELECT MIN(created_at)::date AS min_date,
              MAX(COALESCE(updated_at, created_at))::date AS max_date
       FROM projects
       WHERE workspace_id = $1`,
      [workspaceId]
    ),
  ]);

  return bounds.reduce((acc, item) => ({
    minDate: minDateKey(acc.minDate, item.minDate),
    maxDate: maxDateKey(acc.maxDate, item.maxDate),
  }), { minDate: null, maxDate: null });
}

function buildAnchorDates({ minDate, days = DEFAULT_DAYS, intervalDays = DEFAULT_INTERVAL_DAYS, maxAnchors = DEFAULT_MAX_ANCHORS }) {
  const today = dateKey(new Date());
  const dayLimit = Number(days) || 0;
  let startKey = minDate || today;
  if (dayLimit > 0) {
    const latestStart = new Date();
    latestStart.setUTCDate(latestStart.getUTCDate() - Math.max(1, dayLimit) + 1);
    startKey = maxDateKey(startKey, latestStart.toISOString().slice(0, 10)) || today;
  }

  const anchors = new Set();
  const end = utcDate(today);
  const dailyStart = maxDateKey(startKey, addDays(end, -29).toISOString().slice(0, 10));
  const weeklyStart = maxDateKey(startKey, addDays(end, -182).toISOString().slice(0, 10));
  const step = Math.max(1, Number(intervalDays) || DEFAULT_INTERVAL_DAYS);

  let cursor = utcDate(startKey);
  const weeklyBoundary = weeklyStart ? utcDate(weeklyStart) : end;
  while (cursor < weeklyBoundary) {
    anchors.add(cursor.toISOString().slice(0, 10));
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }

  cursor = utcDate(weeklyStart || startKey);
  const dailyBoundary = dailyStart ? utcDate(dailyStart) : end;
  while (cursor < dailyBoundary) {
    anchors.add(cursor.toISOString().slice(0, 10));
    cursor = addDays(cursor, step);
  }

  cursor = utcDate(dailyStart || startKey);
  while (cursor <= end) {
    anchors.add(cursor.toISOString().slice(0, 10));
    cursor = addDays(cursor, 1);
  }

  anchors.add(today);
  const unique = [...new Set(anchors)].sort();
  const limit = Math.max(2, Number(maxAnchors) || DEFAULT_MAX_ANCHORS);
  if (unique.length <= limit) return unique;

  const dailyCutoff = addDays(end, -29).toISOString().slice(0, 10);
  const protectedRecent = unique.filter((key) => key >= dailyCutoff);
  const older = unique.filter((key) => key < dailyCutoff);
  const sampled = new Set(protectedRecent);
  const olderLimit = Math.max(0, limit - sampled.size);
  if (olderLimit <= 0) return [...sampled].sort().slice(-limit);
  if (older.length <= olderLimit) {
    older.forEach((key) => sampled.add(key));
    return [...sampled].sort();
  }

  sampled.add(older[0]);
  const stride = (older.length - 1) / Math.max(1, olderLimit - 1);
  for (let index = 1; index < olderLimit; index += 1) {
    sampled.add(older[Math.round(index * stride)]);
  }
  return [...sampled].sort();
}

async function withWorkspaceBackfillLock(workspaceId, fn) {
  const client = await pool.connect();
  const lockKey = `dashboard_history:${workspaceId}`;
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [lockKey]);
    if (!rows[0]?.locked) {
      return { skipped: true, reason: "materialization_already_running" };
    }
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

async function getManagerProjectIds({ workspaceId, managerId }) {
  const { rows } = await pool.query(
    `SELECT p.id
     FROM projects p
     JOIN users u ON u.id = $2
     WHERE p.workspace_id = $1
       AND p.id = ANY(u.projects)`,
    [workspaceId, managerId]
  ).catch(() => ({ rows: [] }));
  return rows.map((row) => row.id).filter(Boolean);
}

async function evaluateWorkspaceAtAnchor({ workspaceId, anchorDate, windowDays }) {
  const scope = await collectWorkspaceScope({ workspaceId });
  const now = endOfDay(anchorDate);
  const failures = [];

  const users = [];
  for (const user of scope.users) {
    try {
      const evidence = await collectUserEvidence({ workspaceId, userId: user.id, windowDays, now });
      users.push(withVersion(evaluateUserIntelligence(evidence)));
    } catch (err) {
      failures.push({ scope: "user", id: String(user.id), error: err.message });
    }
  }

  const projects = [];
  for (const project of scope.projects) {
    try {
      const evidence = await collectProjectEvidence({ workspaceId, projectId: project.id, windowDays, now });
      projects.push(withVersion(evaluateProjectIntelligence(evidence)));
    } catch (err) {
      failures.push({ scope: "project", id: String(project.id), error: err.message });
    }
  }

  if (failures.length > 0) {
    return { anchorDate, scope, users, projects, teams: [], workspace: null, failures };
  }

  const teams = [];
  for (const managerId of scope.managers) {
    const managerProjectIds = new Set((await getManagerProjectIds({ workspaceId, managerId })).map(String));
    const memberIds = new Set(
      scope.users
        .filter((user) => String(user.manager_id || "") === String(managerId))
        .map((user) => String(user.id))
    );
    const teamUsers = users.filter((user) => memberIds.has(String(user.userId)));
    const teamProjects = projects.filter((project) => managerProjectIds.has(String(project.projectId)));
    teams.push(withVersion(evaluateTeamIntelligence({
      workspaceId,
      teamKey: `manager:${managerId}`,
      managerId,
      users: teamUsers,
      projects: teamProjects,
    })));
  }

  const evidence = await collectWorkspaceEvidence({ workspaceId, windowDays, now });
  const workspace = withVersion(evaluateWorkspaceIntelligence({
    workspaceId,
    users,
    projects,
    teams,
    evidence,
  }));

  return { anchorDate, scope, users, projects, teams, workspace, failures };
}

async function writeHistoricalSnapshots({ workspaceId, anchorDate, evaluated }) {
  for (const user of evaluated.users) {
    await writeSnapshot({
      scopeType: "user",
      subjectKey: String(user.userId),
      result: { ...user, workspaceId },
      capturedForDate: anchorDate,
    });
  }
  for (const project of evaluated.projects) {
    await writeSnapshot({
      scopeType: "project",
      subjectKey: String(project.projectId),
      result: { ...project, workspaceId },
      capturedForDate: anchorDate,
    });
  }
  for (const team of evaluated.teams) {
    await writeSnapshot({
      scopeType: "team",
      subjectKey: String(team.teamKey),
      result: { ...team, workspaceId },
      capturedForDate: anchorDate,
    });
  }
  if (evaluated.workspace) {
    await writeSnapshot({
      scopeType: "workspace",
      subjectKey: String(workspaceId),
      result: { ...evaluated.workspace, workspaceId },
      capturedForDate: anchorDate,
    });
  }
}

export async function backfillDashboardIntelligenceHistory({
  workspaceId = null,
  days = DEFAULT_DAYS,
  intervalDays = DEFAULT_INTERVAL_DAYS,
  maxAnchors = DEFAULT_MAX_ANCHORS,
  windowDays = DEFAULT_WINDOW_DAYS,
  execute = false,
} = {}) {
  if (!(await hasEnterpriseIntelligenceSchema())) {
    const err = new Error("Enterprise intelligence tables are not installed");
    err.code = "INTELLIGENCE_SCHEMA_MISSING";
    throw err;
  }

  const workspaceIds = await listWorkspaceIds(workspaceId);
  const results = [];

  for (const id of workspaceIds) {
    const bounds = await getOperationalDateBounds({ workspaceId: id });
    const anchorDates = buildAnchorDates({ minDate: bounds.minDate, days, intervalDays, maxAnchors });
    const scope = await collectWorkspaceScope({ workspaceId: id });
    const workspaceResult = {
      workspaceId: id,
      operationalBounds: bounds,
      anchorDates,
      plannedSnapshots: anchorDates.length * (scope.users.length + scope.projects.length + scope.managers.length + 1),
      userCount: scope.users.length,
      projectCount: scope.projects.length,
      teamCount: scope.managers.length,
      executed: execute,
      writtenAnchors: 0,
      failedAnchors: [],
    };

    if (execute) {
      const lockResult = await withWorkspaceBackfillLock(id, async () => {
        for (const anchorDate of anchorDates) {
          const evaluated = await evaluateWorkspaceAtAnchor({ workspaceId: id, anchorDate, windowDays });
          if (evaluated.failures.length > 0) {
            workspaceResult.failedAnchors.push({ anchorDate, failures: evaluated.failures });
            await recordRecalculationEvent({
              workspaceId: id,
              reason: "dashboard_history_backfill",
              status: "failed",
              error: "historical_anchor_evaluation_failed",
              metadata: compactJson({
                anchorDate,
                failures: evaluated.failures,
                calculationVersion: INTELLIGENCE_VERSION,
                materializationVersion: MATERIALIZATION_VERSION,
              }),
            });
            continue;
          }

          await writeHistoricalSnapshots({ workspaceId: id, anchorDate, evaluated });
          workspaceResult.writtenAnchors += 1;
        }
        return { skipped: false };
      });
      workspaceResult.lock = lockResult;

      await recordRecalculationEvent({
        workspaceId: id,
        reason: "dashboard_history_backfill",
        status: workspaceResult.failedAnchors.length ? "failed" : "completed",
        error: workspaceResult.failedAnchors.length ? "some_historical_anchors_failed" : null,
        metadata: compactJson({
          days,
          intervalDays,
          windowDays,
          anchorCount: anchorDates.length,
          writtenAnchors: workspaceResult.writtenAnchors,
          failedAnchors: workspaceResult.failedAnchors.length,
          calculationVersion: INTELLIGENCE_VERSION,
          materializationVersion: MATERIALIZATION_VERSION,
          liveRowsMutated: false,
        }),
      });
    }

    results.push(workspaceResult);
  }

  return {
    execute,
    days,
    intervalDays,
    windowDays,
    maxAnchors,
    workspaceCount: results.length,
    results,
  };
}

export async function ensureDashboardHistoryMaterialized({
  workspaceId,
  scopeType = "workspace",
  subjectKey = String(workspaceId),
  range = "all",
  minimumPoints = 2,
  days = DEFAULT_DAYS,
  maxAnchors = DEFAULT_MAX_ANCHORS,
  windowDays = DEFAULT_WINDOW_DAYS,
} = {}) {
  const { getSnapshotSeries } = await import("../repositories/unifiedIntelligence.repository.js");
  const current = await getSnapshotSeries({
    workspaceId,
    scopeType,
    subjectKey,
    range,
  });
  if (current.length >= minimumPoints) {
    return {
      materialized: false,
      reason: "sufficient_history",
      pointCount: current.length,
    };
  }

  const result = await backfillDashboardIntelligenceHistory({
    workspaceId,
    days,
    maxAnchors,
    windowDays,
    execute: true,
  });
  const refreshed = await getSnapshotSeries({
    workspaceId,
    scopeType,
    subjectKey,
    range,
  });
  return {
    materialized: true,
    beforePointCount: current.length,
    afterPointCount: refreshed.length,
    result,
  };
}

export default {
  backfillDashboardIntelligenceHistory,
  ensureDashboardHistoryMaterialized,
};
