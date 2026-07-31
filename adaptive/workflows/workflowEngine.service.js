import pool from "../../db.js";
import { getCapability } from "../capabilities/capabilityRegistry.js";
import { resolveApprovalPolicy, routeRecommendation, executeWorkflowCapability } from "../approvals/approvalEngine.service.js";
import { buildOperationalContext } from "../context/contextBuilder.service.js";
import { adaptiveStrategyPrior } from "../personalization/personalizationEngine.service.js";
import { compactSummary, getPath, stableHash } from "../shared/runtimeUtils.js";
import { validateWorkflowDefinition } from "./workflowValidator.js";
import { workflowConditionMatches } from "./workflowConditions.js";

export { workflowConditionMatches };

function cleanWorkflowKey(value) {
  const key = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  if (!key || key.length > 80) throw new Error("workflowKey must be 1-80 safe characters");
  return key;
}

export async function saveWorkflowDefinition({ workspaceId, actorUserId, workflowKey, name, description = null, definition, status = "draft" }) {
  const validation = validateWorkflowDefinition(definition);
  if (!validation.valid) throw new Error(validation.errors.join("; "));
  const safeKey = cleanWorkflowKey(workflowKey);
  const safeStatus = ["draft", "active", "paused", "archived"].includes(status) ? status : "draft";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`adaptive-workflow:${workspaceId}:${safeKey}`]);
    const { rows: versions } = await client.query(
      `SELECT COALESCE(MAX(version), 0)::int AS version
       FROM adaptive_workflow_definitions
       WHERE workspace_id = $1 AND workflow_key = $2`,
      [workspaceId, safeKey]
    );
    const version = Number(versions[0]?.version || 0) + 1;
    if (safeStatus === "active") {
      await client.query(
        `UPDATE adaptive_workflow_definitions
         SET status = 'paused', updated_by = $1, updated_at = NOW()
         WHERE workspace_id = $2 AND workflow_key = $3 AND status = 'active'`,
        [actorUserId, workspaceId, safeKey]
      );
    }
    const { rows } = await client.query(
      `
      INSERT INTO adaptive_workflow_definitions (
        workspace_id, workflow_key, name, description, version, status,
        definition, created_by, updated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8)
      RETURNING *
      `,
      [workspaceId, safeKey, String(name || safeKey).slice(0, 160), description, version, safeStatus, JSON.stringify(definition), actorUserId]
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listWorkflowDefinitions({ workspaceId, includeArchived = false }) {
  const { rows } = await pool.query(
    `SELECT * FROM adaptive_workflow_definitions
     WHERE workspace_id = $1 ${includeArchived ? "" : "AND status != 'archived'"}
     ORDER BY workflow_key, version DESC`,
    [workspaceId]
  );
  return rows;
}

export async function listWorkflowRuns({ workspaceId, workflowDefinitionId = null, limit = 20 }) {
  const params = [workspaceId];
  const where = ["r.workspace_id = $1"];
  if (workflowDefinitionId) {
    params.push(workflowDefinitionId);
    where.push(`r.workflow_definition_id = $${params.length}`);
  }
  params.push(Math.min(Math.max(Number(limit) || 20, 1), 100));
  const { rows } = await pool.query(
    `SELECT r.*, d.workflow_key, d.name AS workflow_name,
            a.status AS approval_action_status, a.executed_at AS action_executed_at
     FROM adaptive_workflow_runs r
     JOIN adaptive_workflow_definitions d
       ON d.id = r.workflow_definition_id AND d.workspace_id = r.workspace_id
     LEFT JOIN operations_ai_actions a
       ON a.workspace_id = r.workspace_id
      AND a.id::text = COALESCE(r.state->>'approvalActionId', r.state->>'lastApprovalActionId')
     WHERE ${where.join(" AND ")}
     ORDER BY r.started_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

export async function setWorkflowStatus({ workspaceId, workflowId, actorUserId, status }) {
  if (!["draft", "active", "paused", "archived"].includes(status)) throw new Error("Invalid workflow status");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: found } = await client.query(
      `SELECT * FROM adaptive_workflow_definitions WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [workflowId, workspaceId]
    );
    if (!found[0]) throw new Error("Workflow not found");
    if (status === "active") {
      await client.query(
        `UPDATE adaptive_workflow_definitions SET status = 'paused', updated_at = NOW()
         WHERE workspace_id = $1 AND workflow_key = $2 AND status = 'active' AND id != $3`,
        [workspaceId, found[0].workflow_key, workflowId]
      );
    }
    const { rows } = await client.query(
      `UPDATE adaptive_workflow_definitions
       SET status = $1, updated_by = $2, updated_at = NOW()
       WHERE id = $3 AND workspace_id = $4 RETURNING *`,
      [status, actorUserId, workflowId, workspaceId]
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function interpolate(value, source) {
  if (Array.isArray(value)) return value.map((item) => interpolate(item, source));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, source)]));
  }
  if (typeof value !== "string") return value;
  const exact = value.match(/^\{\{\s*([^}]+)\s*\}\}$/);
  if (exact) return getPath(source, exact[1].trim());
  return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, path) => String(getPath(source, path.trim()) ?? ""));
}

async function writeStep({ run, index, type, status, input = {}, output = {}, error = null }) {
  await pool.query(
    `
    INSERT INTO adaptive_workflow_step_runs (
      workspace_id, workflow_run_id, step_index, step_type, status,
      input_summary, output_summary, error_message, completed_at
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,
      CASE WHEN $5 IN ('succeeded','skipped','waiting','approval_pending','failed') THEN NOW() ELSE NULL END)
    ON CONFLICT (workflow_run_id, step_index) DO UPDATE SET
      status = EXCLUDED.status,
      input_summary = EXCLUDED.input_summary,
      output_summary = EXCLUDED.output_summary,
      error_message = EXCLUDED.error_message,
      completed_at = EXCLUDED.completed_at
    `,
    [run.workspace_id, run.id, index, type, status, JSON.stringify(compactSummary(input)), JSON.stringify(compactSummary(output)), error]
  );
}

function workflowActionType(capabilityKey, input) {
  if (capabilityKey === "notification.send") return input?.userId ? "notify_user" : "notify_supervisors";
  if (capabilityKey === "task.create") return "create_followup_task";
  if (capabilityKey === "workspace_memory.create") return "save_memory_entry";
  return getCapability(capabilityKey)?.planning?.actionType || null;
}

async function workflowApprovalMode({ event, input, step, state }) {
  if (state.approvalMode || step.approvalMode) return state.approvalMode || step.approvalMode;
  const strategy = await adaptiveStrategyPrior({
    workspaceId: event.workspaceId,
    userId: input.userId || input.assignedTo || event.actorUserId || null,
    teamId: event.metadata?.teamId || null,
    projectId: input.projectId || event.metadata?.projectId || null,
    departmentId: event.metadata?.departmentId || null,
    enterpriseId: event.metadata?.enterpriseId || null,
  });
  if (strategy.approvalBias === "prefer_manual_review") return "manual_only";
  if (strategy.approvalBias === "prefer_auto_when_safe" && step.autoEligible === true) return "automatic";
  return "approval_required";
}

async function executeWorkflowRun({ run, workflow, event, context, settings }) {
  const steps = workflow.definition?.steps || [];
  const source = { event, context, state: run.state || {} };
  let state = run.state || {};

  for (let index = Number(run.current_step || 0); index < steps.length; index += 1) {
    const step = steps[index];
    if (step.type === "WHEN") {
      const matched = step.eventTypes.includes(event.eventType);
      await writeStep({ run, index, type: step.type, status: matched ? "succeeded" : "skipped", input: { eventType: event.eventType }, output: { matched } });
      if (!matched) {
        await pool.query(`UPDATE adaptive_workflow_runs SET status = 'completed', current_step = $1, completed_at = NOW() WHERE id = $2`, [steps.length, run.id]);
        return { status: "completed", matched: false };
      }
    } else if (step.type === "IF") {
      const matched = workflowConditionMatches(step, source);
      await writeStep({ run, index, type: step.type, status: matched ? "succeeded" : "skipped", input: step, output: { matched } });
      if (!matched) {
        await pool.query(`UPDATE adaptive_workflow_runs SET status = 'completed', current_step = $1, completed_at = NOW() WHERE id = $2`, [steps.length, run.id]);
        return { status: "completed", matched: false };
      }
    } else if (step.type === "APPROVAL") {
      state = { ...state, approvalMode: step.mode };
      source.state = state;
      await writeStep({ run, index, type: step.type, status: "succeeded", output: { approvalMode: step.mode } });
    } else if (step.type === "WAIT") {
      if (run.status === "waiting" && run.resume_after && new Date(run.resume_after) <= new Date()) {
        await writeStep({ run, index, type: step.type, status: "succeeded", output: { resumedAt: new Date().toISOString() } });
      } else {
        const resumeAfter = new Date(Date.now() + Number(step.durationMinutes) * 60000);
        await writeStep({ run, index, type: step.type, status: "waiting", input: step, output: { resumeAfter } });
        await pool.query(
          `UPDATE adaptive_workflow_runs
           SET status = 'waiting', current_step = $1, state = $2::jsonb, resume_after = $3
           WHERE id = $4`,
          [index, JSON.stringify(state), resumeAfter, run.id]
        );
        return { status: "waiting", resumeAfter };
      }
    } else if (step.type === "THEN") {
      const input = interpolate(step.input || {}, source);
      const capability = getCapability(step.capabilityKey);
      if (!capability) throw new Error(`Unknown workflow capability: ${step.capabilityKey}`);
      const requestedApprovalMode = await workflowApprovalMode({ event, input, step, state });
      const approvalMode = await resolveApprovalPolicy({
        capability,
        settings,
        recommendation: {
          approvalMode: requestedApprovalMode,
          riskLevel: step.riskLevel || capability.riskLevel || "medium",
        },
      });
      const idempotencyKey = `workflow:${run.id}:step:${index}:${stableHash(input).slice(0, 16)}`;
      let output;
      const actionType = workflowActionType(step.capabilityKey, input);
      if (approvalMode !== "automatic" || !actionType) {
        if (!actionType) throw new Error(`Capability ${step.capabilityKey} cannot be proposed through the approval engine`);
        output = await routeRecommendation({
          event,
          runtimeRunId: run.runtime_run_id,
          settings,
          recommendation: {
            ruleKey: `workflow.${workflow.workflow_key}`,
            title: step.title || workflow.name,
            summary: step.summary || `Workflow ${workflow.name} selected ${step.capabilityKey}.`,
            explanation: `Workflow ${workflow.workflow_key} v${workflow.version} matched event ${event.eventType}.`,
            confidence: 1,
            riskLevel: step.riskLevel || "medium",
            capabilityKey: step.capabilityKey,
            actionType,
            approvalMode,
            targetUserId: input.userId || input.assignedTo || null,
            projectId: input.projectId || null,
            taskId: input.taskId || null,
            actorUserId: event.actorUserId,
            idempotencyKey,
            input,
            evidence: [{ type: "workflow_match", fact: `${workflow.workflow_key}@${workflow.version}`, source: "adaptive_workflow" }],
          },
        });
      } else {
        output = await executeWorkflowCapability({
          capabilityKey: step.capabilityKey,
          input,
          event,
          runtimeRunId: run.runtime_run_id,
          settings,
          approvalMode,
          idempotencyKey,
        });
      }
      await writeStep({ run, index, type: step.type, status: approvalMode === "automatic" ? "succeeded" : "approval_pending", input, output });
      if (approvalMode !== "automatic") {
        state = { ...state, approvalActionId: output?.action?.id || null };
        await pool.query(
          `UPDATE adaptive_workflow_runs
           SET status = 'approval_pending', current_step = $1, state = $2::jsonb, resume_after = NULL
           WHERE id = $3`,
          [index + 1, JSON.stringify(state), run.id]
        );
        return { status: "approval_pending", actionId: output?.action?.id || null };
      }
    } else if (step.type === "END") {
      await writeStep({ run, index, type: step.type, status: "succeeded" });
    }

    await pool.query(
      `UPDATE adaptive_workflow_runs SET current_step = $1, state = $2::jsonb, status = 'running', resume_after = NULL WHERE id = $3`,
      [index + 1, JSON.stringify(state), run.id]
    );
    run.current_step = index + 1;
    run.status = "running";
    run.resume_after = null;
  }

  await pool.query(`UPDATE adaptive_workflow_runs SET status = 'completed', completed_at = NOW() WHERE id = $1`, [run.id]);
  return { status: "completed", matched: true };
}

export async function startMatchingWorkflows({ event, runtimeRunId, context, settings }) {
  if (!settings.workflow_enabled) return [];
  const { rows: workflows } = await pool.query(
    `SELECT * FROM adaptive_workflow_definitions
     WHERE workspace_id = $1 AND status = 'active'`,
    [event.workspaceId]
  );
  const matching = workflows.filter((workflow) => workflow.definition?.steps?.[0]?.eventTypes?.includes(event.eventType));
  const results = [];
  for (const workflow of matching) {
    const { rows } = await pool.query(
      `
      INSERT INTO adaptive_workflow_runs (
        workspace_id, workflow_definition_id, workflow_version, event_id,
        runtime_run_id, state
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
      RETURNING *
      `,
      [
        event.workspaceId,
        workflow.id,
        workflow.version,
        event.eventId,
        runtimeRunId,
        JSON.stringify({ event: compactSummary(event), context: compactSummary(context) }),
      ]
    );
    try {
      results.push(await executeWorkflowRun({ run: rows[0], workflow, event, context, settings }));
    } catch (error) {
      await pool.query(`UPDATE adaptive_workflow_runs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`, [String(error.message).slice(0, 2000), rows[0].id]);
      results.push({ status: "failed", error: error.message });
    }
  }
  return results;
}

export async function resumeApprovedWorkflowRun({ workspaceId, workflowRunId, settingsLoader }) {
  const [runResult, workflowResult] = await Promise.all([
    pool.query(`SELECT * FROM adaptive_workflow_runs WHERE id = $1 AND workspace_id = $2`, [workflowRunId, workspaceId]),
    pool.query(
      `SELECT d.* FROM adaptive_workflow_definitions d
       JOIN adaptive_workflow_runs r ON r.workflow_definition_id = d.id
       WHERE r.id = $1 AND r.workspace_id = $2 AND d.workspace_id = $2`,
      [workflowRunId, workspaceId]
    ),
  ]);
  const run = runResult.rows[0];
  const workflow = workflowResult.rows[0];
  if (!run || !workflow) return null;
  const { rows: eventRows } = await pool.query(
    `SELECT id AS "eventId", workspace_id AS "workspaceId", actor_user_id AS "actorUserId",
            event_type AS "eventType", entity_type AS "entityType", entity_id AS "entityId",
            metadata, schema_version AS "schemaVersion", origin,
            correlation_id AS "correlationId", causation_id AS "causationId", trace_id AS "traceId",
            COALESCE(occurred_at, created_at) AS timestamp
     FROM workspace_events WHERE id = $1 AND workspace_id = $2`,
    [run.event_id, workspaceId]
  );
  const event = eventRows[0];
  if (!event) throw new Error("Workflow event no longer exists");
  const settings = await settingsLoader(workspaceId);
  try {
    const context = await buildOperationalContext({ event, settings });
    return await executeWorkflowRun({
      run: { ...run, status: "running" },
      workflow,
      event,
      context,
      settings,
    });
  } catch (error) {
    await pool.query(
      `UPDATE adaptive_workflow_runs
       SET status = 'failed', error_message = $1, completed_at = NOW()
       WHERE id = $2 AND workspace_id = $3`,
      [String(error.message).slice(0, 2000), workflowRunId, workspaceId]
    );
    throw error;
  }
}

export async function resumeDueWorkflowRuns({ limit = 20, workspaceId = null, settingsLoader }) {
  const { rows } = await pool.query(
    `
    WITH due AS (
      SELECT id FROM adaptive_workflow_runs
      WHERE status = 'waiting' AND resume_after <= NOW()
        AND ($2::uuid IS NULL OR workspace_id = $2)
      ORDER BY resume_after ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    )
    UPDATE adaptive_workflow_runs r
    SET status = 'running'
    FROM due
    WHERE r.id = due.id
    RETURNING r.*
    `,
    [Math.min(Math.max(Number(limit) || 20, 1), 50), workspaceId]
  );
  const results = [];
  for (const run of rows) {
    const [workflowResult, eventResult] = await Promise.all([
      pool.query(`SELECT * FROM adaptive_workflow_definitions WHERE id = $1`, [run.workflow_definition_id]),
      pool.query(
        `SELECT id AS "eventId", workspace_id AS "workspaceId", actor_user_id AS "actorUserId",
                event_type AS "eventType", entity_type AS "entityType", entity_id AS "entityId",
                metadata, schema_version AS "schemaVersion", origin,
                correlation_id AS "correlationId", trace_id AS "traceId",
                COALESCE(occurred_at, created_at) AS timestamp
         FROM workspace_events WHERE id = $1`,
        [run.event_id]
      ),
    ]);
    const workflow = workflowResult.rows[0];
    const event = eventResult.rows[0];
    if (!workflow || !event) continue;
    const settings = await settingsLoader(run.workspace_id);
    const context = await buildOperationalContext({ event, settings });
    results.push(await executeWorkflowRun({ run: { ...run, status: "waiting" }, workflow, event, context, settings }));
  }
  return results;
}
