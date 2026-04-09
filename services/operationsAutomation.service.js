import pool from "../db.js";
import {
  addDays,
  getApprovedLeaveDateMap,
  getCurrentMonthKey,
  getRecentExpectedWorkingDates,
  getWorkspaceUserMap,
  tableExists,
  toDateKey,
} from "./operationsShared.service.js";
import {
  createOperationsAction,
  findRecentMatchingAction,
} from "./operationsAction.service.js";

const DEFAULT_RULES = [
  {
    key: "absent_overdue_owner",
    name: "Absent owner with overdue work",
    mode: "assist",
    config: {
      workingDaysLookback: 2,
      minOverdueTasks: 1,
      confidence: 0.84,
    },
  },
  {
    key: "leave_due_conflict",
    name: "Approved leave overlaps due work",
    mode: "assist",
    config: {
      lookAheadDays: 7,
      minTasks: 1,
      confidence: 0.82,
    },
  },
  {
    key: "stale_blocked_task",
    name: "Blocked task stagnant beyond threshold",
    mode: "assist",
    config: {
      staleHours: 48,
      confidence: 0.79,
    },
  },
  {
    key: "review_risk_signal",
    name: "Low score with active execution risk",
    mode: "assist",
    config: {
      scoreThreshold: 45,
      minOverdueTasks: 1,
      confidence: 0.76,
    },
  },
];

function mergeRuleState(defaultRule, savedRule) {
  return {
    ...defaultRule,
    enabled: savedRule ? savedRule.enabled : true,
    mode: savedRule?.mode || defaultRule.mode,
    config: {
      ...defaultRule.config,
      ...(savedRule?.config || {}),
    },
  };
}

async function loadSavedRules(workspaceId) {
  const { rows } = await pool.query(
    `
    SELECT rule_key, enabled, mode, config
    FROM operations_automation_rules
    WHERE workspace_id = $1
    `,
    [workspaceId]
  );

  return new Map(rows.map((row) => [row.rule_key, row]));
}

export async function getAutomationRules(workspaceId) {
  const saved = await loadSavedRules(workspaceId);
  return DEFAULT_RULES.map((rule) => mergeRuleState(rule, saved.get(rule.key)));
}

export async function upsertAutomationRule({
  workspaceId,
  ruleKey,
  enabled,
  mode,
  config,
  userId,
}) {
  const knownRule = DEFAULT_RULES.find((rule) => rule.key === ruleKey);
  if (!knownRule) {
    throw new Error("Unknown automation rule");
  }

  const merged = {
    ...knownRule.config,
    ...(config || {}),
  };

  const { rows } = await pool.query(
    `
    INSERT INTO operations_automation_rules (
      workspace_id,
      rule_key,
      enabled,
      mode,
      config,
      created_by,
      updated_by
    )
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$6)
    ON CONFLICT (workspace_id, rule_key)
    DO UPDATE SET
      enabled = EXCLUDED.enabled,
      mode = EXCLUDED.mode,
      config = EXCLUDED.config,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
    RETURNING *
    `,
    [workspaceId, ruleKey, enabled, mode, JSON.stringify(merged), userId]
  );

  return rows[0];
}

async function maybePersistFinding(finding, dryRun) {
  if (dryRun) return finding;

  const duplicate = await findRecentMatchingAction({
    workspaceId: finding.workspaceId,
    actionType: finding.actionType,
    title: finding.title,
    targetUserId: finding.targetUserId || null,
    taskId: finding.taskId || null,
    projectId: finding.projectId || null,
    lookbackHours: 24,
  });

  if (duplicate) {
    return {
      ...finding,
      duplicateOf: duplicate.id,
      persisted: false,
    };
  }

  const action = await createOperationsAction({
    workspaceId: finding.workspaceId,
    source: "automation",
    roleScope: finding.roleScope || "workspace",
    title: finding.title,
    summary: finding.summary,
    explanation: finding.explanation,
    confidence: finding.confidence,
    riskLevel: finding.riskLevel || "medium",
    actionType: finding.actionType,
    targetUserId: finding.targetUserId || null,
    projectId: finding.projectId || null,
    taskId: finding.taskId || null,
    payload: finding.payload || {},
    evidence: finding.evidence || [],
    generatedBy: "operations_automation_engine",
  });

  return {
    ...finding,
    actionId: action.id,
    persisted: true,
  };
}

async function evaluateAbsentOverdueOwners(workspaceId, rule, userMap, dryRun) {
  if (!rule.enabled || !(await tableExists("attendance_daily"))) {
    return [];
  }

  const recentExpectedDates = await getRecentExpectedWorkingDates(
    workspaceId,
    rule.config.workingDaysLookback || 2,
    new Date()
  );

  if (recentExpectedDates.length === 0) {
    return [];
  }

  const { rows: overdueRows } = await pool.query(
    `
    SELECT
      t.assigned_to AS user_id,
      COUNT(*)::int AS overdue_count,
      (ARRAY_AGG(t.project_id ORDER BY t.due_date ASC, t.id ASC))[1] AS project_id,
      ARRAY_AGG(t.id ORDER BY t.due_date ASC, t.id ASC) AS task_ids
    FROM tasks t
    WHERE t.workspace_id = $1
      AND t.assigned_to IS NOT NULL
      AND t.status NOT IN ('completed', 'cancelled')
      AND t.due_date IS NOT NULL
      AND t.due_date < NOW()::date
    GROUP BY t.assigned_to
    HAVING COUNT(*) >= $2
    `,
    [workspaceId, rule.config.minOverdueTasks || 1]
  );

  if (overdueRows.length === 0) {
    return [];
  }

  const userIds = overdueRows.map((row) => row.user_id);
  const leaveMap = await getApprovedLeaveDateMap(
    workspaceId,
    recentExpectedDates[0],
    recentExpectedDates[recentExpectedDates.length - 1],
    userIds
  );

  const { rows: attendanceRows } = await pool.query(
    `
        SELECT user_id, date::text AS date, signed_in_minutes
        FROM attendance_daily
        WHERE workspace_id = $1
          AND user_id = ANY($2)
          AND date::text = ANY($3)
        `,
        [workspaceId, userIds, recentExpectedDates]
      );

  const attendanceMap = new Map();
  for (const row of attendanceRows) {
    const key = `${row.user_id}:${row.date.slice(0, 10)}`;
    attendanceMap.set(key, Number(row.signed_in_minutes) || 0);
  }

  const findings = [];
  for (const row of overdueRows) {
    const user = userMap.get(row.user_id);
    if (!user) continue;

    const leaveDates = leaveMap.get(row.user_id) || new Set();
    const relevantDates = recentExpectedDates.filter((date) => !leaveDates.has(date));
    if (relevantDates.length === 0) continue;

    const absentAll = relevantDates.every((date) => {
      const key = `${row.user_id}:${date}`;
      return !attendanceMap.has(key) || attendanceMap.get(key) <= 0;
    });

    if (!absentAll) continue;

    const finding = await maybePersistFinding({
      workspaceId,
      ruleKey: rule.key,
      title: `${user.username} is absent while owning overdue work`,
      summary: `${user.username} has ${row.overdue_count} overdue task(s) and no attendance captured on the last ${relevantDates.length} expected working day(s).`,
      explanation: "This combines attendance absence with overdue execution risk so managers can intervene before slippage compounds.",
      confidence: rule.config.confidence,
      riskLevel: "high",
      actionType: "notify_supervisors",
      targetUserId: row.user_id,
      projectId: row.project_id,
      taskId: row.task_ids?.[0] || null,
      payload: {
        message: `${user.username} is absent while carrying overdue work. Please review reassignment or unblock support.`,
      },
      evidence: [
        { type: "attendance", recentExpectedDates: relevantDates },
        { type: "overdue_tasks", overdueCount: row.overdue_count, taskIds: row.task_ids || [] },
      ],
    }, dryRun);

    findings.push(finding);
  }

  return findings;
}

async function evaluateLeaveConflicts(workspaceId, rule, userMap, dryRun) {
  if (!rule.enabled) return [];

  const startDate = new Date();
  const endDate = addDays(startDate, rule.config.lookAheadDays || 7);
  const { rows } = await pool.query(
    `
    SELECT
      lr.user_id,
      MIN(lr.start_date)::text AS leave_start,
      MAX(lr.end_date)::text AS leave_end,
      COUNT(DISTINCT t.id)::int AS conflicting_tasks,
      (ARRAY_AGG(t.project_id ORDER BY t.due_date ASC, t.id ASC))[1] AS project_id,
      ARRAY_AGG(t.id ORDER BY t.due_date ASC, t.id ASC) AS task_ids
    FROM leave_requests lr
    JOIN tasks t
      ON t.workspace_id = lr.workspace_id
     AND t.assigned_to = lr.user_id
     AND t.status NOT IN ('completed', 'cancelled')
     AND t.due_date BETWEEN lr.start_date AND lr.end_date
    WHERE lr.workspace_id = $1
      AND lr.status = 'approved'
      AND lr.start_date <= $2
      AND lr.end_date >= $3
    GROUP BY lr.user_id
    HAVING COUNT(DISTINCT t.id) >= $4
    `,
    [workspaceId, toDateKey(endDate), toDateKey(startDate), rule.config.minTasks || 1]
  );

  const findings = [];
  for (const row of rows) {
    const user = userMap.get(row.user_id);
    if (!user) continue;

    const finding = await maybePersistFinding({
      workspaceId,
      ruleKey: rule.key,
      title: `${user.username} has due work during approved leave`,
      summary: `${row.conflicting_tasks} task(s) are due while ${user.username} is on approved leave from ${row.leave_start} to ${row.leave_end}.`,
      explanation: "This catches schedule conflicts between approved leave and active commitments before they turn into missed deadlines.",
      confidence: rule.config.confidence,
      riskLevel: "high",
      actionType: "notify_user_and_supervisors",
      targetUserId: row.user_id,
      projectId: row.project_id,
      taskId: row.task_ids?.[0] || null,
      payload: {
        message: `${user.username} has due work during approved leave. Please realign ownership or due dates.`,
      },
      evidence: [
        { type: "leave_window", start: row.leave_start, end: row.leave_end },
        { type: "conflicting_tasks", count: row.conflicting_tasks, taskIds: row.task_ids || [] },
      ],
    }, dryRun);

    findings.push(finding);
  }

  return findings;
}

async function evaluateStaleBlockedTasks(workspaceId, rule, dryRun) {
  if (!rule.enabled || !(await tableExists("task_links"))) {
    return [];
  }

  const { rows } = await pool.query(
    `
    SELECT
      t.id AS task_id,
      t.task,
      t.project_id,
      t.assigned_to,
      t.updated_at,
      COUNT(tl.id)::int AS blocker_count
    FROM tasks t
    JOIN task_links tl
      ON tl.target_task_id = t.id
     AND tl.link_type = 'is_blocked_by'
    WHERE t.workspace_id = $1
      AND t.status NOT IN ('completed', 'cancelled')
      AND t.updated_at < NOW() - ($2::text || ' hours')::interval
    GROUP BY t.id
    ORDER BY t.updated_at ASC
    LIMIT 10
    `,
    [workspaceId, String(rule.config.staleHours || 48)]
  );

  const findings = [];
  for (const row of rows) {
    const finding = await maybePersistFinding({
      workspaceId,
      ruleKey: rule.key,
      title: `Blocked task "${row.task}" is stale`,
      summary: `Blocked task "${row.task}" has not moved for more than ${rule.config.staleHours || 48} hours.`,
      explanation: "This identifies blocked work that has gone quiet long enough to justify a visible manager checkpoint.",
      confidence: rule.config.confidence,
      riskLevel: "medium",
      actionType: "create_followup_task",
      targetUserId: row.assigned_to,
      projectId: row.project_id,
      taskId: row.task_id,
      payload: {
        projectId: row.project_id,
        taskTitle: `Checkpoint: unblock "${row.task}"`,
        description: `Auto-generated follow-up because the blocked task "${row.task}" has been stagnant beyond the configured threshold.`,
        priority: "high",
        dueDate: toDateKey(addDays(new Date(), 2)),
      },
      evidence: [
        { type: "blocked_task", blockerCount: row.blocker_count, updatedAt: row.updated_at },
      ],
    }, dryRun);

    findings.push(finding);
  }

  return findings;
}

async function evaluateReviewRiskSignals(workspaceId, rule, userMap, dryRun) {
  if (!rule.enabled || !(await tableExists("workspace_monthly_scores"))) {
    return [];
  }

  const month = getCurrentMonthKey();
  const { rows } = await pool.query(
    `
    SELECT
      wms.user_id,
      wms.score,
      COUNT(t.id)::int AS overdue_count,
      (ARRAY_AGG(t.project_id ORDER BY t.due_date ASC, t.id ASC) FILTER (WHERE t.project_id IS NOT NULL))[1] AS project_id,
      ARRAY_AGG(t.id ORDER BY t.due_date ASC, t.id ASC) FILTER (WHERE t.id IS NOT NULL) AS task_ids
    FROM workspace_monthly_scores wms
    LEFT JOIN tasks t
      ON t.workspace_id = wms.workspace_id
     AND t.assigned_to = wms.user_id
     AND t.status NOT IN ('completed', 'cancelled')
     AND t.due_date IS NOT NULL
     AND t.due_date < NOW()::date
    WHERE wms.workspace_id = $1
      AND wms.month = $2
      AND wms.score <= $3
    GROUP BY wms.user_id, wms.score
    HAVING COUNT(t.id) >= $4
    `,
    [workspaceId, month, rule.config.scoreThreshold || 45, rule.config.minOverdueTasks || 1]
  );

  const findings = [];
  for (const row of rows) {
    const user = userMap.get(row.user_id);
    if (!user) continue;

    const finding = await maybePersistFinding({
      workspaceId,
      ruleKey: rule.key,
      title: `Execution risk detected for ${user.username}`,
      summary: `${user.username} scored ${row.score} this month and still carries ${row.overdue_count} overdue task(s).`,
      explanation: "This joins score deterioration with active overdue work so managers can intervene with context, not just intuition.",
      confidence: rule.config.confidence,
      riskLevel: "high",
      actionType: "notify_supervisors",
      targetUserId: row.user_id,
      projectId: row.project_id,
      taskId: row.task_ids?.[0] || null,
      payload: {
        message: `${user.username} shows combined scoring and delivery risk. Consider a coaching checkpoint this week.`,
      },
      evidence: [
        { type: "score", month, score: Number(row.score) || 0 },
        { type: "overdue_tasks", overdueCount: row.overdue_count, taskIds: row.task_ids || [] },
      ],
    }, dryRun);

    findings.push(finding);
  }

  return findings;
}

export async function evaluateWorkspaceAutomations({
  workspaceId,
  dryRun = false,
}) {
  const [rules, userMap] = await Promise.all([
    getAutomationRules(workspaceId),
    getWorkspaceUserMap(workspaceId),
  ]);

  const findings = [];
  for (const rule of rules) {
    if (rule.key === "absent_overdue_owner") {
      findings.push(...await evaluateAbsentOverdueOwners(workspaceId, rule, userMap, dryRun));
    } else if (rule.key === "leave_due_conflict") {
      findings.push(...await evaluateLeaveConflicts(workspaceId, rule, userMap, dryRun));
    } else if (rule.key === "stale_blocked_task") {
      findings.push(...await evaluateStaleBlockedTasks(workspaceId, rule, dryRun));
    } else if (rule.key === "review_risk_signal") {
      findings.push(...await evaluateReviewRiskSignals(workspaceId, rule, userMap, dryRun));
    }
  }

  return {
    workspaceId,
    dryRun,
    findings,
    generated: findings.length,
    created: findings.filter((item) => item.persisted === true).length,
  };
}
