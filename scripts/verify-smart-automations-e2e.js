import crypto from "node:crypto";
import pool from "../db.js";

process.env.ADAPTIVE_RUNTIME_WORKER_ENABLED = "false";
process.env.EMAIL_NOTIFICATIONS_ENABLED = "false";
process.env.SLACK_WEBHOOK_URL = "";
process.env.FIREBASE_SERVICE_ACCOUNT_B64 = "";

function assertLocalDatabase() {
  const configuredHost = (() => {
    if (process.env.DATABASE_URL) {
      try { return new URL(process.env.DATABASE_URL).hostname.toLowerCase(); } catch { return ""; }
    }
    return String(process.env.DB_HOST || "").trim().toLowerCase();
  })();
  if (!["localhost", "127.0.0.1", "::1"].includes(configuredHost) && !configuredHost.endsWith(".local")) {
    throw new Error("This verifier intentionally refuses to write to a non-local database.");
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function tableExists(name) {
  const { rows } = await pool.query("SELECT to_regclass($1) AS name", [`public.${name}`]);
  return Boolean(rows[0]?.name);
}

async function deleteByActionIds(table, actionIds) {
  if (!actionIds.length || !(await tableExists(table))) return;
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'action_id'`,
    [table]
  );
  if (!rows.length) return;
  await pool.query(`DELETE FROM ${table} WHERE action_id = ANY($1::uuid[])`, [actionIds]);
}

async function restoreSettings(workspaceId, original) {
  if (!original) {
    await pool.query("DELETE FROM adaptive_runtime_settings WHERE workspace_id = $1", [workspaceId]);
    return;
  }
  await pool.query(
    `INSERT INTO adaptive_runtime_settings (
       workspace_id, mode, event_capture_enabled, workflow_enabled,
       default_approval_mode, enabled_capabilities, context_limits, policy,
       version, updated_by, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12)
     ON CONFLICT (workspace_id) DO UPDATE SET
       mode = EXCLUDED.mode,
       event_capture_enabled = EXCLUDED.event_capture_enabled,
       workflow_enabled = EXCLUDED.workflow_enabled,
       default_approval_mode = EXCLUDED.default_approval_mode,
       enabled_capabilities = EXCLUDED.enabled_capabilities,
       context_limits = EXCLUDED.context_limits,
       policy = EXCLUDED.policy,
       version = EXCLUDED.version,
       updated_by = EXCLUDED.updated_by,
       created_at = EXCLUDED.created_at,
       updated_at = EXCLUDED.updated_at`,
    [
      original.workspace_id,
      original.mode,
      original.event_capture_enabled,
      original.workflow_enabled,
      original.default_approval_mode,
      JSON.stringify(original.enabled_capabilities || []),
      JSON.stringify(original.context_limits || {}),
      JSON.stringify(original.policy || {}),
      original.version,
      original.updated_by,
      original.created_at,
      original.updated_at,
    ]
  );
}

async function restoreProfiles(workspaceId, originals) {
  await pool.query("DELETE FROM adaptive_preference_profiles WHERE workspace_id = $1", [workspaceId]);
  for (const profile of originals) {
    await pool.query(
      `INSERT INTO adaptive_preference_profiles (
         id, workspace_id, scope_type, scope_id, profile_key, profile_value,
         confidence, sample_count, version, explanation, last_signal_at,
         created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13)`,
      [
        profile.id, profile.workspace_id, profile.scope_type, profile.scope_id,
        profile.profile_key, JSON.stringify(profile.profile_value || {}),
        profile.confidence, profile.sample_count, profile.version,
        profile.explanation, profile.last_signal_at, profile.created_at, profile.updated_at,
      ]
    );
  }
}

async function main() {
  assertLocalDatabase();

  const marker = `smart-automation-e2e-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const eventId = crypto.randomUUID();
  const correlationId = crypto.randomUUID();
  let workspaceId = null;
  let actorUserId = null;
  let workflowId = null;
  let runtimeRunId = null;
  let queueId = null;
  let originalSettings = null;
  let originalProfiles = [];
  let originalAiAutoReply = null;
  let workerId = null;
  const actionIds = new Set();

  try {
    const { rows: candidates } = await pool.query(
      `SELECT w.id AS workspace_id, member.user_id
       FROM workspaces w
       JOIN LATERAL (
         SELECT u.id AS user_id
         FROM workspace_users wu
         JOIN users u ON u.id = wu.user_id
         WHERE wu.workspace_id = w.id
           AND COALESCE(wu.billing_status, 'active') != 'pending'
           AND u.role IN ('admin', 'owner')
         ORDER BY wu.created_at ASC
         LIMIT 1
       ) member ON TRUE
       WHERE NOT EXISTS (
         SELECT 1 FROM adaptive_workflow_definitions d
         WHERE d.workspace_id = w.id AND d.status = 'active'
       )
         AND NOT EXISTS (
           SELECT 1 FROM adaptive_event_queue q
           WHERE q.workspace_id = w.id AND q.status IN ('pending', 'processing')
         )
       ORDER BY w.created_at DESC
       LIMIT 1`
    );
    const candidate = candidates[0];
    assert(candidate, "No isolated local workspace with an administrator is available for verification.");
    workspaceId = candidate.workspace_id;
    actorUserId = candidate.user_id;

    ({ rows: [originalSettings] } = await pool.query(
      "SELECT * FROM adaptive_runtime_settings WHERE workspace_id = $1",
      [workspaceId]
    ));
    ({ rows: originalProfiles } = await pool.query(
      "SELECT * FROM adaptive_preference_profiles WHERE workspace_id = $1 ORDER BY created_at",
      [workspaceId]
    ));
    const { rows: aiSettingsRows } = await pool.query(
      "SELECT ai_auto_reply FROM workspace_ai_settings WHERE workspace_id = $1",
      [workspaceId]
    );
    if (aiSettingsRows[0]) {
      originalAiAutoReply = aiSettingsRows[0].ai_auto_reply;
      await pool.query(
        "UPDATE workspace_ai_settings SET ai_auto_reply = FALSE WHERE workspace_id = $1",
        [workspaceId]
      );
    }

    const { bootstrapAdaptivePlatform } = await import("../adaptive/bootstrap.js");
    const { updateRuntimeSettings } = await import("../adaptive/config/runtimeSettings.service.js");
    const { storeWorkspaceEvent } = await import("../events/store/eventStore.js");
    const { enqueueAdaptiveEvent } = await import("../adaptive/events/eventQueue.repository.js");
    const { saveWorkflowDefinition } = await import("../adaptive/workflows/workflowEngine.service.js");
    const { processAdaptiveWorkerBatch, getAdaptiveWorkerDiagnostics } = await import("../adaptive/runtime/adaptiveWorker.service.js");
    const { approveOperationsAction } = await import("../services/operationsAction.service.js");

    bootstrapAdaptivePlatform();
    workerId = getAdaptiveWorkerDiagnostics().workerId;
    await updateRuntimeSettings({
      workspaceId,
      actorUserId,
      patch: {
        mode: "shadow",
        eventCaptureEnabled: true,
        workflowEnabled: true,
        defaultApprovalMode: "approval_required",
        contextLimits: { timeoutMs: 5000 },
      },
    });

    const workflow = await saveWorkflowDefinition({
      workspaceId,
      actorUserId,
      workflowKey: marker,
      name: "Smart automation end-to-end verification",
      description: "Temporary local verification rule; removed automatically.",
      status: "active",
      definition: {
        steps: [
          { type: "WHEN", eventTypes: ["KNOWLEDGE_UPDATED"] },
          { type: "IF", path: "context.data.event.type", operator: "equals", value: "KNOWLEDGE_UPDATED" },
          { type: "APPROVAL", mode: "approval_required" },
          {
            type: "THEN",
            capabilityKey: "notification.send",
            title: "First governed notification",
            input: { userId: actorUserId, message: `${marker}: first approved action` },
          },
          {
            type: "THEN",
            capabilityKey: "notification.send",
            title: "Second governed notification",
            input: { userId: actorUserId, message: `${marker}: second approved action` },
          },
          { type: "END" },
        ],
      },
    });
    workflowId = workflow.id;

    const event = {
      eventId,
      workspaceId,
      actorUserId,
      eventType: "KNOWLEDGE_UPDATED",
      entityType: "knowledge",
      entityId: null,
      origin: "local_verification",
      schemaVersion: 1,
      correlationId,
      traceId: crypto.randomUUID(),
      metadata: { actorRole: "admin", verificationMarker: marker },
      timestamp: new Date().toISOString(),
    };
    assert(await storeWorkspaceEvent(event), "The verification event was not stored.");
    const queued = await enqueueAdaptiveEvent(event);
    assert(queued, "The verification event was not queued.");
    queueId = queued.id;

    const batch = await processAdaptiveWorkerBatch({ workspaceId, limit: 10 });
    assert(batch.events.some((item) => item.queueId === queueId && item.status === "completed"), "The worker did not complete the queued event.");

    const { rows: initialRuns } = await pool.query(
      "SELECT * FROM adaptive_workflow_runs WHERE workflow_definition_id = $1 ORDER BY started_at DESC",
      [workflowId]
    );
    const workflowRun = initialRuns[0];
    assert(workflowRun?.status === "approval_pending", "The matched rule did not stop for approval.");
    runtimeRunId = workflowRun.runtime_run_id;
    const firstActionId = workflowRun.state?.approvalActionId;
    assert(firstActionId, "The first approval action was not created.");
    actionIds.add(firstActionId);

    await approveOperationsAction({
      id: firstActionId,
      workspaceId,
      actorId: actorUserId,
      role: "admin",
      notes: "Local end-to-end verification",
      execute: true,
    });

    const { rows: afterFirstRows } = await pool.query(
      "SELECT * FROM adaptive_workflow_runs WHERE id = $1",
      [workflowRun.id]
    );
    const afterFirst = afterFirstRows[0];
    const secondActionId = afterFirst?.state?.approvalActionId;
    assert(afterFirst?.status === "approval_pending", "The rule did not continue to its second governed action.");
    assert(secondActionId && secondActionId !== firstActionId, "The second approval action was not created.");
    actionIds.add(secondActionId);

    await approveOperationsAction({
      id: secondActionId,
      workspaceId,
      actorId: actorUserId,
      role: "admin",
      notes: "Local end-to-end verification",
      execute: true,
    });

    const [{ rows: finalRuns }, { rows: actions }, { rows: notifications }, { rows: steps }] = await Promise.all([
      pool.query("SELECT * FROM adaptive_workflow_runs WHERE id = $1", [workflowRun.id]),
      pool.query("SELECT id, status, approval_mode FROM operations_ai_actions WHERE id = ANY($1::uuid[]) ORDER BY created_at", [[...actionIds]]),
      pool.query("SELECT id, message FROM notifications WHERE workspace_id = $1 AND message LIKE $2 ORDER BY created_at", [workspaceId, `${marker}:%`]),
      pool.query("SELECT step_index, step_type, status FROM adaptive_workflow_step_runs WHERE workflow_run_id = $1 ORDER BY step_index", [workflowRun.id]),
    ]);
    assert(finalRuns[0]?.status === "completed", "The workflow did not reach its Finish step.");
    assert(actions.length === 2 && actions.every((action) => action.status === "executed"), "Both governed actions were not executed.");
    assert(actions.every((action) => action.approval_mode === "approval_required"), "Approval policy was not preserved.");
    assert(notifications.some((item) => item.message === `${marker}: first approved action`), "The first notification side effect is missing.");
    assert(notifications.some((item) => item.message === `${marker}: second approved action`), "The second notification side effect is missing.");
    assert(steps.filter((step) => step.step_type === "THEN").every((step) => step.status === "succeeded"), "The action audit trail is incomplete.");

    console.log(JSON.stringify({
      status: "ok",
      proof: [
        "event_stored",
        "event_queued",
        "worker_processed_workspace_queue",
        "rule_condition_matched",
        "first_approval_required_and_executed",
        "workflow_continued_after_approval",
        "second_approval_required_and_executed",
        "notifications_created",
        "workflow_finished",
        "step_audit_complete",
      ],
      actionsExecuted: actions.length,
      notificationsCreated: notifications.length,
      workflowStatus: finalRuns[0].status,
      cleanup: "automatic",
    }, null, 2));
  } finally {
    if (workspaceId) {
      try {
        const traceRuntimeIds = new Set(runtimeRunId ? [runtimeRunId] : []);
        if (workflowId) {
          const { rows: traceRuns } = await pool.query(
            "SELECT runtime_run_id, state FROM adaptive_workflow_runs WHERE workflow_definition_id = $1",
            [workflowId]
          );
          for (const traceRun of traceRuns) {
            if (traceRun.runtime_run_id) traceRuntimeIds.add(traceRun.runtime_run_id);
            if (traceRun.state?.approvalActionId) actionIds.add(traceRun.state.approvalActionId);
          }
        }
        const runtimeIds = [...traceRuntimeIds];
        const { rows: foundActions } = await pool.query(
          `SELECT id FROM operations_ai_actions
           WHERE workspace_id = $1
             AND (id = ANY($2::uuid[]) OR adaptive_runtime_run_id = ANY($3::uuid[]))`,
          [workspaceId, [...actionIds], runtimeIds]
        );
        for (const row of foundActions) actionIds.add(row.id);
        const ids = [...actionIds];

        await pool.query("DELETE FROM notifications WHERE workspace_id = $1 AND message LIKE $2", [workspaceId, `${marker}:%`]);
        await pool.query("DELETE FROM chat_messages WHERE fallback_text LIKE $1", [`%${marker}%`]);
        if (ids.length) {
          await pool.query("DELETE FROM adaptive_learning_signals WHERE action_id = ANY($1::uuid[]) OR runtime_run_id = ANY($2::uuid[]) OR event_id = $3", [ids, runtimeIds, eventId]);
          await deleteByActionIds("adaptive_intelligence_evaluations", ids);
          await deleteByActionIds("adaptive_universal_explanations", ids);
          await deleteByActionIds("adaptive_optimization_attributions", ids);
          await pool.query("DELETE FROM adaptive_predictions WHERE action_id = ANY($1::uuid[]) OR runtime_run_id = ANY($2::uuid[]) OR event_id = $3", [ids, runtimeIds, eventId]);
          await pool.query("DELETE FROM adaptive_capability_invocations WHERE workspace_id = $1 AND runtime_run_id = ANY($2::uuid[])", [workspaceId, runtimeIds]);
          await pool.query("DELETE FROM operations_ai_actions WHERE id = ANY($1::uuid[])", [ids]);
        }
        if (workflowId) {
          await pool.query("DELETE FROM adaptive_workflow_step_runs WHERE workflow_run_id IN (SELECT id FROM adaptive_workflow_runs WHERE workflow_definition_id = $1)", [workflowId]);
          await pool.query("DELETE FROM adaptive_workflow_runs WHERE workflow_definition_id = $1", [workflowId]);
        }
        if (runtimeIds.length) await pool.query("DELETE FROM adaptive_runtime_runs WHERE id = ANY($1::uuid[])", [runtimeIds]);
        if (queueId) await pool.query("DELETE FROM adaptive_event_queue WHERE id = $1", [queueId]);
        await pool.query("DELETE FROM workspace_events WHERE id = $1", [eventId]);
        if (workflowId) await pool.query("DELETE FROM adaptive_workflow_definitions WHERE id = $1", [workflowId]);
        if (workerId) await pool.query("DELETE FROM adaptive_worker_heartbeats WHERE worker_id = $1", [workerId]);
        await restoreProfiles(workspaceId, originalProfiles);
        await restoreSettings(workspaceId, originalSettings);
        if (originalAiAutoReply !== null) {
          await pool.query(
            "UPDATE workspace_ai_settings SET ai_auto_reply = $1 WHERE workspace_id = $2",
            [originalAiAutoReply, workspaceId]
          );
        }
      } catch (cleanupError) {
        console.error("[verify-smart-automations-e2e] cleanup failed:", cleanupError.message);
        process.exitCode = 1;
      }
    }
  }
}

main()
  .catch((error) => {
    console.error("[verify-smart-automations-e2e] failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
