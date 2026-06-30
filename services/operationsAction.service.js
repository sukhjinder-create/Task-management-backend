import pool from "../db.js";
import { notifyUser } from "./notification.service.js";
import { createTask } from "./task.service.js";
import { createWorkspaceMemoryEntry } from "./workspaceMemory.service.js";
import { recordActionDecisionLearning } from "../adaptive/learning/learningEngine.service.js";
import { evaluateActionPredictions } from "../adaptive/evaluation/evaluationEngine.service.js";

async function recordDecision({
  actionId,
  workspaceId,
  decision,
  decisionBy,
  notes = null,
  outcome = {},
}) {
  await pool.query(
    `
    INSERT INTO operations_ai_action_decisions (
      action_id,
      workspace_id,
      decision,
      notes,
      decision_by,
      outcome
    )
    VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    `,
    [actionId, workspaceId, decision, notes, decisionBy, JSON.stringify(outcome || {})]
  );
}

async function getWorkspaceLeadUsers(workspaceId, projectId = null) {
  if (projectId) {
    const { rows } = await pool.query(
      `
      SELECT DISTINCT u.id, u.username, u.role
      FROM users u
      JOIN workspace_users wu ON wu.user_id = u.id AND wu.workspace_id = $1
      WHERE wu.billing_status != 'pending'
        AND (
          u.role IN ('admin', 'owner')
          OR (u.role = 'manager' AND $2 = ANY(u.projects))
        )
      `,
      [workspaceId, projectId]
    );
    return rows;
  }

  const { rows } = await pool.query(
    `
    SELECT u.id, u.username, u.role
    FROM users u
    JOIN workspace_users wu ON wu.user_id = u.id AND wu.workspace_id = $1
    WHERE wu.billing_status != 'pending'
      AND u.role IN ('admin', 'owner', 'manager')
    `,
    [workspaceId]
  );
  return rows;
}

export async function createOperationsAction({
  workspaceId,
  source = "operations",
  roleScope = "workspace",
  title,
  summary,
  explanation = null,
  confidence = null,
  riskLevel = "medium",
  actionType,
  createdBy = null,
  targetUserId = null,
  projectId = null,
  taskId = null,
  payload = {},
  evidence = [],
  generatedBy = "system",
  adaptiveRuntimeRunId = null,
  capabilityKey = null,
  approvalMode = "approval_required",
  correlationId = null,
  idempotencyKey = null,
}) {
  let rows;
  try {
    ({ rows } = await pool.query(
      `
      INSERT INTO operations_ai_actions (
        workspace_id,
        source,
        role_scope,
        title,
        summary,
        explanation,
        confidence,
        risk_level,
        action_type,
        created_by,
        target_user_id,
        project_id,
        task_id,
        payload,
        evidence,
        generated_by,
        adaptive_runtime_run_id,
        capability_key,
        approval_mode,
        correlation_id,
        idempotency_key
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18,$19,$20,$21)
      RETURNING *
      `,
      [
        workspaceId,
        source,
        roleScope,
        title,
        summary,
        explanation,
        confidence,
        riskLevel,
        actionType,
        createdBy,
        targetUserId,
        projectId,
        taskId,
        JSON.stringify(payload || {}),
        JSON.stringify(Array.isArray(evidence) ? evidence : []),
        generatedBy,
        adaptiveRuntimeRunId,
        capabilityKey,
        approvalMode,
        correlationId,
        idempotencyKey,
      ]
    ));
  } catch (error) {
    if (error?.code !== "23505" || !idempotencyKey) throw error;
    const existing = await findOperationsActionByIdempotencyKey({ workspaceId, idempotencyKey });
    if (existing) return existing;
    throw error;
  }

  return rows[0];
}

export async function findOperationsActionByIdempotencyKey({ workspaceId, idempotencyKey }) {
  if (!idempotencyKey) return null;
  const { rows } = await pool.query(
    `SELECT * FROM operations_ai_actions
     WHERE workspace_id = $1 AND idempotency_key = $2
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, idempotencyKey]
  );
  return rows[0] || null;
}

export async function findRecentMatchingAction({
  workspaceId,
  actionType,
  title,
  targetUserId = null,
  taskId = null,
  projectId = null,
  lookbackHours = 24,
}) {
  const { rows } = await pool.query(
    `
    SELECT id, status
    FROM operations_ai_actions
    WHERE workspace_id = $1
      AND action_type = $2
      AND title = $3
      AND COALESCE(target_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE($4, '00000000-0000-0000-0000-000000000000'::uuid)
      AND COALESCE(task_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE($5, '00000000-0000-0000-0000-000000000000'::uuid)
      AND COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE($6, '00000000-0000-0000-0000-000000000000'::uuid)
      AND created_at >= NOW() - ($7::text || ' hours')::interval
      AND status IN ('pending', 'approved', 'executed')
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [workspaceId, actionType, title, targetUserId, taskId, projectId, String(lookbackHours)]
  );

  return rows[0] || null;
}

export async function listOperationsActions({
  workspaceId,
  userId,
  role,
  status = "pending",
  limit = 50,
}) {
  const params = [workspaceId];
  const where = [`a.workspace_id = $1`];
  let idx = 2;

  if (status && status !== "all") {
    where.push(`a.status = $${idx++}`);
    params.push(status);
  }

  if (!(role === "admin" || role === "owner" || role === "manager")) {
    where.push(`(a.target_user_id = $${idx} OR a.created_by = $${idx})`);
    params.push(userId);
    idx += 1;
  }

  params.push(Math.min(Math.max(Number(limit) || 50, 1), 100));

  const { rows } = await pool.query(
    `
    SELECT
      a.*,
      u.username AS target_user_name,
      p.name AS project_name,
      t.task AS task_title
    FROM operations_ai_actions a
    LEFT JOIN users u ON u.id = a.target_user_id
    LEFT JOIN projects p ON p.id = a.project_id
    LEFT JOIN tasks t ON t.id = a.task_id
    WHERE ${where.join(" AND ")}
    ORDER BY a.created_at DESC
    LIMIT $${idx}
    `,
    params
  );

  return rows;
}

export async function getOperationsActionById({ id, workspaceId, userId, role }) {
  const { rows } = await pool.query(
    `
    SELECT
      a.*,
      u.username AS target_user_name,
      p.name AS project_name,
      t.task AS task_title
    FROM operations_ai_actions a
    LEFT JOIN users u ON u.id = a.target_user_id
    LEFT JOIN projects p ON p.id = a.project_id
    LEFT JOIN tasks t ON t.id = a.task_id
    WHERE a.id = $1
      AND a.workspace_id = $2
    `,
    [id, workspaceId]
  );

  const action = rows[0] || null;
  if (!action) return null;

  if (!(role === "admin" || role === "owner" || role === "manager")) {
    if (
      String(action.target_user_id || "") !== String(userId)
      && String(action.created_by || "") !== String(userId)
    ) {
      return null;
    }
  }

  return action;
}

async function executeNotifyAction(action, actorId) {
  const payload = action.payload || {};
  const targetUsers = [];

  if (action.action_type === "notify_user" && action.target_user_id) {
    targetUsers.push(action.target_user_id);
  }

  if (action.action_type === "notify_supervisors") {
    const leads = await getWorkspaceLeadUsers(action.workspace_id, action.project_id);
    for (const lead of leads) {
      targetUsers.push(lead.id);
    }
  }

  if (action.action_type === "notify_user_and_supervisors") {
    if (action.target_user_id) {
      targetUsers.push(action.target_user_id);
    }
    const leads = await getWorkspaceLeadUsers(action.workspace_id, action.project_id);
    for (const lead of leads) {
      targetUsers.push(lead.id);
    }
  }

  const notified = new Set();
  for (const targetUserId of targetUsers) {
    if (!targetUserId || notified.has(String(targetUserId))) continue;
    notified.add(String(targetUserId));
    await notifyUser({
      user_id: targetUserId,
      type: "operations_action",
      message: payload.message || action.summary,
      task_id: action.task_id,
      project_id: action.project_id,
      workspaceId: action.workspace_id,
    });
  }

  return {
    notifiedUsers: Array.from(notified),
    executedBy: actorId,
  };
}

async function executeCreateFollowupTask(action, actorId) {
  const payload = action.payload || {};
  if (!payload.projectId || !payload.taskTitle) {
    throw new Error("Missing projectId or taskTitle for follow-up task action");
  }

  const created = await createTask({
    task: payload.taskTitle,
    project_id: payload.projectId,
    status: "pending",
    added_by: actorId,
    assigned_to: payload.assignedTo || null,
    due_date: payload.dueDate || null,
    description: payload.description || action.summary,
    priority: payload.priority || "high",
    workspaceId: action.workspace_id,
  });

  return {
    createdTaskId: created.id,
    displayId: created.display_id || null,
  };
}

async function executeSaveMemoryEntry(action, actorId) {
  const payload = action.payload || {};
  const created = await createWorkspaceMemoryEntry({
    workspaceId: action.workspace_id,
    userId: actorId,
    role: "admin",
    title: payload.title || action.title,
    content: payload.content || action.summary,
    tags: payload.tags || ["operations"],
    visibility: payload.visibility || "workspace",
    sourceEntityType: payload.sourceEntityType || null,
    sourceEntityId: payload.sourceEntityId || null,
    metadata: payload.metadata || {
      actionId: action.id,
      source: action.source,
    },
    isPinned: Boolean(payload.isPinned),
  });

  return {
    memoryEntryId: created.id,
  };
}

export async function executeOperationsAction({ id, workspaceId, actorId, role }) {
  const action = await getOperationsActionById({
    id,
    workspaceId,
    userId: actorId,
    role,
  });

  if (!action) {
    throw new Error("Action not found");
  }
  if (action.status === "executed") {
    throw new Error("Action already executed");
  }
  if (action.status === "rejected") {
    throw new Error("Rejected actions cannot be executed");
  }

  let result;
  if (
    action.action_type === "notify_user"
    || action.action_type === "notify_supervisors"
    || action.action_type === "notify_user_and_supervisors"
  ) {
    result = await executeNotifyAction(action, actorId);
  } else if (action.action_type === "create_followup_task") {
    result = await executeCreateFollowupTask(action, actorId);
  } else if (action.action_type === "save_memory_entry") {
    result = await executeSaveMemoryEntry(action, actorId);
  } else {
    throw new Error(`Unsupported action type: ${action.action_type}`);
  }

  const { rows } = await pool.query(
    `
    UPDATE operations_ai_actions
    SET status = 'executed',
        approved_by = COALESCE(approved_by, $1),
        approved_at = COALESCE(approved_at, NOW()),
        executed_at = NOW(),
        result = $2::jsonb,
        updated_at = NOW()
    WHERE id = $3
      AND workspace_id = $4
    RETURNING *
    `,
    [actorId, JSON.stringify(result || {}), id, workspaceId]
  );

  await recordDecision({
    actionId: id,
    workspaceId,
    decision: "executed",
    decisionBy: actorId,
    outcome: result,
  });

  await recordActionDecisionLearning({
    action: rows[0],
    decision: "executed",
    actorUserId: actorId,
    outcome: result,
  });
  if (rows[0]?.source === "adaptive_runtime") {
    const { completeWorkflowApprovalOutcome } = await import("../adaptive/workflows/workflowOutcome.service.js");
    await completeWorkflowApprovalOutcome({ workspaceId, actionId: id, executed: true });
  }

  return rows[0];
}

export async function approveOperationsAction({
  id,
  workspaceId,
  actorId,
  role,
  notes = null,
  execute = false,
}) {
  const action = await getOperationsActionById({
    id,
    workspaceId,
    userId: actorId,
    role,
  });
  if (!action) {
    throw new Error("Action not found");
  }
  if (action.status === "executed") {
    throw new Error("Action already executed");
  }
  if (action.status === "rejected") {
    throw new Error("Action already rejected");
  }

  const { rows } = await pool.query(
    `
    UPDATE operations_ai_actions
    SET status = 'approved',
        approved_by = $1,
        approved_at = NOW(),
        updated_at = NOW()
    WHERE id = $2
      AND workspace_id = $3
    RETURNING *
    `,
    [actorId, id, workspaceId]
  );

  await recordDecision({
    actionId: id,
    workspaceId,
    decision: "approved",
    decisionBy: actorId,
    notes,
  });

  await recordActionDecisionLearning({
    action: rows[0],
    decision: "approved",
    actorUserId: actorId,
    notes,
  });
  await evaluateActionPredictions({
    workspaceId,
    actionId: id,
    accepted: true,
    actorUserId: actorId,
  });

  if (execute) {
    return executeOperationsAction({ id, workspaceId, actorId, role });
  }

  return rows[0];
}

export async function rejectOperationsAction({
  id,
  workspaceId,
  actorId,
  role,
  notes = null,
}) {
  const action = await getOperationsActionById({
    id,
    workspaceId,
    userId: actorId,
    role,
  });
  if (!action) {
    throw new Error("Action not found");
  }
  if (action.status === "executed") {
    throw new Error("Action already executed");
  }
  if (action.status === "rejected") {
    throw new Error("Action already rejected");
  }

  const { rows } = await pool.query(
    `
    UPDATE operations_ai_actions
    SET status = 'rejected',
        approved_by = $1,
        approved_at = NOW(),
        updated_at = NOW()
    WHERE id = $2
      AND workspace_id = $3
    RETURNING *
    `,
    [actorId, id, workspaceId]
  );

  await recordDecision({
    actionId: id,
    workspaceId,
    decision: "rejected",
    decisionBy: actorId,
    notes,
  });

  await recordActionDecisionLearning({
    action: rows[0],
    decision: "rejected",
    actorUserId: actorId,
    notes,
  });
  if (rows[0]?.source === "adaptive_runtime") {
    const { rejectWorkflowApprovalOutcome } = await import("../adaptive/workflows/workflowOutcome.service.js");
    await rejectWorkflowApprovalOutcome({ workspaceId, actionId: id, reason: notes });
  }
  await evaluateActionPredictions({
    workspaceId,
    actionId: id,
    accepted: false,
    actorUserId: actorId,
  });

  return rows[0];
}
