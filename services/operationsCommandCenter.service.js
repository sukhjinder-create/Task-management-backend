import pool from "../db.js";
import { getDashboardOverview } from "./dashboard.service.js";
import { evaluateWorkspaceAutomations } from "./operationsAutomation.service.js";
import { listOperationsActions } from "./operationsAction.service.js";
import { listWorkspaceMemoryEntries } from "./workspaceMemory.service.js";
import {
  getApprovedLeaveDateMap,
  resolveOperationsScope,
  tableExists,
  toDateKey,
} from "./operationsShared.service.js";

function taskAssignmentClause(role, idx) {
  return role === "user" ? ` AND t.assigned_to = $${idx}` : "";
}

async function getScopedUserIds({ workspaceId, userId, role, scope }) {
  if (role === "user") return [userId];
  if (role === "admin" || role === "owner") {
    const { rows } = await pool.query(
      `
      SELECT u.id
      FROM users u
      JOIN workspace_users wu ON wu.user_id = u.id AND wu.workspace_id = $1
      WHERE wu.billing_status != 'pending'
        AND (u.is_system IS NULL OR u.is_system = FALSE)
        AND u.role != 'system'
      `,
      [workspaceId]
    );
    return rows.map((row) => row.id);
  }

  const { rows } = await pool.query(
    `
    SELECT DISTINCT t.assigned_to AS user_id
    FROM tasks t
    WHERE t.workspace_id = $1
      AND t.project_id = ANY($2)
      AND t.assigned_to IS NOT NULL
    `,
    [workspaceId, scope.projectIds]
  );
  return Array.from(new Set([userId, ...rows.map((row) => row.user_id)]));
}

async function getPriorityQueue({ workspaceId, userId, role, scope }) {
  if (!scope.projectIds.length) return [];

  const params = [workspaceId, scope.projectIds];
  let idx = 3;
  let assignmentFilter = "";
  if (role === "user") {
    assignmentFilter = ` AND t.assigned_to = $${idx}`;
    params.push(userId);
    idx += 1;
  }

  params.push(8);

  const { rows } = await pool.query(
    `
    SELECT
      t.id,
      t.task,
      t.status,
      t.priority,
      t.due_date,
      t.project_id,
      p.name AS project_name,
      CASE
        WHEN t.due_date IS NULL THEN 3
        WHEN t.due_date < NOW()::date THEN 0
        WHEN t.due_date = NOW()::date THEN 1
        ELSE 2
      END AS urgency_rank
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE t.workspace_id = $1
      AND t.project_id = ANY($2)
      AND t.status NOT IN ('completed', 'cancelled')
      ${assignmentFilter}
    ORDER BY urgency_rank ASC,
             CASE t.priority
               WHEN 'critical' THEN 0
               WHEN 'high' THEN 1
               WHEN 'medium' THEN 2
               ELSE 3
             END ASC,
             t.due_date ASC NULLS LAST
    LIMIT $${idx}
    `,
    params
  );

  return rows;
}

async function getPeopleSignals({ workspaceId, role, scope, scopedUserIds }) {
  const today = toDateKey(new Date());
  const signals = {
    onLeaveToday: [],
    absentToday: [],
  };

  if (role === "user") {
    return signals;
  }

  if (await tableExists("leave_requests")) {
    const { rows: leaveRows } = await pool.query(
      `
      SELECT
        lr.user_id,
        u.username,
        lr.start_date::text AS start_date,
        lr.end_date::text AS end_date
      FROM leave_requests lr
      JOIN users u ON u.id = lr.user_id
      WHERE lr.workspace_id = $1
        AND lr.status = 'approved'
        AND $2 BETWEEN lr.start_date AND lr.end_date
        AND lr.user_id = ANY($3)
      ORDER BY u.username ASC
      `,
      [workspaceId, today, scopedUserIds]
    );
    signals.onLeaveToday = leaveRows;
  }

  if (await tableExists("attendance_daily")) {
    const leaveMap = await getApprovedLeaveDateMap(workspaceId, today, today, scopedUserIds);
    const activeUserIds = scopedUserIds.filter((id) => !(leaveMap.get(id) || new Set()).has(today));

    if (activeUserIds.length > 0) {
      const { rows: attendanceRows } = await pool.query(
        `
        SELECT user_id
        FROM attendance_daily
        WHERE workspace_id = $1
          AND date = $2
          AND user_id = ANY($3)
          AND signed_in_minutes > 0
        `,
        [workspaceId, today, activeUserIds]
      );

      const presentSet = new Set(attendanceRows.map((row) => String(row.user_id)));
      const { rows: absentRows } = await pool.query(
        `
        SELECT u.id, u.username
        FROM users u
        WHERE u.id = ANY($1)
        ORDER BY u.username ASC
        `,
        [activeUserIds.filter((id) => !presentSet.has(String(id)))]
      );
      signals.absentToday = absentRows;
    }
  }

  return signals;
}

async function getGoalSignals(workspaceId, role, userId) {
  if (!(await tableExists("okr_objectives"))) {
    return [];
  }

  const params = [workspaceId];
  let ownershipFilter = "";
  if (role === "user") {
    ownershipFilter = ` AND (o.owner_id = $2 OR o.owner_id IS NULL)`;
    params.push(userId);
  }

  const { rows } = await pool.query(
    `
    SELECT id, title, status, progress, time_period
    FROM okr_objectives o
    WHERE o.workspace_id = $1
      ${ownershipFilter}
      AND o.status IN ('at_risk', 'off_track')
    ORDER BY o.updated_at DESC
    LIMIT 5
    `,
    params
  );

  return rows;
}

async function getReviewSignals(workspaceId, role, userId) {
  if (!(await tableExists("performance_reviews"))) {
    return { pending: 0, items: [] };
  }

  const params = [workspaceId];
  let scopeFilter = "";
  if (role === "user") {
    scopeFilter = ` AND (pr.reviewee_id = $2 OR pr.reviewer_id = $2)`;
    params.push(userId);
  }

  const { rows } = await pool.query(
    `
    SELECT
      pr.id,
      pr.type,
      pr.status,
      pr.reviewee_id,
      reviewee.username AS reviewee_name,
      reviewer.username AS reviewer_name,
      rc.name AS cycle_name
    FROM performance_reviews pr
    JOIN review_cycles rc ON rc.id = pr.cycle_id
    LEFT JOIN users reviewee ON reviewee.id = pr.reviewee_id
    LEFT JOIN users reviewer ON reviewer.id = pr.reviewer_id
    WHERE rc.workspace_id = $1
      ${scopeFilter}
      AND pr.status IN ('pending', 'in_progress')
    ORDER BY rc.end_date ASC NULLS LAST, pr.created_at DESC
    LIMIT 6
    `,
    params
  );

  return {
    pending: rows.length,
    items: rows,
  };
}

async function getAutopilotSignals(workspaceId, role, userId, scope) {
  if (!(await tableExists("autopilot_actions"))) {
    return { pending: 0, recent: [] };
  }

  const params = [workspaceId];
  const conditions = [`workspace_id = $1`, `status = 'pending'`];
  let idx = 2;

  if (role === "manager" && scope.projectIds.length > 0) {
    conditions.push(`project_id = ANY($${idx})`);
    params.push(scope.projectIds);
    idx += 1;
  } else if (role === "user") {
    conditions.push(`created_by = $${idx}`);
    params.push(userId);
    idx += 1;
  }

  const { rows } = await pool.query(
    `
    SELECT id, action_type, reason, project_id, task_id, confidence_score, created_at
    FROM autopilot_actions
    WHERE ${conditions.join(" AND ")}
    ORDER BY confidence_score DESC NULLS LAST, created_at DESC
    LIMIT 5
    `,
    params
  );

  return {
    pending: rows.length,
    recent: rows,
  };
}

async function getLatestDigestMeta(workspaceId, userId) {
  if (!(await tableExists("workspace_digest_runs"))) {
    return null;
  }

  const { rows } = await pool.query(
    `
    SELECT id, digest_type, delivery_mode, created_at
    FROM workspace_digest_runs
    WHERE workspace_id = $1
      AND user_id = $2
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [workspaceId, userId]
  );

  return rows[0] || null;
}

function buildRoleNarrative({ role, overview, priorities, approvals, peopleSignals, automationPreview }) {
  if (role === "user") {
    return `Focus on ${priorities.length} priority item(s), ${overview.counts?.overdueTasks || 0} overdue task(s), and ${approvals.pendingOperationsActions} pending AI suggestion(s).`;
  }

  return `Operating posture is ${overview.scoreCard?.band || "Watch"} with ${overview.counts?.overdueTasks || 0} overdue task(s), ${peopleSignals.absentToday.length} absent member(s), ${approvals.pendingOperationsActions} pending operations action(s), and ${automationPreview.findings.length} automation signal(s).`;
}

export async function getOperationsCommandCenter({ workspaceId, userId, role }) {
  const [overview, scope] = await Promise.all([
    getDashboardOverview({ workspaceId, userId, role }),
    resolveOperationsScope({ workspaceId, userId, role }),
  ]);

  const scopedUserIds = await getScopedUserIds({ workspaceId, userId, role, scope });

  const [
    priorities,
    peopleSignals,
    goalSignals,
    reviewSignals,
    pendingOperationsActions,
    memoryHighlights,
    automationPreview,
    autopilotSignals,
    latestDigest,
  ] = await Promise.all([
    getPriorityQueue({ workspaceId, userId, role, scope }),
    getPeopleSignals({ workspaceId, role, scope, scopedUserIds }),
    getGoalSignals(workspaceId, role, userId),
    getReviewSignals(workspaceId, role, userId),
    listOperationsActions({ workspaceId, userId, role, status: "pending", limit: 6 }),
    listWorkspaceMemoryEntries({ workspaceId, userId, role, limit: 5 }),
    role === "admin" || role === "owner" || role === "manager"
      ? evaluateWorkspaceAutomations({ workspaceId, dryRun: true })
      : Promise.resolve({ findings: [], generated: 0, created: 0 }),
    getAutopilotSignals(workspaceId, role, userId, scope),
    getLatestDigestMeta(workspaceId, userId),
  ]);

  const approvals = {
    pendingOperationsActions: pendingOperationsActions.length,
    pendingAutopilotActions: autopilotSignals.pending,
    operationsActions: pendingOperationsActions,
    autopilotActions: autopilotSignals.recent,
  };

  return {
    generatedAt: new Date().toISOString(),
    role,
    month: overview.month,
    scope: overview.scope,
    posture: {
      healthScore: overview.healthScore,
      scoreCard: overview.scoreCard,
      trend: overview.trend,
      counts: overview.counts,
    },
    priorities,
    peopleSignals,
    approvals,
    automationPreview,
    goalSignals,
    reviewSignals,
    memoryHighlights,
    latestDigest,
    executiveSummary: overview.executiveSummary,
    narrative: buildRoleNarrative({
      role,
      overview,
      priorities,
      approvals,
      peopleSignals,
      automationPreview,
    }),
  };
}

export async function getDailyOperatingSystem({ workspaceId, userId, role }) {
  const commandCenter = await getOperationsCommandCenter({ workspaceId, userId, role });

  return {
    generatedAt: commandCenter.generatedAt,
    role,
    headline: commandCenter.executiveSummary?.headline || "Daily operating system",
    narrative: commandCenter.narrative,
    now: {
      priorities: commandCenter.priorities.slice(0, 5),
      approvals: commandCenter.approvals,
      peopleSignals: commandCenter.peopleSignals,
    },
    watchlist: {
      goals: commandCenter.goalSignals,
      reviews: commandCenter.reviewSignals.items,
      automation: commandCenter.automationPreview.findings.slice(0, 5),
    },
    memory: commandCenter.memoryHighlights,
    posture: commandCenter.posture,
  };
}
