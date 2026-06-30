import pool from "../db.js";
import { notifyUser } from "./notification.service.js";
import { createTask } from "./task.service.js";
import { createWorkspaceMemoryEntry } from "./workspaceMemory.service.js";
import { recordActionDecisionLearning } from "../adaptive/learning/learningEngine.service.js";
import { evaluateActionPredictions } from "../adaptive/evaluation/evaluationEngine.service.js";
import { assertExecutableApproval } from "../adaptive/approvals/approvalInvariant.js";

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
  confidenceModel = {},
  personalization = {},
  executionPlanId = null,
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
        idempotency_key,
        rule_confidence,
        prediction_confidence,
        outcome_confidence,
        acceptance_probability,
        execution_confidence,
        personalization_scope,
        personalization_source,
        execution_plan_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18,$19,$20,$21,
        $22,$23,$24,$25,$26,$27,$28,$29)
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
        confidenceModel.ruleConfidence ?? confidence,
        confidenceModel.predictionConfidence ?? null,
        confidenceModel.outcomeConfidence ?? null,
        confidenceModel.acceptanceProbability ?? null,
        confidenceModel.executionConfidence ?? null,
        personalization.scopeType || null,
        personalization.source || null,
        executionPlanId,
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

async function assertPlanDependencies(client, action) {
  if (!action.execution_plan_id) return;
  const { rows } = await client.query(
    `SELECT s.step_index, s.depends_on,
            COALESCE(jsonb_agg(jsonb_build_object('stepIndex', d.step_index, 'status', d.status))
              FILTER (WHERE d.id IS NOT NULL), '[]'::jsonb) AS dependencies
     FROM adaptive_execution_plan_steps s
     LEFT JOIN adaptive_execution_plan_steps d
       ON d.plan_id = s.plan_id AND d.step_index IN (
         SELECT value::int FROM jsonb_array_elements_text(s.depends_on)
       )
     WHERE s.plan_id = $1 AND s.action_id = $2
     GROUP BY s.step_index, s.depends_on`,
    [action.execution_plan_id, action.id]
  );
  const dependencies = rows[0]?.dependencies || [];
  const incomplete = dependencies.filter((item) => item.status !== "completed");
  if (incomplete.length) {
    const error = new Error("Execution plan prerequisites are not complete");
    error.code = "PLAN_DEPENDENCY_PENDING";
    error.details = incomplete;
    throw error;
  }
}

export async function executeOperationsAction({ id, workspaceId, actorId, role }) {
  const visibleAction = await getOperationsActionById({
    id,
    workspaceId,
    userId: actorId,
    role,
  });
  if (!visibleAction) throw new Error("Action not found");

  // The transaction-scoped advisory lock prevents two API calls from producing
  // duplicate side effects while retaining the existing action status contract.
  const client = await pool.connect();
  let rows;
  let result;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`operations-action:${workspaceId}:${id}`]);
    const locked = await client.query(
      `SELECT * FROM operations_ai_actions WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [id, workspaceId]
    );
    const action = locked.rows[0];
    assertExecutableApproval(action);
    await assertPlanDependencies(client, action);

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
    } else if (action.capability_key) {
      const { executeCapability } = await import("../adaptive/execution/executionEngine.service.js");
      const execution = await executeCapability({
        workspaceId,
        runtimeRunId: action.adaptive_runtime_run_id,
        capabilityKey: action.capability_key,
        input: action.payload || {},
        actor: { userId: actorId, role },
        settings: { enabled_capabilities: [] },
        approvalMode: action.approval_mode,
        idempotencyKey: `${action.idempotency_key || action.id}:execution`,
      });
      result = execution.output;
    } else {
      throw new Error(`Unsupported action type: ${action.action_type}`);
    }

    ({ rows } = await client.query(
      `
      UPDATE operations_ai_actions
      SET status = 'executed',
          executed_at = NOW(),
          result = $1::jsonb,
          updated_at = NOW()
      WHERE id = $2 AND workspace_id = $3 AND status = 'approved'
      RETURNING *
      `,
      [JSON.stringify(result || {}), id, workspaceId]
    ));
    if (!rows[0]) throw new Error("Action execution state changed before completion");
    if (rows[0].idempotency_key) {
      await client.query(
        `UPDATE adaptive_capability_invocations
         SET status = 'succeeded', output_summary = $1::jsonb, completed_at = NOW()
         WHERE workspace_id = $2 AND idempotency_key = $3 AND status = 'proposed'`,
        [JSON.stringify(result || {}), workspaceId, rows[0].idempotency_key]
      );
    }
    if (rows[0].execution_plan_id) {
      await client.query(
        `UPDATE adaptive_execution_plan_steps SET status = 'completed', updated_at = NOW()
         WHERE plan_id = $1 AND action_id = $2`,
        [rows[0].execution_plan_id, rows[0].id]
      );
      await client.query(
        `UPDATE adaptive_execution_plans p SET
           completed_steps = x.completed,
           failed_steps = x.failed,
           status = CASE WHEN x.completed = p.total_steps THEN 'completed'
                         WHEN x.completed > 0 THEN 'partial' ELSE 'running' END,
           completed_at = CASE WHEN x.completed = p.total_steps THEN NOW() ELSE NULL END,
           updated_at = NOW()
         FROM (SELECT plan_id,
                      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
                      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
               FROM adaptive_execution_plan_steps WHERE plan_id = $1 GROUP BY plan_id) x
         WHERE p.id = x.plan_id`,
        [rows[0].execution_plan_id]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

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

  if (rows[0]?.execution_plan_id) {
    await pool.query(
      `UPDATE adaptive_execution_plan_steps SET status = 'approved', updated_at = NOW()
       WHERE plan_id = $1 AND action_id = $2`,
      [rows[0].execution_plan_id, rows[0].id]
    );
  }

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

  if (rows[0]?.execution_plan_id) {
    await pool.query(
      `UPDATE adaptive_execution_plan_steps SET status = 'skipped', updated_at = NOW()
       WHERE plan_id = $1 AND action_id = $2`,
      [rows[0].execution_plan_id, rows[0].id]
    );
    await pool.query(
      `UPDATE adaptive_execution_plans SET status = 'partial', updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2`,
      [rows[0].execution_plan_id, workspaceId]
    );
  }

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
