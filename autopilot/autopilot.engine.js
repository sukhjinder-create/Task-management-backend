// autopilot/autopilot.engine.js
import pool from "../db.js";
import {
  createChannel,
  getChannelByKey,
  ensureChannelMember,
  createChatMessage,
} from "../services/chat.service.js";
import { ensureSystemUser } from "../services/ai.system.service.js";

/**
 * 🤖 AI AUTOPILOT ENGINE
 *
 * This is the brain that analyzes workspace state and proposes intelligent actions.
 * It doesn't execute actions - it creates proposals that need approval (or auto-approve based on settings).
 */

/* =====================================================
   CORE ANALYSIS ENGINE
===================================================== */

/**
 * Main autopilot analysis runner
 * Scans workspace/project and generates actions
 */
export async function runAutopilotAnalysis({ workspaceId, projectId = null, skipStandup = false, sinceTimestamp = null, periodLabel = null, standupOnly = false, reportDate = null }) {
  console.log(`🤖 Running autopilot analysis for workspace: ${workspaceId}, project: ${projectId || 'all'}`);

  // Get autopilot settings
  const settings = await getAutopilotSettings(workspaceId, projectId);

  if (!settings || !settings.enabled) {
    return { message: 'Autopilot is disabled', actionsCreated: 0 };
  }

  // Run enabled analysis modules in parallel for better throughput.
  const modulePromises = [];
  if (!standupOnly && settings.auto_assign) {
    modulePromises.push(analyzeUnassignedTasks(workspaceId, projectId, settings));
  }
  if (!standupOnly && settings.auto_deadline_adjust) {
    modulePromises.push(analyzeDeadlines(workspaceId, projectId, settings));
  }
  if (!standupOnly && settings.auto_escalate_blockers) {
    modulePromises.push(analyzeBlockers(workspaceId, projectId, settings));
  }
  // Standups run on a dedicated daily cron — skip here to avoid duplicates
  if (!skipStandup && settings.auto_generate_standup) {
    modulePromises.push(generateStandupSummary(workspaceId, projectId, settings, sinceTimestamp, periodLabel, reportDate));
  }
  // Always analyse overdue tasks
  if (!standupOnly) {
    modulePromises.push(analyzeOverdueTasks(workspaceId, projectId, settings));
  }

  const moduleResults = await Promise.all(modulePromises);
  const actions = moduleResults.flat().filter(Boolean);
  const uniqueActions = dedupeActionsInMemory(actions);

  // Create action records with bounded concurrency to reduce runtime latency.
  const createdActions = await runWithConcurrency(uniqueActions, 8, async (action) => {
    return await createAutopilotAction({
      workspaceId,
      projectId: action.projectId,
      taskId: action.taskId,
      actionType: action.type,
      reason: action.reason,
      currentState: action.currentState,
      proposedChanges: action.proposedChanges,
      confidenceScore: action.confidence,
      // Standups are informational — always bypass approval and post immediately
      requireApproval: action.type === 'create_standup' ? false : settings.require_approval,
      autoApproveAfterHours: action.type === 'create_standup' ? 0 : settings.auto_approve_after_hours,
    });
  });

  const validActions = createdActions.filter(Boolean);

  // Execute auto_approved actions immediately (e.g. standups).
  // processAutoApprovals only handles 'pending' actions, so auto_approved ones
  // must be executed here or they never run.
  const autoApprovedActions = validActions.filter(a => a.status === 'auto_approved');
  for (const action of autoApprovedActions) {
    try {
      await executeAutopilotAction(action.id, null);
    } catch (err) {
      console.error(`Failed to immediately execute auto_approved action ${action.id}:`, err.message);
    }
  }

  return {
    actionsCreated: validActions.length,
    actions: validActions,
    settings,
  };
}

/* =====================================================
   ANALYSIS MODULES
===================================================== */

/**
 * Analyze unassigned tasks and propose assignments
 */
async function analyzeUnassignedTasks(workspaceId, projectId, settings) {
  const query = projectId
    ? `SELECT t.* FROM tasks t WHERE t.workspace_id = $1 AND t.project_id = $2 AND t.assigned_to IS NULL AND t.status != 'completed'`
    : `SELECT t.* FROM tasks t WHERE t.workspace_id = $1 AND t.assigned_to IS NULL AND t.status != 'completed'`;

  const params = projectId ? [workspaceId, projectId] : [workspaceId];
  const { rows: unassignedTasks } = await pool.query(query, params);

  if (unassignedTasks.length === 0) {
    return [];
  }

  // Get user workload data
  const { rows: workloads } = await pool.query(`
    SELECT * FROM user_workload_view
    WHERE workspace_id = $1
    ORDER BY active_tasks ASC, avg_completion_days ASC
  `, [workspaceId]);

  // Get all workspace users for fallback
  const { rows: allUsers } = await pool.query(`
    SELECT u.id, u.username, u.email
    FROM users u
    WHERE u.workspace_id = $1 AND u.role IN ('user', 'manager', 'admin')
  `, [workspaceId]);

  const actions = [];
  const userMap = new Map();
  for (const u of allUsers) {
    userMap.set(u.id, u.username || u.email || "unknown");
  }

  // Build workload map for O(1) lookup
  const workloadMap = new Map();
  for (const w of workloads) workloadMap.set(w.user_id, w);

  // Priority score: higher = more urgent assignment
  const priorityScore = { critical: 4, urgent: 3, high: 2, medium: 1, low: 0 };

  // Get per-project completion history for users (to find domain experts)
  const projectIds = [...new Set(unassignedTasks.map(t => t.project_id).filter(Boolean))];
  const historyMap = new Map(); // key: `${userId}_${projectId}` → completed count
  if (projectIds.length > 0) {
    const { rows: histRows } = await pool.query(`
      SELECT assigned_to AS user_id, project_id, COUNT(*) AS cnt
      FROM tasks
      WHERE workspace_id = $1
        AND project_id = ANY($2)
        AND status = 'completed'
        AND assigned_to IS NOT NULL
      GROUP BY assigned_to, project_id
    `, [workspaceId, projectIds]);
    for (const r of histRows) {
      historyMap.set(`${r.user_id}_${r.project_id}`, Number(r.cnt));
    }
  }

  for (const task of unassignedTasks) {
    const taskPriority = priorityScore[task.priority] ?? 1;

    // Score each user: capacity + project history
    let bestUser = null;
    let bestScore = -Infinity;
    let bestReason = '';

    const candidateUsers = workloads.length > 0
      ? workloads.map(w => ({ id: w.user_id, activeTasks: w.active_tasks, overdueTasks: w.overdue_tasks, avgDays: w.avg_completion_days || 0 }))
      : allUsers.map(u => ({ id: u.id, activeTasks: 0, overdueTasks: 0, avgDays: 0 }));

    for (const candidate of candidateUsers) {
      if (candidate.activeTasks >= settings.max_tasks_per_user * 1.5) continue; // hard cap
      const capacityScore = (settings.max_tasks_per_user - candidate.activeTasks) * 2;
      const overduepenalty = candidate.overdueTasks * -3;
      const historyBonus = (historyMap.get(`${candidate.id}_${task.project_id}`) || 0) * 1.5;
      const velocityBonus = candidate.avgDays > 0 ? Math.max(0, 10 - candidate.avgDays) : 0;
      const score = capacityScore + overduepenalty + historyBonus + velocityBonus;

      if (score > bestScore) {
        bestScore = score;
        bestUser = candidate.id;
        const isExpert = historyBonus > 0;
        bestReason = isExpert
          ? `Assigned based on project history (${Math.round(historyBonus / 1.5)} prior completions), ${candidate.activeTasks} active tasks, avg ${Math.round(candidate.avgDays)} days completion.`
          : `Lowest workload: ${candidate.activeTasks} active tasks, no overdue issues, avg ${Math.round(candidate.avgDays)} days.`;
      }
    }

    // Fallback if all over hard cap
    if (!bestUser && allUsers.length > 0) {
      bestUser = allUsers[0].id;
      bestReason = 'All users at capacity. Assigning to first available team member.';
    }

    if (bestUser) {
      const confidence = bestScore > 5 ? 0.88 : bestScore > 0 ? 0.70 : 0.50;
      actions.push({
        type: 'reassign',
        taskId: task.id,
        projectId: task.project_id,
        reason: `Unassigned ${task.priority || 'medium'}-priority task detected. ${bestReason}`,
        currentState: {
          task: task.task,
          assigned_to: null,
          status: task.status,
          due_date: task.due_date,
          priority: task.priority,
        },
        proposedChanges: {
          assigned_to: bestUser,
          assigned_to_username: userMap.get(bestUser) || "unknown",
        },
        confidence,
      });
    }
  }

  return actions;
}

/**
 * Analyze deadlines and propose adjustments based on velocity
 */
async function analyzeDeadlines(workspaceId, projectId, settings) {
  // Get tasks approaching deadline with incomplete subtasks or low progress
  const query = projectId
    ? `SELECT t.*,
        COALESCE(st.total_subtasks, 0) as subtasks_total,
        COALESCE(st.completed_subtasks, 0) as subtasks_completed,
        EXTRACT(DAY FROM (t.due_date - NOW())) as days_until_due
      FROM tasks t
      LEFT JOIN (
        SELECT task_id,
          COUNT(*) as total_subtasks,
          COUNT(*) FILTER (WHERE status = 'completed') as completed_subtasks
        FROM subtasks
        GROUP BY task_id
      ) st ON st.task_id = t.id
      WHERE t.workspace_id = $1
        AND t.project_id = $2
        AND t.status NOT IN ('completed', 'cancelled')
        AND t.due_date IS NOT NULL
        AND t.due_date > NOW()
        AND t.due_date < NOW() + INTERVAL '7 days'`
    : `SELECT t.*,
        COALESCE(st.total_subtasks, 0) as subtasks_total,
        COALESCE(st.completed_subtasks, 0) as subtasks_completed,
        EXTRACT(DAY FROM (t.due_date - NOW())) as days_until_due
      FROM tasks t
      LEFT JOIN (
        SELECT task_id,
          COUNT(*) as total_subtasks,
          COUNT(*) FILTER (WHERE status = 'completed') as completed_subtasks
        FROM subtasks
        GROUP BY task_id
      ) st ON st.task_id = t.id
      WHERE t.workspace_id = $1
        AND t.status NOT IN ('completed', 'cancelled')
        AND t.due_date IS NOT NULL
        AND t.due_date > NOW()
        AND t.due_date < NOW() + INTERVAL '7 days'`;

  const params = projectId ? [workspaceId, projectId] : [workspaceId];
  const { rows: tasks } = await pool.query(query, params);

  const actions = [];

  for (const task of tasks) {
    const completion_rate = task.subtasks_total > 0
      ? task.subtasks_completed / task.subtasks_total
      : (task.progress || 0) / 100;

    const days_remaining = parseFloat(task.days_until_due);

    // If less than 50% complete and < 3 days remaining, suggest extension
    if (completion_rate < 0.5 && days_remaining < 3) {
      const suggested_extension_days = Math.ceil(days_remaining * (1 - completion_rate) * 2);
      const new_due_date = new Date(task.due_date);
      new_due_date.setDate(new_due_date.getDate() + suggested_extension_days);

      actions.push({
        type: 'adjust_deadline',
        taskId: task.id,
        projectId: task.project_id,
        reason: `Task is ${Math.round(completion_rate * 100)}% complete with only ${Math.round(days_remaining)} days remaining. At current velocity, completion is unlikely by deadline.`,
        currentState: {
          task: task.task,
          due_date: task.due_date,
          progress: Math.round(completion_rate * 100),
          days_remaining: Math.round(days_remaining),
        },
        proposedChanges: {
          due_date: new_due_date.toISOString().split('T')[0],
          extension_days: suggested_extension_days,
        },
        confidence: 0.75,
      });
    }
  }

  return actions;
}

/**
 * Analyze blocked/stuck tasks and propose escalation
 */
async function analyzeBlockers(workspaceId, projectId, settings) {
  const threshold_hours = settings.blocker_threshold_hours || 48;

  // Find tasks with no recent activity
  const query = projectId
    ? `SELECT t.*,
        EXTRACT(EPOCH FROM (NOW() - t.updated_at)) / 3600 as hours_since_update,
        u.username as assigned_username
      FROM tasks t
      LEFT JOIN users u ON u.id = t.assigned_to
      WHERE t.workspace_id = $1
        AND t.project_id = $2
        AND t.status NOT IN ('completed', 'cancelled')
        AND t.updated_at < NOW() - INTERVAL '${threshold_hours} hours'
      ORDER BY t.updated_at ASC
      LIMIT 10`
    : `SELECT t.*,
        EXTRACT(EPOCH FROM (NOW() - t.updated_at)) / 3600 as hours_since_update,
        u.username as assigned_username
      FROM tasks t
      LEFT JOIN users u ON u.id = t.assigned_to
      WHERE t.workspace_id = $1
        AND t.status NOT IN ('completed', 'cancelled')
        AND t.updated_at < NOW() - INTERVAL '${threshold_hours} hours'
      ORDER BY t.updated_at ASC
      LIMIT 10`;

  const params = projectId ? [workspaceId, projectId] : [workspaceId];
  const { rows: stuckTasks } = await pool.query(query, params);

  const actions = [];

  for (const task of stuckTasks) {
    const hours_stuck = Math.round(parseFloat(task.hours_since_update));

    actions.push({
      type: 'escalate',
      taskId: task.id,
      projectId: task.project_id,
      reason: `Task has had no updates for ${hours_stuck} hours (threshold: ${threshold_hours}h). May be blocked or forgotten.`,
      currentState: {
        task: task.task,
        status: task.status,
        assigned_to: task.assigned_username || 'Unassigned',
        last_update: task.updated_at,
        hours_since_update: hours_stuck,
      },
      proposedChanges: {
        action: 'notify_manager',
        escalate_to_role: 'manager',
        suggested_actions: [
          'Check with assignee for blockers',
          'Reassign if assignee unavailable',
          'Break down into smaller subtasks',
        ],
      },
      confidence: 0.80,
    });
  }

  return actions;
}

/**
 * Analyze overdue tasks and propose immediate handling
 */
async function analyzeOverdueTasks(workspaceId, projectId, settings) {
  const query = projectId
    ? `SELECT t.*,
        EXTRACT(DAY FROM (NOW() - t.due_date)) as days_overdue,
        u.username as assigned_username
      FROM tasks t
      LEFT JOIN users u ON u.id = t.assigned_to
      WHERE t.workspace_id = $1
        AND t.project_id = $2
        AND t.status NOT IN ('completed', 'cancelled')
        AND t.due_date IS NOT NULL
        AND t.due_date < NOW()
      ORDER BY t.due_date ASC
      LIMIT 15`
    : `SELECT t.*,
        EXTRACT(DAY FROM (NOW() - t.due_date)) as days_overdue,
        u.username as assigned_username
      FROM tasks t
      LEFT JOIN users u ON u.id = t.assigned_to
      WHERE t.workspace_id = $1
        AND t.status NOT IN ('completed', 'cancelled')
        AND t.due_date IS NOT NULL
        AND t.due_date < NOW()
      ORDER BY t.due_date ASC
      LIMIT 15`;

  const params = projectId ? [workspaceId, projectId] : [workspaceId];
  const { rows: overdueTasks } = await pool.query(query, params);

  const actions = [];

  for (const task of overdueTasks) {
    const daysOverdue = Math.round(parseFloat(task.days_overdue));
    const severity = daysOverdue > 7 ? 'critical' : daysOverdue > 3 ? 'high' : 'medium';
    const suggestedExtension = Math.ceil(daysOverdue * 1.5);
    const newDueDate = new Date();
    newDueDate.setDate(newDueDate.getDate() + Math.max(suggestedExtension, 2));

    actions.push({
      type: 'handle_overdue',
      taskId: task.id,
      projectId: task.project_id,
      reason: `Task is ${daysOverdue} day(s) overdue (severity: ${severity}). Immediate action required to unblock progress.`,
      currentState: {
        task: task.task,
        status: task.status,
        due_date: task.due_date,
        assigned_to: task.assigned_username || 'Unassigned',
        days_overdue: daysOverdue,
        severity,
      },
      proposedChanges: {
        action: 'reschedule_and_escalate',
        new_due_date: newDueDate.toISOString().split('T')[0],
        extension_days: Math.max(suggestedExtension, 2),
        escalate_to_role: 'manager',
        suggested_actions: [
          `Reschedule due date by ${Math.max(suggestedExtension, 2)} days`,
          'Check with assignee for blockers',
          daysOverdue > 7 ? 'Reassign if no response within 24 hours' : 'Send reminder notification',
        ],
      },
      confidence: severity === 'critical' ? 0.92 : 0.80,
    });
  }

  return actions;
}

/**
 * Generate AI-powered daily standup summary — project-specific, with state transitions
 * and time-in-state analysis drawn from task_activity_logs.
 * When projectId is null, generates one standup per active project in the workspace.
 */
async function generateStandupSummaryLegacy(workspaceId, projectId, settings, sinceTimestamp = null, periodLabel = null) {
  // Default lookback: 24 hours
  const since = sinceTimestamp || new Date(Date.now() - 24 * 60 * 60 * 1000);
  const period = periodLabel || "since yesterday";

  // Determine which projects to summarise
  let projects = [];
  if (projectId) {
    const { rows } = await pool.query(
      `SELECT id, name FROM projects WHERE id = $1 AND workspace_id = $2`,
      [projectId, workspaceId]
    );
    projects = rows.length ? rows : [{ id: projectId, name: null }];
  } else {
    const { rows } = await pool.query(`
      SELECT DISTINCT t.project_id AS id, p.name
      FROM task_activity_logs al
      JOIN tasks t ON t.id = al.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE al.workspace_id = $1
        AND al.created_at > $2::timestamptz
      LIMIT 10
    `, [workspaceId, since]);
    projects = rows;
  }

  if (projects.length === 0) return [];

  const allActions = [];

  for (const project of projects) {
    const scopeParams = [workspaceId, project.id];
    const projectLabel = project.name || `Project ${project.id}`;

    try {
      // Active sprint for this project (if any)
      const { rows: sprintRows } = await pool.query(`
        SELECT id, name, goal, start_date, end_date,
          GREATEST(0, CEIL(EXTRACT(EPOCH FROM (end_date - NOW())) / 86400)) AS days_remaining
        FROM sprints
        WHERE project_id = $1 AND workspace_id = $2 AND status = 'active'
        ORDER BY start_date DESC
        LIMIT 1
      `, [project.id, workspaceId]);

      const activeSprint = sprintRows[0] || null;

      const [
        { rows: statusChanges },
        { rows: newTasks },
        { rows: overdueTasks },
        { rows: healthRows },
        { rows: sprintTaskRows },
      ] = await Promise.all([

        // Status transitions since last working day standup
        pool.query(`
          SELECT
            al.task_id,
            t.task AS task_name,
            t.priority,
            t.story_points,
            t.task_type,
            al.old_value->>'status' AS from_status,
            al.new_value->>'status' AS to_status,
            u.username AS actor_name,
            al.created_at AS changed_at,
            GREATEST(0, ROUND(
              EXTRACT(EPOCH FROM (al.created_at - COALESCE(prev_log.created_at, t.created_at))) / 3600
            )) AS hours_in_prev_state
          FROM task_activity_logs al
          JOIN tasks t ON t.id = al.task_id
          LEFT JOIN users u ON u.id = al.actor_id
          LEFT JOIN LATERAL (
            SELECT created_at FROM task_activity_logs
            WHERE task_id = al.task_id
              AND action_type = 'STATUS_CHANGED'
              AND created_at < al.created_at
            ORDER BY created_at DESC
            LIMIT 1
          ) prev_log ON true
          WHERE al.workspace_id = $1
            AND t.project_id = $2
            AND al.action_type = 'STATUS_CHANGED'
            AND al.created_at > $3::timestamptz
          ORDER BY al.created_at DESC
          LIMIT 40
        `, [...scopeParams, since]),

        // New tasks created since last working day standup
        pool.query(`
          SELECT t.task AS task_name, t.priority, t.status, t.task_type,
            t.story_points, u.username AS assigned_to, t.due_date
          FROM tasks t
          LEFT JOIN users u ON u.id = t.assigned_to
          WHERE t.workspace_id = $1 AND t.project_id = $2
            AND t.created_at > $3::timestamptz
          ORDER BY t.created_at DESC
          LIMIT 15
        `, [...scopeParams, since]),

        // Currently overdue tasks
        pool.query(`
          SELECT t.task AS task_name, t.priority, t.status, t.task_type,
            t.story_points, u.username AS assigned_to,
            ROUND(EXTRACT(DAY FROM (NOW() - t.due_date))) AS days_overdue
          FROM tasks t
          LEFT JOIN users u ON u.id = t.assigned_to
          WHERE t.workspace_id = $1 AND t.project_id = $2
            AND t.status NOT IN ('completed', 'cancelled')
            AND t.due_date IS NOT NULL
            AND t.due_date < NOW()
          ORDER BY t.due_date ASC
          LIMIT 10
        `, scopeParams),

        // Project health snapshot
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled')) AS active_count,
            COUNT(*) FILTER (WHERE status = 'completed') AS completed_total,
            COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress_count,
            COUNT(*) FILTER (WHERE status = 'review') AS in_review_count,
            COUNT(*) FILTER (WHERE status = 'todo') AS todo_count,
            COUNT(*) FILTER (WHERE due_date < NOW() AND status NOT IN ('completed','cancelled')) AS overdue_count
          FROM tasks
          WHERE workspace_id = $1 AND project_id = $2
        `, scopeParams),

        // Sprint task breakdown (only if active sprint exists)
        activeSprint
          ? pool.query(`
              SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status = 'completed') AS done,
                COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled') AND due_date < NOW()) AS overdue,
                COALESCE(SUM(story_points) FILTER (WHERE status = 'completed'), 0) AS points_done,
                COALESCE(SUM(story_points), 0) AS points_total,
                COUNT(*) FILTER (WHERE status IN ('in_progress','review')) AS in_flight
              FROM tasks
              WHERE workspace_id = $1 AND project_id = $2 AND sprint_id = $3
            `, [workspaceId, project.id, activeSprint.id])
          : Promise.resolve({ rows: [{}] }),
      ]);

      // Skip projects with no activity AND no overdue tasks to report
      if (statusChanges.length === 0 && newTasks.length === 0 && overdueTasks.length === 0) continue;

      const health = healthRows[0] || {};
      const sprintStats = sprintTaskRows[0] || {};

      // Build per-person activity map
      const personMap = {};
      for (const sc of statusChanges) {
        const name = sc.actor_name || 'Unknown';
        if (!personMap[name]) personMap[name] = [];
        const hrs = Number(sc.hours_in_prev_state);
        const timeStr = hrs >= 48
          ? `${Math.round(hrs / 24)}d in ${sc.from_status}`
          : hrs >= 1 ? `${hrs}h in ${sc.from_status}`
          : `< 1h in ${sc.from_status}`;
        const pts = sc.story_points ? ` [${sc.story_points}pts]` : '';
        personMap[name].push(
          `"${sc.task_name}"${pts} ${sc.from_status} → ${sc.to_status} (${timeStr})`
        );
      }

      const stuckMoves = statusChanges.filter(sc => Number(sc.hours_in_prev_state) >= 24);

      // ── Structured prompt data ──────────────────────────────
      const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

      const sprintBlock = activeSprint ? `
ACTIVE SPRINT: "${activeSprint.name}"
  Goal: ${activeSprint.goal || 'No goal set'}
  Timeline: ${new Date(activeSprint.start_date).toLocaleDateString()} → ${new Date(activeSprint.end_date).toLocaleDateString()} (${activeSprint.days_remaining} day(s) remaining)
  Progress: ${sprintStats.done || 0}/${sprintStats.total || 0} tasks done | ${sprintStats.in_flight || 0} in flight | ${sprintStats.overdue || 0} overdue
  Points: ${sprintStats.points_done || 0}/${sprintStats.points_total || 0} story points completed` : `SPRINT: No active sprint`;

      const transitionLines = statusChanges.map(sc => {
        const hrs = Number(sc.hours_in_prev_state);
        const timeStr = hrs >= 48 ? `${Math.round(hrs / 24)}d` : hrs >= 1 ? `${hrs}h` : '<1h';
        const stuck = hrs >= 24 ? ' ⚠ WAS STUCK' : '';
        const pts = sc.story_points ? ` [${sc.story_points}pts]` : '';
        const type = sc.task_type ? ` (${sc.task_type})` : '';
        return `  - ${sc.actor_name || 'Unknown'}: "${sc.task_name}"${pts}${type} | ${sc.from_status} → ${sc.to_status} | time in prev state: ${timeStr}${stuck}`;
      }).join('\n');

      const personLines = Object.entries(personMap)
        .map(([name, items]) => `  ${name}:\n${items.map(i => `    - ${i}`).join('\n')}`)
        .join('\n');

      const overdueLines = overdueTasks
        .map(t => {
          const pts = t.story_points ? ` [${t.story_points}pts]` : '';
          const type = t.task_type ? ` (${t.task_type})` : '';
          return `  - "${t.task_name}"${pts}${type} | ${t.days_overdue}d overdue | owner: ${t.assigned_to || 'unassigned'} | priority: ${t.priority || 'normal'}`;
        }).join('\n');

      const newTaskLines = newTasks
        .map(t => {
          const pts = t.story_points ? ` [${t.story_points}pts]` : '';
          const type = t.task_type ? ` (${t.task_type})` : '';
          return `  - "${t.task_name}"${pts}${type} | assigned to: ${t.assigned_to || 'unassigned'} | priority: ${t.priority || 'normal'}`;
        }).join('\n');

      const prompt = `You are writing a daily standup report for an engineering team. Today is ${today}.

PROJECT: ${projectLabel}
${sprintBlock}

PROJECT HEALTH: ${health.active_count || 0} active | ${health.in_progress_count || 0} in-progress | ${health.in_review_count || 0} in-review | ${health.todo_count || 0} todo | ${health.overdue_count || 0} overdue

TASK MOVEMENTS ${period.toUpperCase()} (${statusChanges.length} changes):
${transitionLines || '  - None'}

PER-PERSON ACTIVITY:
${personLines || '  - No activity recorded'}

NEW TASKS CREATED ${period.toUpperCase()} (${newTasks.length}):
${newTaskLines || '  - None'}

CURRENTLY OVERDUE (${overdueTasks.length}):
${overdueLines || '  - None'}

---
Generate a structured daily standup report. You MUST follow this EXACT format — no deviations, no paragraphs, only the sections below:

---
# 📋 Daily Standup — ${projectLabel}
**${today}**

${activeSprint ? `> 🏃 **Sprint:** "${activeSprint.name}" · ${activeSprint.days_remaining}d remaining · ${sprintStats.points_done || 0}/${sprintStats.points_total || 0} pts done` : '> ℹ️ No active sprint'}

---

## 🟢 Progress (${period})
- List each completed or advanced task as a bullet
- Format: **"Task Name"** — moved from X → Y by @Person [Xpts if available]
- If nothing happened, write: *No task movements recorded*

## 🔄 In Progress
- List tasks currently in-flight (in_progress or review status)
- Format: **"Task Name"** — @Owner · [Xpts] · status: in-progress/review
- If none, write: *No tasks currently in progress*

## 👥 Team Activity
- One bullet per person who was active
- Format: **@Name** — what they moved/completed (be specific with task names)
- If no activity, write: *No individual activity recorded*

## 🆕 Newly Added
- List new tasks added ${period}
- Format: **"Task Name"** · Type · Assigned to @Owner · Priority: X
- If none, write: *No new tasks ${period}*

## 🚨 Blockers & Overdue
- List every overdue task as a bullet
- Format: **"Task Name"** — ⏰ Xd overdue · Owner: @Name · Priority: X
- Tasks stuck >24h before being moved: flag with ⚠️
- If none, write: ✅ *No blockers or overdue tasks*

## 🎯 Focus for Today
- 3-5 specific action bullets based on current sprint goal and project state
- Each bullet starts with an action verb (Complete, Review, Unblock, Prioritize, etc.)
- Be specific to THIS project — mention actual task names or areas

---

RULES:
- Use ONLY bullet points. No paragraphs whatsoever.
- Bold task names always. Bold @mentions.
- Include story points where available (e.g. [3pts])
- Use task names EXACTLY as given in the data
- Be direct. No filler. No "the team did a great job" type phrases.
- Output valid markdown only.`;

      const summary = await generateText({ prompt });

      allActions.push({
        type: 'create_standup',
        taskId: null,
        projectId: project.id,
        reason: `Daily standup for project: ${projectLabel}${activeSprint ? ` (Sprint: ${activeSprint.name})` : ''}`,
        currentState: {
          project_name: projectLabel,
          status_changes: statusChanges.length,
          stuck_tasks: stuckMoves.length,
          new_tasks: newTasks.length,
          overdue_count: overdueTasks.length,
          active_count: Number(health.active_count || 0),
          sprint_name: activeSprint?.name || null,
          sprint_days_remaining: activeSprint ? Number(activeSprint.days_remaining) : null,
          sprint_points_done: activeSprint ? Number(sprintStats.points_done || 0) : null,
          sprint_points_total: activeSprint ? Number(sprintStats.points_total || 0) : null,
        },
        proposedChanges: {
          summary: summary.trim(),
          project_name: projectLabel,
          delivery_channel: 'daily-standups',
        },
        confidence: 0.92,
      });
    } catch (err) {
      console.error(`Failed to generate standup for project ${project.id}:`, err);
    }
  }

  return allActions;
}

const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "http://localhost:5173";
const DEFAULT_PROJECT_STATUSES = [
  { key: "backlog", label: "Backlog", sort_order: 1 },
  { key: "pending", label: "Pending", sort_order: 2 },
  { key: "in-progress", label: "In Progress", sort_order: 3 },
  { key: "completed", label: "Completed", sort_order: 4 },
];
const TERMINAL_STATUS_KEYS = new Set(["completed", "cancelled", "done", "closed"]);

function normalizeStatusKey(value = "") {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-");
}

function titleCase(value = "") {
  return String(value)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseDateOnly(value) {
  if (value instanceof Date) return new Date(value);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }
  return new Date(value);
}

function formatLocalDateIso(value) {
  const date = parseDateOnly(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatStatusLabel(value, statusMap = new Map()) {
  const key = normalizeStatusKey(value);
  return statusMap.get(key)?.label || titleCase(key || value || "Unknown");
}

function isTerminalStatusKey(key) {
  return TERMINAL_STATUS_KEYS.has(normalizeStatusKey(key));
}

function isPlanningStatusKey(key) {
  return ["backlog", "pending", "todo", "to-do", "planned", "ready"].includes(normalizeStatusKey(key));
}

function isInProgressTask(task, orderedStatuses) {
  const key = normalizeStatusKey(task.status);
  if (!key || isTerminalStatusKey(key) || isPlanningStatusKey(key)) return false;

  const index = orderedStatuses.findIndex(status => normalizeStatusKey(status.key) === key);
  if (index > 0 && index < orderedStatuses.length - 1) return true;

  return key.includes("progress") || key.includes("review") || key.includes("qa") || key.includes("test");
}

function buildTaskUrl(projectId, taskId) {
  const params = new URLSearchParams();
  params.set("task", taskId);
  return `${FRONTEND_BASE_URL}/projects/${projectId}?${params.toString()}`;
}

function markdownTaskLink(task) {
  const labelBase = task.display_id ? `${task.display_id}` : "Task";
  const label = `${labelBase}: ${task.task_name || task.task || "Untitled task"}`;
  return `[${label}](${buildTaskUrl(task.project_id, task.task_id || task.id)})`;
}

function formatHandle(username) {
  return username ? `@${username}` : "unassigned";
}

function formatTaskDetails(task, statusMap = new Map()) {
  const details = [];
  if (task.task_type) details.push(task.task_type);
  if (task.story_points !== null && task.story_points !== undefined) details.push(`${task.story_points}pts`);
  if (task.priority) details.push(`priority: ${task.priority}`);
  if (task.assigned_to_username) details.push(`owner: ${formatHandle(task.assigned_to_username)}`);
  details.push(`status: ${formatStatusLabel(task.status, statusMap)}`);
  return details.join(" | ");
}

function clampList(items, max = 8) {
  return items.slice(0, max);
}

function buildSection(title, items, emptyText) {
  const lines = [`## ${title}`];
  if (!items.length) {
    lines.push(`- ${emptyText}`);
    return lines.join("\n");
  }
  lines.push(...items.map(item => `- ${item}`));
  return lines.join("\n");
}

function buildBoardSnapshotItems(tasks, orderedStatuses) {
  const counts = new Map(
    orderedStatuses.map(status => [normalizeStatusKey(status.key), { label: status.label, count: 0 }])
  );

  for (const task of tasks) {
    const key = normalizeStatusKey(task.status);
    if (!counts.has(key)) counts.set(key, { label: titleCase(task.status), count: 0 });
    counts.get(key).count += 1;
  }

  return Array.from(counts.values())
    .filter(item => item.count > 0)
    .map(item => `**${item.label}**: ${item.count}`);
}

function buildBlockerItems(tasks, settings) {
  const staleThresholdHours = Number(settings?.blocker_threshold_hours || 48);
  const now = Date.now();
  const warnings = [];

  for (const task of tasks) {
    if (isTerminalStatusKey(task.status)) continue;

    const flags = [];
    if (task.is_blocked) flags.push("blocked");
    if (task.due_date && new Date(task.due_date).getTime() < now) flags.push("overdue");
    if (task.updated_at && (now - new Date(task.updated_at).getTime()) >= staleThresholdHours * 3600 * 1000) flags.push("stale");
    if (!task.assigned_to && !isPlanningStatusKey(task.status)) flags.push("unassigned");
    if (!flags.length) continue;

    warnings.push({ ...task, flags });
  }

  return warnings.sort((a, b) => {
    const aScore = Number(a.flags.includes("blocked")) + Number(a.flags.includes("overdue"));
    const bScore = Number(b.flags.includes("blocked")) + Number(b.flags.includes("overdue"));
    return bScore - aScore;
  });
}

function buildTeamActivityItems(activityRows) {
  const grouped = new Map();

  for (const row of activityRows) {
    const actor = row.actor_name || "Unknown";
    if (!grouped.has(actor)) grouped.set(actor, []);

    if (row.action_type === "STATUS_CHANGED") {
      grouped.get(actor).push(`${markdownTaskLink(row)} ${formatStatusLabel(row.from_status)} -> ${formatStatusLabel(row.to_status)}`);
    } else if (row.action_type === "TASK_CREATED") {
      grouped.get(actor).push(`created ${markdownTaskLink(row)}`);
    } else if (row.action_type === "ASSIGNEE_CHANGED") {
      grouped.get(actor).push(`reassigned ${markdownTaskLink(row)} to ${formatHandle(row.new_assigned_to_username)}`);
    } else if (row.action_type === "PRIORITY_CHANGED") {
      grouped.get(actor).push(`changed ${markdownTaskLink(row)} priority to ${row.new_priority || "unspecified"}`);
    } else if (row.action_type === "COMMENT_ADDED") {
      grouped.get(actor).push(`commented on ${markdownTaskLink(row)}`);
    } else {
      grouped.get(actor).push(`updated ${markdownTaskLink(row)}`);
    }
  }

  return clampList(
    Array.from(grouped.entries()).map(([actor, items]) => `**${formatHandle(actor)}** - ${items.slice(0, 3).join("; ")}`),
    8
  );
}

function formatActivityLine(row, statusMap = new Map()) {
  if (row.action_type === "STATUS_CHANGED") {
    const actor = row.actor_name ? ` by ${formatHandle(row.actor_name)}` : "";
    return `${markdownTaskLink(row)} moved from ${formatStatusLabel(row.from_status, statusMap)} to ${formatStatusLabel(row.to_status, statusMap)}${actor}.`;
  }
  if (row.action_type === "TASK_CREATED") {
    return `${markdownTaskLink(row)} was created${row.actor_name ? ` by ${formatHandle(row.actor_name)}` : ""}.`;
  }
  if (row.action_type === "ASSIGNEE_CHANGED") {
    return `${markdownTaskLink(row)} was reassigned to ${formatHandle(row.new_assigned_to_username)}${row.actor_name ? ` by ${formatHandle(row.actor_name)}` : ""}.`;
  }
  if (row.action_type === "PRIORITY_CHANGED") {
    return `${markdownTaskLink(row)} priority changed to ${row.new_priority || "unspecified"}${row.actor_name ? ` by ${formatHandle(row.actor_name)}` : ""}.`;
  }
  if (row.action_type === "COMMENT_ADDED") {
    return `${markdownTaskLink(row)} received a comment${row.actor_name ? ` from ${formatHandle(row.actor_name)}` : ""}.`;
  }
  return `${markdownTaskLink(row)} was updated${row.actor_name ? ` by ${formatHandle(row.actor_name)}` : ""}.`;
}

function buildFocusItems({ blockers, inProgressTasks, newTasks, activeSprint, sprintStats, statusMap }) {
  const items = [];

  blockers
    .filter(task => task.flags.includes("blocked") || task.flags.includes("overdue"))
    .slice(0, 2)
    .forEach(task => {
      const reasons = [];
      if (task.flags.includes("blocked")) reasons.push("blocked");
      if (task.flags.includes("overdue")) reasons.push("overdue");
      items.push(`Unblock ${markdownTaskLink(task)} because it is currently ${reasons.join(" and ")}.`);
    });

  inProgressTasks.slice(0, 2).forEach(task => {
    items.push(`Advance ${markdownTaskLink(task)} from ${formatStatusLabel(task.status, statusMap)} to the next workflow column.`);
  });

  newTasks.slice(0, 1).forEach(task => {
    items.push(`Clarify ownership and next action on ${markdownTaskLink(task)} so it does not stall in ${formatStatusLabel(task.status, statusMap)}.`);
  });

  if (activeSprint) {
    items.push(`Protect sprint ${activeSprint.name} delivery with ${Number(sprintStats.in_progress_count || 0)} task(s) in flight and ${Number(sprintStats.overdue_count || 0)} overdue.`);
  }

  return clampList(items.filter(Boolean), 5);
}

function buildStandupMarkdown({
  projectLabel,
  activeSprint,
  sprintStats,
  period,
  reportDate,
  activityItems,
  boardItems,
  inProgressItems,
  teamItems,
  newTaskItems,
  blockerItems,
  focusItems,
}) {
  const displayDate = reportDate ? parseDateOnly(reportDate) : new Date();
  const today = displayDate.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const scopeLine = activeSprint
    ? `> Sprint: **${activeSprint.name}** | ${Number(activeSprint.days_remaining || 0)}d remaining | ${Number(sprintStats.completed_count || 0)}/${Number(sprintStats.total_count || 0)} tasks complete`
    : `> Scope: **Project-wide** | summarising project activity ${period}`;

  return [
    `# Daily Standup - ${projectLabel}`,
    `**${today}**`,
    scopeLine,
    activeSprint?.goal ? `> Goal: ${activeSprint.goal}` : null,
    "---",
    buildSection(`Recorded Activity (${period})`, activityItems, "No recorded activity in this reporting window."),
    buildSection("Board Snapshot", boardItems, "No active tasks in scope."),
    buildSection("In Progress", inProgressItems, "No tasks currently in progress."),
    buildSection("Team Activity", teamItems, "No user activity recorded in this reporting window."),
    buildSection("Newly Added", newTaskItems, `No new tasks ${period}.`),
    buildSection("Blockers & Warnings", blockerItems, "No blockers or warnings in the current scope."),
    buildSection("Focus For Today", focusItems, "Keep current work moving through the next workflow column."),
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function generateStandupSummary(workspaceId, projectId, settings, sinceTimestamp = null, periodLabel = null, reportDate = null) {
  const since = sinceTimestamp || new Date(Date.now() - 24 * 60 * 60 * 1000);
  const period = periodLabel || "since yesterday";
  const reportDateValue = reportDate ? parseDateOnly(reportDate) : new Date();
  const reportDateIso = formatLocalDateIso(reportDateValue);

  let projects = [];
  if (projectId) {
    const { rows } = await pool.query(
      `SELECT id, name FROM projects WHERE id = $1 AND workspace_id = $2`,
      [projectId, workspaceId]
    );
    projects = rows;
  } else {
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
      [workspaceId, since]
    );
    projects = rows;
  }

  if (!projects.length) return [];

  const allActions = [];

  for (const project of projects) {
    const projectLabel = project.name || `Project ${project.id}`;

    try {
      const { rows: sprintRows } = await pool.query(
        `
        SELECT id, name, goal, start_date, end_date,
               GREATEST(0, CEIL(EXTRACT(EPOCH FROM (COALESCE(end_date, NOW()) - NOW())) / 86400)) AS days_remaining
        FROM sprints
        WHERE project_id = $1
          AND workspace_id = $2
          AND status = 'active'
        ORDER BY start_date DESC NULLS LAST, created_at DESC
        LIMIT 1
        `,
        [project.id, workspaceId]
      );

      const activeSprint = sprintRows[0] || null;
      const activitySinceIndex = activeSprint ? 4 : 3;
      const activityParams = activeSprint
        ? [workspaceId, project.id, activeSprint.id, since]
        : [workspaceId, project.id, since];

      const [{ rows: statusRows }, { rows: scopedTasks }, { rows: activityRows }, { rows: sprintStatsRows }] = await Promise.all([
        pool.query(
          `
          SELECT key, label, sort_order
          FROM project_statuses
          WHERE project_id = $1
          ORDER BY sort_order ASC, created_at ASC
          `,
          [project.id]
        ),
        pool.query(
          `
          SELECT
            t.id,
            t.id AS task_id,
            t.project_id,
            t.task AS task_name,
            t.status,
            t.priority,
            t.task_type,
            t.story_points,
            t.assigned_to,
            t.is_blocked,
            t.due_date,
            t.updated_at,
            t.created_at,
            u.username AS assigned_to_username,
            CASE
              WHEN p.project_code IS NOT NULL AND t.ticket_number IS NOT NULL
              THEN p.project_code || '-' || t.ticket_number
              ELSE NULL
            END AS display_id
          FROM tasks t
          LEFT JOIN users u ON u.id = t.assigned_to
          LEFT JOIN projects p ON p.id = t.project_id
          WHERE t.workspace_id = $1
            AND t.project_id = $2
            ${activeSprint ? `AND t.sprint_id = $3` : ``}
          ORDER BY t.updated_at DESC, t.created_at DESC
          `,
          activeSprint ? [workspaceId, project.id, activeSprint.id] : [workspaceId, project.id]
        ),
        pool.query(
          `
          SELECT
            al.task_id,
            t.project_id,
            t.task AS task_name,
            t.status,
            t.priority,
            t.task_type,
            t.story_points,
            t.assigned_to,
            u.username AS assigned_to_username,
            t.is_blocked,
            t.due_date,
            t.updated_at,
            t.created_at,
            al.action_type,
            al.old_value->>'status' AS from_status,
            al.new_value->>'status' AS to_status,
            al.new_value->>'priority' AS new_priority,
            actor.username AS actor_name,
            new_assignee.username AS new_assigned_to_username,
            CASE
              WHEN p.project_code IS NOT NULL AND t.ticket_number IS NOT NULL
              THEN p.project_code || '-' || t.ticket_number
              ELSE NULL
            END AS display_id
          FROM task_activity_logs al
          JOIN tasks t ON t.id = al.task_id
          LEFT JOIN users u ON u.id = t.assigned_to
          LEFT JOIN users actor ON actor.id = al.actor_id
          LEFT JOIN users new_assignee ON new_assignee.id::text = al.new_value->>'assigned_to'
          LEFT JOIN projects p ON p.id = t.project_id
          WHERE al.workspace_id = $1
            AND t.project_id = $2
            ${activeSprint ? `AND t.sprint_id = $3` : ``}
            AND al.created_at > $${activitySinceIndex}::timestamptz
          ORDER BY al.created_at DESC
          `,
          activityParams
        ),
        pool.query(
          `
          SELECT
            COUNT(*)::int AS total_count,
            COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) IN ('completed', 'done', 'closed'))::int AS completed_count,
            COUNT(*) FILTER (WHERE due_date IS NOT NULL AND due_date < NOW() AND LOWER(COALESCE(status, '')) NOT IN ('completed', 'cancelled', 'done', 'closed'))::int AS overdue_count,
            COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) NOT IN ('completed', 'cancelled', 'done', 'closed') AND LOWER(COALESCE(status, '')) NOT IN ('backlog', 'pending', 'todo', 'to-do', 'planned', 'ready'))::int AS in_progress_count
          FROM tasks t
          WHERE t.workspace_id = $1
            AND t.project_id = $2
            ${activeSprint ? `AND t.sprint_id = $3` : ``}
          `,
          activeSprint ? [workspaceId, project.id, activeSprint.id] : [workspaceId, project.id]
        ),
      ]);

      if (!activeSprint && !scopedTasks.length && !activityRows.length) continue;

      const orderedStatuses = statusRows.length ? statusRows : DEFAULT_PROJECT_STATUSES;
      const statusMap = new Map(
        orderedStatuses.map(status => [normalizeStatusKey(status.key), { label: status.label, sortOrder: status.sort_order }])
      );
      const sprintStats = sprintStatsRows[0] || {};
      const recentMoves = activityRows.filter(row => row.action_type === "STATUS_CHANGED");
      const newTasks = scopedTasks
        .filter(task => new Date(task.created_at).getTime() > new Date(since).getTime())
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const inProgressTasks = scopedTasks.filter(task => isInProgressTask(task, orderedStatuses));
      const blockers = buildBlockerItems(scopedTasks, settings);

      const activityItems = clampList(activityRows.map(row => formatActivityLine(row, statusMap)), 12);
      const boardItems = buildBoardSnapshotItems(scopedTasks, orderedStatuses);
      const inProgressItems = clampList(
        inProgressTasks.map(task => `${markdownTaskLink(task)} - ${formatTaskDetails(task, statusMap)}`),
        10
      );
      const teamItems = buildTeamActivityItems(activityRows);
      const newTaskItems = clampList(
        newTasks.map(task => `${markdownTaskLink(task)} - ${formatTaskDetails(task, statusMap)}`),
        10
      );
      const blockerItems = clampList(
        blockers.map(task => `${markdownTaskLink(task)} - ${task.flags.join(", ")} | ${formatTaskDetails(task, statusMap)}`),
        10
      );
      const focusItems = buildFocusItems({
        blockers,
        inProgressTasks,
        newTasks,
        activeSprint,
        sprintStats,
        statusMap,
      });

      const summary = buildStandupMarkdown({
        projectLabel,
        activeSprint,
        sprintStats,
        period,
        reportDate: reportDateValue,
        activityItems,
        boardItems,
        inProgressItems,
        teamItems,
        newTaskItems,
        blockerItems,
        focusItems,
      });

      allActions.push({
        type: "create_standup",
        taskId: null,
        projectId: project.id,
        reason: `Daily standup for project: ${projectLabel}${activeSprint ? ` (Sprint: ${activeSprint.name})` : " (Project backlog scope)"}`,
        currentState: {
          project_name: projectLabel,
          report_date: reportDateIso,
          reporting_period: period,
          activity_count: activityRows.length,
          status_changes: recentMoves.length,
          new_tasks: newTasks.length,
          in_progress_count: inProgressTasks.length,
          blocker_count: blockers.length,
          scoped_task_count: scopedTasks.length,
          sprint_name: activeSprint?.name || null,
          sprint_days_remaining: activeSprint ? Number(activeSprint.days_remaining || 0) : null,
        },
        proposedChanges: {
          summary,
          project_name: projectLabel,
          report_date: reportDateIso,
          message_temp_id: `standup:${project.id}:${reportDateIso}`,
          delivery_channel: "daily-standups",
        },
        confidence: 0.98,
      });
    } catch (err) {
      console.error(`Failed to generate standup for project ${project.id}:`, err);
    }
  }

  return allActions;
}

/* =====================================================
   DATABASE OPERATIONS
===================================================== */

async function getAutopilotSettings(workspaceId, projectId) {
  const query = projectId
    ? `SELECT * FROM autopilot_settings
       WHERE workspace_id = $1 AND (project_id = $2 OR project_id IS NULL)
       ORDER BY project_id DESC NULLS LAST
       LIMIT 1`
    : `SELECT * FROM autopilot_settings
       WHERE workspace_id = $1 AND project_id IS NULL
       LIMIT 1`;

  const params = projectId ? [workspaceId, projectId] : [workspaceId];
  const { rows } = await pool.query(query, params);

  return rows[0] || null;
}

async function createAutopilotAction({
  workspaceId,
  projectId,
  taskId,
  actionType,
  reason,
  currentState,
  proposedChanges,
  confidenceScore,
  requireApproval = true,
  autoApproveAfterHours = 24,
}) {
  const dedupeHoursByType = {
    reassign: 6,
    adjust_deadline: 6,
    escalate: 12,
    create_standup: 23,
    handle_overdue: 12,
  };
  const dedupeHours = dedupeHoursByType[actionType] || 6;

  // Prevent duplicate pending actions with identical intent over short windows.
  const dedupe = await pool.query(
    `
    SELECT *
    FROM autopilot_actions
    WHERE workspace_id = $1
      AND COALESCE(project_id::text, '') = COALESCE($2::text, '')
      AND COALESCE(task_id::text, '') = COALESCE($3::text, '')
      AND action_type = $4
      AND status IN ('pending', 'approved', 'auto_approved', 'executed')
      AND proposed_changes::jsonb = $5::jsonb
      AND created_at > NOW() - ($6::int * INTERVAL '1 hour')
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [
      workspaceId,
      projectId,
      taskId,
      actionType,
      JSON.stringify(proposedChanges || {}),
      dedupeHours,
    ]
  );

  if (dedupe.rows.length > 0) {
    return null;
  }

  const expiresAt = requireApproval
    ? new Date(Date.now() + autoApproveAfterHours * 60 * 60 * 1000)
    : null;

  const { rows } = await pool.query(`
    INSERT INTO autopilot_actions (
      workspace_id,
      project_id,
      task_id,
      action_type,
      status,
      reason,
      current_state,
      proposed_changes,
      confidence_score,
      expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *
  `, [
    workspaceId,
    projectId,
    taskId,
    actionType,
    requireApproval ? 'pending' : 'auto_approved',
    reason,
    JSON.stringify(currentState),
    JSON.stringify(proposedChanges),
    confidenceScore,
    expiresAt,
  ]);

  return rows[0];
}

/* =====================================================
   EXECUTION ENGINE (executes approved actions)
===================================================== */

export async function executeAutopilotAction(actionId, approvedBy = null) {
  const { rows } = await pool.query(`
    SELECT * FROM autopilot_actions WHERE id = $1
  `, [actionId]);

  if (rows.length === 0) {
    throw new Error('Action not found');
  }

  const action = rows[0];

  if (action.status !== 'pending' && action.status !== 'auto_approved') {
    throw new Error(`Action is ${action.status}, cannot execute`);
  }

  let outcome = { status: 'success', data: null };

  try {
    // Execute based on action type
    switch (action.action_type) {
      case 'reassign':
        await executeReassign(action);
        break;
      case 'adjust_deadline':
        await executeDeadlineAdjust(action);
        break;
      case 'escalate':
        await executeEscalation(action);
        break;
      case 'create_standup':
        await executeStandupCreation(action);
        break;
      case 'handle_overdue':
        await executeOverdueHandling(action);
        break;
      default:
        throw new Error(`Unknown action type: ${action.action_type}`);
    }

    // Mark as executed
    await pool.query(`
      UPDATE autopilot_actions
      SET status = 'executed',
          approved_by = $1,
          approved_at = NOW(),
          executed_at = NOW()
      WHERE id = $2
    `, [approvedBy, actionId]);

    // Record decision
    await pool.query(`
      INSERT INTO autopilot_decisions (
        workspace_id,
        action_id,
        decision,
        decision_by,
        outcome_status,
        outcome_data
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      action.workspace_id,
      actionId,
      'executed',
      approvedBy,
      outcome.status,
      JSON.stringify(outcome.data),
    ]);

    return { success: true, action, outcome };
  } catch (err) {
    // State-conflict errors mean the task was manually changed before auto-execution.
    // Treat as cancelled (not failed) to avoid noisy logs.
    const isStaleState = err.message?.includes('state changed') || err.message?.includes('no longer valid');
    const finalStatus = isStaleState ? 'cancelled' : 'failed';

    if (isStaleState) {
      console.log(`⏭️  Action ${actionId} (${action.action_type}) skipped — task state changed before execution`);
    } else {
      console.error(`Failed to execute action ${actionId}:`, err);
    }

    await pool.query(`
      UPDATE autopilot_actions
      SET status = $2
      WHERE id = $1
    `, [actionId, finalStatus]);

    outcome = { status: finalStatus, error: err.message };

    await pool.query(`
      INSERT INTO autopilot_decisions (
        workspace_id,
        action_id,
        decision,
        decision_by,
        outcome_status,
        outcome_data
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      action.workspace_id,
      actionId,
      'executed',
      approvedBy,
      'failed',
      JSON.stringify(outcome),
    ]);

    throw err;
  }
}

async function executeReassign(action) {
  const changes = action.proposed_changes;
  const expectedAssignedTo =
    action.current_state && Object.prototype.hasOwnProperty.call(action.current_state, "assigned_to")
      ? action.current_state.assigned_to
      : null;

  const { rowCount } = await pool.query(`
    UPDATE tasks
    SET assigned_to = $1, updated_at = NOW()
    WHERE id = $2
      AND (
        ($3::uuid IS NULL AND assigned_to IS NULL)
        OR assigned_to = $3::uuid
      )
      AND status NOT IN ('completed', 'cancelled')
  `, [changes.assigned_to, action.task_id, expectedAssignedTo]);

  if (rowCount === 0) {
    throw new Error("Task assignment state changed; reassign action is no longer valid.");
  }
}

async function executeDeadlineAdjust(action) {
  const changes = action.proposed_changes;
  const expectedDueDate = action.current_state?.due_date || null;

  const { rowCount } = await pool.query(`
    UPDATE tasks
    SET due_date = $1, updated_at = NOW()
    WHERE id = $2
      AND status NOT IN ('completed', 'cancelled')
      AND (
        ($3::timestamptz IS NULL AND due_date IS NULL)
        OR due_date = $3::timestamptz
      )
  `, [changes.due_date, action.task_id, expectedDueDate]);

  if (rowCount === 0) {
    throw new Error("Task due date changed; deadline adjustment is no longer valid.");
  }
}

async function executeEscalation(action) {
  const { rows: taskRows } = await pool.query(
    `
    SELECT id
    FROM tasks
    WHERE id = $1
      AND status NOT IN ('completed', 'cancelled')
    LIMIT 1
    `,
    [action.task_id]
  );

  if (taskRows.length === 0) {
    throw new Error("Task is already completed/cancelled; escalation skipped.");
  }

  // Send notification to managers/admins in a single insert.
  await pool.query(
    `
    INSERT INTO notifications (user_id, type, message, task_id, project_id, created_at)
    SELECT u.id, 'task_escalated', $1, $2, $3, NOW()
    FROM users u
    WHERE u.workspace_id = $4
      AND u.role IN ('manager', 'admin')
    `,
    [action.reason, action.task_id, action.project_id, action.workspace_id]
  );
}

/** Convert markdown standup output to clean HTML for the chat channel */
function standupMarkdownToHtml(md) {
  if (!md) return '';

  const lines = md.split('\n');
  const html = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, ''); // strip CRLF

    // Skip empty lines — section headers provide their own spacing
    if (line.trim() === '') continue;

    // # H1 title
    if (/^# (.+)$/.test(line)) {
      html.push(`<strong>${applyInlineFormatting(line.replace(/^# /, ''))}</strong><br/>`);
      continue;
    }

    // ## H2 section header → one blank line before, bold
    if (/^## (.+)$/.test(line)) {
      html.push(`<br/><strong>${applyInlineFormatting(line.replace(/^## /, ''))}</strong><br/>`);
      continue;
    }

    // --- horizontal rule
    if (/^---+$/.test(line.trim())) {
      html.push('<hr style="border:none;border-top:1px solid #e5e7eb;margin:2px 0"/>');
      continue;
    }

    // > blockquote (sprint info)
    if (/^> (.+)$/.test(line)) {
      const text = applyInlineFormatting(line.replace(/^> /, ''));
      html.push(`<span style="padding:1px 6px;border-left:3px solid #6366f1;color:#6b7280;font-size:0.92em">${text}</span><br/>`);
      continue;
    }

    // - bullet or • bullet
    if (/^[\-•] (.+)$/.test(line)) {
      const text = applyInlineFormatting(line.replace(/^[\-•] /, ''));
      html.push(`&nbsp;&nbsp;• ${text}<br/>`);
      continue;
    }

    // Numbered list
    if (/^\d+\. (.+)$/.test(line)) {
      const text = applyInlineFormatting(line.replace(/^\d+\. /, ''));
      html.push(`&nbsp;&nbsp;${text}<br/>`);
      continue;
    }

    // Regular text
    html.push(`${applyInlineFormatting(line)}<br/>`);
  }

  return html.join('');
}

function applyInlineFormatting(text) {
  return text
    // [text](url)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    // **bold**
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // *italic*
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // `code`
    .replace(/`([^`]+)`/g, '<code style="background:#f3f4f6;padding:1px 4px;border-radius:3px">$1</code>')
    // @mention
    .replace(/@(\w+)/g, '<strong style="color:#6366f1">@$1</strong>');
}

async function executeStandupCreation(action) {
  const changes = action.proposed_changes;
  const workspaceId = action.workspace_id;
  const projectName = changes.project_name || 'Workspace';
  const channelKey = 'daily-standups';
  const reportDate = changes.report_date ? parseDateOnly(changes.report_date) : new Date();
  const tempId = changes.message_temp_id || null;

  try {
    // Get or create the AI system user
    const aiUser = await ensureSystemUser(workspaceId);

    // Get or create the daily-standups channel
    let channel = await getChannelByKey(channelKey, workspaceId);
    if (!channel) {
      channel = await createChannel({
        key: channelKey,
        name: 'daily-standups',
        type: 'channel',
        createdBy: aiUser.id,
        isPrivate: false,
        workspaceId,
      });
      console.log(`Created #daily-standups channel for workspace ${workspaceId}`);
    }

    // Ensure AI user is a member
    await ensureChannelMember(channel.id, aiUser.id);

    // Format and post the standup message
    const today = reportDate.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const bodyHtml = standupMarkdownToHtml(changes.summary);
    const messageText = `<strong>📋 ${projectName} — Daily Standup</strong><br/><em>${today}</em><br/><br/>${bodyHtml}`;

    await createChatMessage({
      channelKey,
      userId: aiUser.id,
      tempId,
      textHtml: messageText,
      fallbackText: `${projectName} Daily Standup — ${today}\n\n${changes.summary}`,
      workspaceId,
    });

    console.log(`Standup posted to #daily-standups for project: ${projectName}`);
  } catch (err) {
    console.error('Failed to post standup to channel:', err);
    throw err;
  }
}

async function executeOverdueHandling(action) {
  const changes = action.proposed_changes;

  // Update the due date to the new proposed date
  const { rowCount } = await pool.query(`
    UPDATE tasks
    SET due_date = $1, updated_at = NOW()
    WHERE id = $2
      AND status NOT IN ('completed', 'cancelled')
  `, [changes.new_due_date, action.task_id]);

  if (rowCount === 0) {
    throw new Error('Overdue task already completed/cancelled; handling skipped.');
  }

  // Escalate: notify managers
  await pool.query(`
    INSERT INTO notifications (user_id, type, message, task_id, project_id, created_at)
    SELECT u.id, 'task_overdue_escalated', $1, $2, $3, NOW()
    FROM users u
    WHERE u.workspace_id = $4
      AND u.role IN ('manager', 'admin')
  `, [action.reason, action.task_id, action.project_id, action.workspace_id]);
}

function actionKey(action) {
  return JSON.stringify({
    type: action?.type || null,
    projectId: action?.projectId || null,
    taskId: action?.taskId || null,
    proposedChanges: action?.proposedChanges || {},
  });
}

function dedupeActionsInMemory(actions) {
  const seen = new Set();
  const deduped = [];
  for (const action of actions) {
    const key = actionKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(action);
  }
  return deduped;
}

async function runWithConcurrency(items, concurrency, worker) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const maxConcurrency = Math.max(1, Math.min(concurrency || 1, 20));
  const results = [];
  let cursor = 0;

  const runners = Array.from({ length: Math.min(maxConcurrency, items.length) }, async () => {
    while (true) {
      const current = cursor;
      cursor += 1;
      if (current >= items.length) return;

      const out = await worker(items[current], current);
      if (out) results.push(out);
    }
  });

  await Promise.all(runners);
  return results;
}
