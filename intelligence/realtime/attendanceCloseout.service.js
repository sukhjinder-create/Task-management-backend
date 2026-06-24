import pool from "../../db.js";
import { recalculateImpactedIntelligence } from "../engine/unifiedIntelligence.engine.js";

function yesterdayDateKey() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function listWorkspaceIds(workspaceId = null) {
  if (workspaceId) return [workspaceId];

  const { rows } = await pool.query(
    `SELECT DISTINCT wu.workspace_id
     FROM workspace_users wu
     JOIN workspaces w ON w.id = wu.workspace_id
     WHERE COALESCE(w.is_active, true) = true
     ORDER BY wu.workspace_id`
  ).catch(() => ({ rows: [] }));

  return rows.map((row) => row.workspace_id).filter(Boolean);
}

async function listActiveUserIds(workspaceId) {
  const { rows } = await pool.query(
    `SELECT wu.user_id
     FROM workspace_users wu
     JOIN users u ON u.id = wu.user_id
     WHERE wu.workspace_id = $1
       AND COALESCE(u.is_system, false) = false
       AND COALESCE(u.role, '') NOT IN ('system', 'superadmin')
       AND COALESCE(wu.billing_status, 'active') != 'pending'
     ORDER BY wu.user_id`,
    [workspaceId]
  ).catch(() => ({ rows: [] }));

  return rows.map((row) => row.user_id).filter(Boolean);
}

export async function runAttendanceIntelligenceCloseout({
  date = null,
  workspaceId = null,
} = {}) {
  const closeoutDate = date || yesterdayDateKey();
  const workspaceIds = await listWorkspaceIds(workspaceId);
  const results = [];

  for (const id of workspaceIds) {
    const userIds = await listActiveUserIds(id);
    if (!userIds.length) {
      results.push({ workspaceId: id, users: 0, skipped: true });
      continue;
    }

    try {
      const recalculation = await recalculateImpactedIntelligence({
        workspaceId: id,
        reason: "attendance_day_closed",
        userIds,
        sourceType: "attendance_daily",
        sourceId: closeoutDate,
        metadata: {
          date: closeoutDate,
          mode: "end_of_day",
          affectedUsers: userIds.length,
        },
      });

      results.push({
        workspaceId: id,
        users: recalculation.users.length,
        teams: recalculation.teams.length,
        workspace: Boolean(recalculation.workspace),
      });
    } catch (err) {
      if (err?.code === "INTELLIGENCE_SCHEMA_MISSING") {
        results.push({ workspaceId: id, users: userIds.length, skipped: true, reason: err.code });
        continue;
      }
      throw err;
    }
  }

  return {
    date: closeoutDate,
    workspaces: results.length,
    results,
  };
}

export default {
  runAttendanceIntelligenceCloseout,
};
