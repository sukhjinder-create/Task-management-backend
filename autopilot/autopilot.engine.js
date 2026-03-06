// autopilot/autopilot.engine.js
import pool from "../db.js";
import { generateText } from "../intelligence/llm/llmClient.js";

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
export async function runAutopilotAnalysis({ workspaceId, projectId = null }) {
  console.log(`🤖 Running autopilot analysis for workspace: ${workspaceId}, project: ${projectId || 'all'}`);

  // Get autopilot settings
  const settings = await getAutopilotSettings(workspaceId, projectId);

  if (!settings || !settings.enabled) {
    return { message: 'Autopilot is disabled', actionsCreated: 0 };
  }

  const actions = [];

  // Run enabled analysis modules
  if (settings.auto_assign) {
    const assignActions = await analyzeUnassignedTasks(workspaceId, projectId, settings);
    actions.push(...assignActions);
  }

  if (settings.auto_deadline_adjust) {
    const deadlineActions = await analyzeDeadlines(workspaceId, projectId, settings);
    actions.push(...deadlineActions);
  }

  if (settings.auto_escalate_blockers) {
    const blockerActions = await analyzeBlockers(workspaceId, projectId, settings);
    actions.push(...blockerActions);
  }

  if (settings.auto_generate_standup) {
    const standupActions = await generateStandupSummary(workspaceId, projectId, settings);
    actions.push(...standupActions);
  }

  // Create action records in database
  const createdActions = [];
  for (const action of actions) {
    const created = await createAutopilotAction({
      workspaceId,
      projectId: action.projectId,
      taskId: action.taskId,
      actionType: action.type,
      reason: action.reason,
      currentState: action.currentState,
      proposedChanges: action.proposedChanges,
      confidenceScore: action.confidence,
      requireApproval: settings.require_approval,
      autoApproveAfterHours: settings.auto_approve_after_hours,
    });
    createdActions.push(created);
  }

  return {
    actionsCreated: createdActions.length,
    actions: createdActions,
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

  for (const task of unassignedTasks) {
    // Find best user for this task
    let bestUser = null;
    let reason = '';

    // Strategy 1: Find user with lowest workload under threshold
    const availableUser = workloads.find(w =>
      w.active_tasks < settings.max_tasks_per_user &&
      w.overdue_tasks === 0
    );

    if (availableUser) {
      bestUser = availableUser.user_id;
      reason = `User has ${availableUser.active_tasks} active tasks (below ${settings.max_tasks_per_user} threshold), no overdue tasks, and avg completion time of ${Math.round(availableUser.avg_completion_days || 0)} days.`;
    } else if (workloads.length > 0) {
      // Strategy 2: Find user with least tasks even if over threshold
      const leastBusyUser = workloads[0];
      bestUser = leastBusyUser.user_id;
      reason = `All users are at capacity. Assigning to least busy user with ${leastBusyUser.active_tasks} active tasks.`;
    } else if (allUsers.length > 0) {
      // Strategy 3: Random assignment if no workload data
      bestUser = allUsers[0].id;
      reason = `No workload history available. Assigning to team member for initial distribution.`;
    }

    if (bestUser) {
      // Get user details
      const { rows: [user] } = await pool.query(`SELECT username FROM users WHERE id = $1`, [bestUser]);

      actions.push({
        type: 'reassign',
        taskId: task.id,
        projectId: task.project_id,
        reason: `Unassigned task detected. ${reason}`,
        currentState: {
          task: task.task,
          assigned_to: null,
          status: task.status,
          due_date: task.due_date,
        },
        proposedChanges: {
          assigned_to: bestUser,
          assigned_to_username: user.username,
        },
        confidence: availableUser ? 0.85 : (workloads.length > 0 ? 0.65 : 0.50),
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
 * Generate AI-powered daily standup summary
 */
async function generateStandupSummary(workspaceId, projectId, settings) {
  // Get yesterday's activity
  const { rows: completedTasks } = await pool.query(`
    SELECT t.task, u.username, t.completed_at
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assigned_to
    WHERE t.workspace_id = $1
      ${projectId ? 'AND t.project_id = $2' : ''}
      AND t.status = 'completed'
      AND t.completed_at > NOW() - INTERVAL '24 hours'
    ORDER BY t.completed_at DESC
    LIMIT 10
  `, projectId ? [workspaceId, projectId] : [workspaceId]);

  const { rows: newTasks } = await pool.query(`
    SELECT t.task, u.username as assigned_to, t.created_at
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assigned_to
    WHERE t.workspace_id = $1
      ${projectId ? 'AND t.project_id = $2' : ''}
      AND t.created_at > NOW() - INTERVAL '24 hours'
    ORDER BY t.created_at DESC
    LIMIT 10
  `, projectId ? [workspaceId, projectId] : [workspaceId]);

  const { rows: overdueTasks } = await pool.query(`
    SELECT t.task, u.username as assigned_to, t.due_date
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assigned_to
    WHERE t.workspace_id = $1
      ${projectId ? 'AND t.project_id = $2' : ''}
      AND t.status NOT IN ('completed', 'cancelled')
      AND t.due_date < NOW()
    LIMIT 5
  `, projectId ? [workspaceId, projectId] : [workspaceId]);

  // Generate AI summary
  const prompt = `Generate a concise daily standup summary (max 150 words):

COMPLETED YESTERDAY (${completedTasks.length}):
${completedTasks.map(t => `- ${t.task} (by ${t.username || 'unknown'})`).join('\n')}

NEW TASKS (${newTasks.length}):
${newTasks.map(t => `- ${t.task} (assigned to ${t.assigned_to || 'unassigned'})`).join('\n')}

OVERDUE (${overdueTasks.length}):
${overdueTasks.map(t => `- ${t.task} (${t.assigned_to || 'unassigned'})`).join('\n')}

Provide:
1. Key accomplishments
2. Today's focus areas
3. Blockers/risks to highlight`;

  try {
    const summary = await generateText({ prompt });

    return [{
      type: 'create_standup',
      taskId: null,
      projectId,
      reason: 'Daily automated standup summary generated',
      currentState: {
        completed_count: completedTasks.length,
        new_count: newTasks.length,
        overdue_count: overdueTasks.length,
      },
      proposedChanges: {
        summary: summary.trim(),
        delivery_method: 'notification', // or 'chat', 'email'
      },
      confidence: 0.90,
    }];
  } catch (err) {
    console.error('Failed to generate standup summary:', err);
    return [];
  }
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
    console.error(`Failed to execute action ${actionId}:`, err);

    await pool.query(`
      UPDATE autopilot_actions
      SET status = 'failed'
      WHERE id = $1
    `, [actionId]);

    outcome = { status: 'failed', error: err.message };

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
  await pool.query(`
    UPDATE tasks
    SET assigned_to = $1, updated_at = NOW()
    WHERE id = $2
  `, [changes.assigned_to, action.task_id]);
}

async function executeDeadlineAdjust(action) {
  const changes = action.proposed_changes;
  await pool.query(`
    UPDATE tasks
    SET due_date = $1, updated_at = NOW()
    WHERE id = $2
  `, [changes.due_date, action.task_id]);
}

async function executeEscalation(action) {
  // Send notification to managers
  const { rows: managers } = await pool.query(`
    SELECT id FROM users
    WHERE workspace_id = $1 AND role IN ('manager', 'admin')
  `, [action.workspace_id]);

  for (const manager of managers) {
    await pool.query(`
      INSERT INTO notifications (user_id, type, message, task_id, project_id, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [
      manager.id,
      'task_escalated',
      action.reason,
      action.task_id,
      action.project_id,
    ]);
  }
}

async function executeStandupCreation(action) {
  const changes = action.proposed_changes;

  // Post to workspace general channel or send notifications
  console.log('Standup summary:', changes.summary);

  // Could post to chat, send emails, or create notification
  // Implementation depends on delivery method in proposed_changes
}
