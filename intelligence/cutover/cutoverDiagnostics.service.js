import pool from "../../db.js";
import { getRecalculationQueueDiagnostics } from "../realtime/recalculation.service.js";
import {
  CORE_CUTOVER_SURFACES,
  ISOLATED_NON_CORE_SURFACES,
  listEnterpriseIntelligenceCutoverControls,
  resolveEnterpriseIntelligenceCutoverPolicy,
} from "./enterpriseIntelligenceCutover.policy.js";

const STALE_HOURS = 24;

async function safeQuery(sql, params = []) {
  return pool.query(sql, params).catch((err) => ({
    rows: [],
    error: { message: err.message, code: err.code || null },
  }));
}

function number(value) {
  return Number(value) || 0;
}

function rowError(result) {
  return result.error || null;
}

export async function getEnterpriseIntelligenceCutoverDiagnostics({ workspaceId }) {
  const [
    controls,
    activeUsers,
    userRows,
    activeProjects,
    projectRows,
    teamRows,
    workspaceRows,
    staleUsers,
    staleProjects,
    staleTeams,
    staleWorkspace,
    snapshotRows,
    failedRecalculations,
  ] = await Promise.all([
    listEnterpriseIntelligenceCutoverControls({ workspaceId }),
    safeQuery(
      `SELECT COUNT(DISTINCT wu.user_id)::int AS count
       FROM workspace_users wu
       JOIN users u ON u.id = wu.user_id
       WHERE wu.workspace_id = $1
         AND u.role NOT IN ('superadmin', 'system')`,
      [workspaceId]
    ),
    safeQuery(
      `SELECT COUNT(*)::int AS count
       FROM user_intelligence
       WHERE workspace_id = $1`,
      [workspaceId]
    ),
    safeQuery(
      `SELECT COUNT(*)::int AS count
       FROM projects
       WHERE workspace_id = $1`,
      [workspaceId]
    ),
    safeQuery(
      `SELECT COUNT(*)::int AS count
       FROM project_intelligence
       WHERE workspace_id = $1`,
      [workspaceId]
    ),
    safeQuery(
      `SELECT COUNT(*)::int AS count
       FROM team_intelligence
       WHERE workspace_id = $1`,
      [workspaceId]
    ),
    safeQuery(
      `SELECT COUNT(*)::int AS count, MAX(last_evaluated_at) AS latest
       FROM workspace_intelligence
       WHERE workspace_id = $1`,
      [workspaceId]
    ),
    safeQuery(
      `SELECT COUNT(*)::int AS count
       FROM user_intelligence
       WHERE workspace_id = $1
         AND last_evaluated_at < now() - ($2::int * INTERVAL '1 hour')`,
      [workspaceId, STALE_HOURS]
    ),
    safeQuery(
      `SELECT COUNT(*)::int AS count
       FROM project_intelligence
       WHERE workspace_id = $1
         AND last_evaluated_at < now() - ($2::int * INTERVAL '1 hour')`,
      [workspaceId, STALE_HOURS]
    ),
    safeQuery(
      `SELECT COUNT(*)::int AS count
       FROM team_intelligence
       WHERE workspace_id = $1
         AND last_evaluated_at < now() - ($2::int * INTERVAL '1 hour')`,
      [workspaceId, STALE_HOURS]
    ),
    safeQuery(
      `SELECT COUNT(*)::int AS count
       FROM workspace_intelligence
       WHERE workspace_id = $1
         AND last_evaluated_at < now() - ($2::int * INTERVAL '1 hour')`,
      [workspaceId, STALE_HOURS]
    ),
    safeQuery(
      `SELECT COUNT(*)::int AS count, MAX(captured_at) AS latest
       FROM intelligence_snapshots
       WHERE workspace_id = $1
         AND captured_for_date >= CURRENT_DATE - INTERVAL '7 days'`,
      [workspaceId]
    ),
    safeQuery(
      `SELECT COUNT(*)::int AS count
       FROM intelligence_recalculation_events
       WHERE workspace_id = $1
         AND status = 'failed'
         AND created_at >= now() - INTERVAL '24 hours'`,
      [workspaceId]
    ),
  ]);

  const activeUserCount = number(activeUsers.rows[0]?.count);
  const userIntelCount = number(userRows.rows[0]?.count);
  const activeProjectCount = number(activeProjects.rows[0]?.count);
  const projectIntelCount = number(projectRows.rows[0]?.count);
  const workspaceIntelCount = number(workspaceRows.rows[0]?.count);

  const missing = {
    users: Math.max(0, activeUserCount - userIntelCount),
    projects: Math.max(0, activeProjectCount - projectIntelCount),
    workspace: workspaceIntelCount > 0 ? 0 : 1,
  };

  const stale = {
    users: number(staleUsers.rows[0]?.count),
    projects: number(staleProjects.rows[0]?.count),
    teams: number(staleTeams.rows[0]?.count),
    workspace: number(staleWorkspace.rows[0]?.count),
    staleAfterHours: STALE_HOURS,
  };

  const errors = [
    rowError(activeUsers),
    rowError(userRows),
    rowError(activeProjects),
    rowError(projectRows),
    rowError(teamRows),
    rowError(workspaceRows),
    rowError(snapshotRows),
    rowError(failedRecalculations),
  ].filter(Boolean);

  const policies = {};
  for (const surface of CORE_CUTOVER_SURFACES) {
    policies[surface] = await resolveEnterpriseIntelligenceCutoverPolicy({ workspaceId, surface });
  }

  const queue = getRecalculationQueueDiagnostics();
  const healthStatus =
    errors.length > 0 ||
    missing.workspace > 0 ||
    missing.users > 0 ||
    missing.projects > 0 ||
    number(failedRecalculations.rows[0]?.count) > 0
      ? "attention_required"
      : stale.users || stale.projects || stale.teams || stale.workspace || queue.pendingJobs > 20
        ? "watch"
        : "healthy";

  return {
    source: "enterprise_intelligence_cutover_diagnostics",
    workspaceId,
    generatedAt: new Date().toISOString(),
    status: healthStatus,
    controls,
    policies,
    queue,
    completeness: {
      activeUsers: activeUserCount,
      userIntelligenceRows: userIntelCount,
      activeProjects: activeProjectCount,
      projectIntelligenceRows: projectIntelCount,
      teamIntelligenceRows: number(teamRows.rows[0]?.count),
      workspaceIntelligenceRows: workspaceIntelCount,
      missing,
    },
    freshness: {
      latestWorkspaceComputedAt: workspaceRows.rows[0]?.latest || null,
      snapshotsLast7Days: number(snapshotRows.rows[0]?.count),
      latestSnapshotCapturedAt: snapshotRows.rows[0]?.latest || null,
      stale,
    },
    failures: {
      recalculationFailures24h: number(failedRecalculations.rows[0]?.count),
      queryErrors: errors,
    },
    isolatedNonCoreSurfaces: ISOLATED_NON_CORE_SURFACES,
  };
}

export default {
  getEnterpriseIntelligenceCutoverDiagnostics,
};
