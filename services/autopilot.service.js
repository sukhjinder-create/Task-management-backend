// services/autopilot.service.js
import pool from "../db.js";
import { runAutopilotAnalysis, executeAutopilotAction } from "../autopilot/autopilot.engine.js";

/* =====================================================
   AUTOPILOT SETTINGS MANAGEMENT
===================================================== */

export async function getAutopilotSettings(workspaceId, projectId = null) {
  const query = projectId
    ? `SELECT * FROM autopilot_settings
       WHERE workspace_id = $1 AND project_id = $2
       LIMIT 1`
    : `SELECT * FROM autopilot_settings
       WHERE workspace_id = $1 AND project_id IS NULL
       LIMIT 1`;

  const params = projectId ? [workspaceId, projectId] : [workspaceId];
  const { rows } = await pool.query(query, params);

  return rows[0] || null;
}

export async function createOrUpdateAutopilotSettings({
  workspaceId,
  projectId = null,
  enabled = false,
  mode = 'assisted',
  autoAssign = true,
  autoDeadlineAdjust = true,
  autoEscalateBlockers = true,
  autoGenerateStandup = true,
  maxTasksPerUser = 10,
  blockerThresholdHours = 48,
  velocityDropThreshold = 0.20,
  requireApproval = true,
  autoApproveAfterHours = 24,
  approvalUserId = null,
}) {
  const existing = await getAutopilotSettings(workspaceId, projectId);

  // If disabling autopilot, cancel all pending actions
  if (existing && existing.enabled && !enabled) {
    console.log(`🤖 Disabling autopilot - cancelling pending actions for workspace ${workspaceId}`);
    await pool.query(`
      UPDATE autopilot_actions
      SET status = 'rejected',
          approved_at = NOW()
      WHERE workspace_id = $1
        AND status = 'pending'
        ${projectId ? 'AND project_id = $2' : ''}
    `, projectId ? [workspaceId, projectId] : [workspaceId]);
  }

  if (existing) {
    // Update existing
    const { rows } = await pool.query(`
      UPDATE autopilot_settings
      SET enabled = $1,
          mode = $2,
          auto_assign = $3,
          auto_deadline_adjust = $4,
          auto_escalate_blockers = $5,
          auto_generate_standup = $6,
          max_tasks_per_user = $7,
          blocker_threshold_hours = $8,
          velocity_drop_threshold = $9,
          require_approval = $10,
          auto_approve_after_hours = $11,
          approval_user_id = $12,
          updated_at = NOW()
      WHERE id = $13
      RETURNING *
    `, [
      enabled, mode, autoAssign, autoDeadlineAdjust, autoEscalateBlockers,
      autoGenerateStandup, maxTasksPerUser, blockerThresholdHours,
      velocityDropThreshold, requireApproval, autoApproveAfterHours,
      approvalUserId, existing.id
    ]);

    return rows[0];
  } else {
    // Create new
    const { rows } = await pool.query(`
      INSERT INTO autopilot_settings (
        workspace_id, project_id, enabled, mode,
        auto_assign, auto_deadline_adjust, auto_escalate_blockers, auto_generate_standup,
        max_tasks_per_user, blocker_threshold_hours, velocity_drop_threshold,
        require_approval, auto_approve_after_hours, approval_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `, [
      workspaceId, projectId, enabled, mode, autoAssign, autoDeadlineAdjust,
      autoEscalateBlockers, autoGenerateStandup, maxTasksPerUser,
      blockerThresholdHours, velocityDropThreshold, requireApproval,
      autoApproveAfterHours, approvalUserId
    ]);

    return rows[0];
  }
}

/* =====================================================
   AUTOPILOT ACTIONS MANAGEMENT
===================================================== */

export async function getPendingActions(workspaceId, projectId = null) {
  const query = projectId
    ? `SELECT a.*, t.task as task_title
       FROM autopilot_actions a
       LEFT JOIN tasks t ON t.id = a.task_id
       WHERE a.workspace_id = $1 AND a.project_id = $2 AND a.status = 'pending'
       ORDER BY a.confidence_score DESC, a.created_at ASC`
    : `SELECT a.*, t.task as task_title
       FROM autopilot_actions a
       LEFT JOIN tasks t ON t.id = a.task_id
       WHERE a.workspace_id = $1 AND a.status = 'pending'
       ORDER BY a.confidence_score DESC, a.created_at ASC`;

  const params = projectId ? [workspaceId, projectId] : [workspaceId];
  const { rows } = await pool.query(query, params);

  return rows;
}

export async function getActionById(actionId) {
  const { rows } = await pool.query(`
    SELECT a.*, t.task as task_title, p.name as project_name
    FROM autopilot_actions a
    LEFT JOIN tasks t ON t.id = a.task_id
    LEFT JOIN projects p ON p.id = a.project_id
    WHERE a.id = $1
  `, [actionId]);

  if (rows.length === 0) {
    throw new Error('Action not found');
  }

  return rows[0];
}

export async function approveAction(actionId, userId) {
  await executeAutopilotAction(actionId, userId);
  return await getActionById(actionId);
}

export async function rejectAction(actionId, userId, reason = null) {
  const { rows } = await pool.query(`
    UPDATE autopilot_actions
    SET status = 'rejected',
        approved_by = $1,
        approved_at = NOW()
    WHERE id = $2
    RETURNING *
  `, [userId, actionId]);

  // Record decision
  await pool.query(`
    INSERT INTO autopilot_decisions (
      workspace_id,
      action_id,
      decision,
      decision_by,
      outcome_status,
      outcome_data,
      user_feedback
    ) VALUES (
      (SELECT workspace_id FROM autopilot_actions WHERE id = $1),
      $1, 'rejected', $2, NULL, NULL, $3
    )
  `, [actionId, userId, reason]);

  return rows[0];
}

/* =====================================================
   AUTOPILOT RUNNER
===================================================== */

export async function runAutopilot(workspaceId, projectId = null) {
  return await runAutopilotAnalysis({ workspaceId, projectId });
}

export async function getAutopilotStats(workspaceId, projectId = null) {
  const query = projectId
    ? `SELECT
        COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
        COUNT(*) FILTER (WHERE status = 'executed') as executed_count,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejected_count,
        COUNT(*) FILTER (WHERE status = 'auto_approved') as auto_approved_count,
        AVG(confidence_score) as avg_confidence
       FROM autopilot_actions
       WHERE workspace_id = $1 AND project_id = $2`
    : `SELECT
        COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
        COUNT(*) FILTER (WHERE status = 'executed') as executed_count,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejected_count,
        COUNT(*) FILTER (WHERE status = 'auto_approved') as auto_approved_count,
        AVG(confidence_score) as avg_confidence
       FROM autopilot_actions
       WHERE workspace_id = $1`;

  const params = projectId ? [workspaceId, projectId] : [workspaceId];
  const { rows } = await pool.query(query, params);

  return rows[0];
}

/* =====================================================
   AUTO-APPROVAL PROCESSOR (for cron)
===================================================== */

export async function processAutoApprovals() {
  // Find actions that have expired and should auto-approve
  // ONLY for workspaces where autopilot is still enabled
  const { rows: expiredActions } = await pool.query(`
    SELECT a.id, a.workspace_id
    FROM autopilot_actions a
    INNER JOIN autopilot_settings s ON s.workspace_id = a.workspace_id
    WHERE a.status = 'pending'
      AND a.expires_at IS NOT NULL
      AND a.expires_at < NOW()
      AND s.enabled = true
      AND s.require_approval = true
  `);

  console.log(`🤖 Processing ${expiredActions.length} auto-approvals`);

  const results = [];
  for (const action of expiredActions) {
    try {
      await executeAutopilotAction(action.id, null);
      results.push({ id: action.id, status: 'executed' });
    } catch (err) {
      console.error(`Failed to auto-execute action ${action.id}:`, err);
      results.push({ id: action.id, status: 'failed', error: err.message });
    }
  }

  return results;
}
