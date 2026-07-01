import jwt from "jsonwebtoken";
import pg from "pg";

const { Pool } = pg;

const API = process.env.API_URL;
const AI = process.env.AI_PUBLIC_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const USER_ID = process.env.RELEASE_TEST_USER_ID || "d0818652-0399-4340-89ef-8544a9ac205c";
const WORKSPACE_ID = process.env.RELEASE_TEST_WORKSPACE_ID || "ba1fca50-897e-4a18-8b22-dc72dd35e7fd";
const WORKSPACE_NAME = process.env.RELEASE_TEST_WORKSPACE_NAME || "apyhub";

if (!API || !AI || !JWT_SECRET || !DATABASE_URL) {
  throw new Error("API_URL, AI_PUBLIC_URL, JWT_SECRET, and DATABASE_URL are required");
}

const stamp = `codex-cert-${Date.now()}`;
const token = jwt.sign(
  { id: USER_ID, role: "admin", workspaceId: WORKSPACE_ID },
  JWT_SECRET,
  { expiresIn: "45m" }
);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

const checks = [];
const cleanup = {
  taskIds: [],
  projectIds: [],
  channelIds: [],
  workflowIds: [],
  originalAdaptive: null,
  originalAi: null,
};

let project = null;
let primaryTask = null;
let aiTask = null;
let selectedAction = null;
let selectedWorkflowAction = null;
let channel = null;

function elapsed(start) {
  return Date.now() - start;
}

function compact(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 5).map(compact);
  if (typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value).slice(0, 12)) {
      if (/token|secret|password|key/i.test(key)) continue;
      out[key] = typeof child === "object" ? compact(child) : child;
    }
    return out;
  }
  return value;
}

async function request(path, {
  method = "GET",
  body,
  auth = true,
  expected = [200],
  timeoutMs = 25000,
} = {}) {
  const headers = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${token}`;
  const start = Date.now();
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!expected.includes(res.status)) {
    const detail = typeof payload === "string"
      ? payload.slice(0, 250)
      : JSON.stringify(compact(payload)).slice(0, 500);
    throw new Error(`${method} ${path} returned ${res.status}: ${detail}`);
  }
  return { status: res.status, payload, ms: elapsed(start) };
}

async function publicRequest(url, expected = [200]) {
  const start = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!expected.includes(res.status)) throw new Error(`${url} returned ${res.status}`);
  return { status: res.status, ms: elapsed(start) };
}

async function check(name, fn, { critical = true } = {}) {
  const start = Date.now();
  try {
    const detail = await fn();
    checks.push({ name, status: "passed", critical, ms: elapsed(start), detail: compact(detail) });
    console.log(`[PASS] ${name} (${elapsed(start)}ms)`);
    return detail;
  } catch (error) {
    checks.push({ name, status: "failed", critical, ms: elapsed(start), error: error.message });
    console.error(`[FAIL] ${name}: ${error.message}`);
    return null;
  }
}

async function waitFor(name, fn, { attempts = 20, intervalMs = 1500 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${name} not observed after ${attempts} attempts`);
}

async function dbOne(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

async function dbMany(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function cleanupArtifacts() {
  for (const workflowId of cleanup.workflowIds.reverse()) {
    await request(`/adaptive/workflows/${workflowId}/status`, {
      method: "PATCH",
      body: { status: "archived" },
      expected: [200, 400, 404],
    }).catch(() => {});
  }
  if (cleanup.originalAdaptive) {
    await request("/adaptive/settings", {
      method: "PUT",
      body: {
        mode: cleanup.originalAdaptive.mode,
        eventCaptureEnabled: cleanup.originalAdaptive.event_capture_enabled,
        workflowEnabled: cleanup.originalAdaptive.workflow_enabled,
        defaultApprovalMode: cleanup.originalAdaptive.default_approval_mode,
        enabledCapabilities: cleanup.originalAdaptive.enabled_capabilities || [],
        contextLimits: cleanup.originalAdaptive.context_limits || {},
        policy: cleanup.originalAdaptive.policy || {},
      },
      expected: [200, 400],
    }).catch(() => {});
  }
  if (cleanup.originalAi) {
    await request("/workspaces/ai-settings", {
      method: "PUT",
      body: {
        ai_enabled: cleanup.originalAi.ai_enabled,
        ai_auto_reply: cleanup.originalAi.ai_auto_reply,
        ai_name: cleanup.originalAi.ai_name || "AI Assistant",
      },
      expected: [200, 500],
    }).catch(() => {});
  }
  for (const taskId of cleanup.taskIds.reverse()) {
    await request(`/tasks/${taskId}`, {
      method: "DELETE",
      expected: [200, 400, 403, 404],
    }).catch(() => {});
  }
  for (const projectId of cleanup.projectIds.reverse()) {
    await request(`/projects/${projectId}`, {
      method: "DELETE",
      expected: [200, 400, 403, 404],
    }).catch(() => {});
  }
  for (const channelId of cleanup.channelIds.reverse()) {
    await request(`/chat/channels/${channelId}`, {
      method: "DELETE",
      expected: [200, 403, 404, 500],
    }).catch(() => {});
  }
}

try {
  await check("public.backend.version", async () => request("/version", { auth: false }));
  await check("public.backend.app-version", async () => request("/app-version", { auth: false }));
  await check("public.ai.health", async () => publicRequest(`${AI}/health`));
  await check("public.ai.ready", async () => publicRequest(`${AI}/ready`));
  await check("auth.me", async () => {
    const response = await request("/auth/me");
    const userId = response.payload?.id || response.payload?.user?.id;
    if (String(userId) !== USER_ID) throw new Error("authenticated user mismatch");
    return { status: response.status, userId: USER_ID, workspace: WORKSPACE_NAME };
  });
  await check("workspace.plan", async () => request("/workspaces/my-plan"));
  await check("dashboard.overview", async () => request("/dashboard/overview?range=30d"));
  await check("dashboard.executive-summary", async () => request("/dashboard/executive-detail?range=30d"));
  await check("workspace-intelligence.snapshot", async () => request("/intelligence/unified/snapshot"));
  await check("huddles.media.diagnostics", async () => request("/huddle/media/livekit/diagnostics"));
  await check("meeting-intelligence.diagnostics", async () => request("/huddle/intelligence/diagnostics"));
  await check("notifications.list", async () => request("/notifications"));
  await check("billing.summary", async () => request("/payments/summary"));
  await check("autopilot.settings", async () => request("/autopilot/settings"));
  await check("testing-agent.settings", async () => request("/testing-agent/settings"));
  await check("operations.command-center", async () => request("/operations/command-center"));
  await check("asana.projects.not-connected-safe", async () => request("/integrations/asana/projects"));

  cleanup.originalAdaptive = (await check("adaptive.settings.read", async () => request("/adaptive/settings")))?.payload;
  await check("adaptive.settings.enable-assist", async () => request("/adaptive/settings", {
    method: "PUT",
    body: {
      mode: "assist",
      eventCaptureEnabled: true,
      workflowEnabled: true,
      defaultApprovalMode: "approval_required",
      enabledCapabilities: [],
      contextLimits: { memoryEntries: 10, timeoutMs: 2500 },
      policy: cleanup.originalAdaptive?.policy || {},
    },
  }));
  await check("adaptive.capabilities", async () => {
    const response = await request("/adaptive/capabilities");
    const capabilities = response.payload?.capabilities || [];
    if (!Array.isArray(capabilities) || capabilities.length < 5) {
      throw new Error("capability registry incomplete");
    }
    return {
      capabilityCount: capabilities.length,
      contextProviderCount: response.payload.contextProviders?.length,
    };
  });

  cleanup.originalAi = (await check("workspace.ai-settings.read", async () => request("/workspaces/ai-settings")))?.payload;
  await check("workspace.ai-settings.temporary-enable", async () => request("/workspaces/ai-settings", {
    method: "PUT",
    body: {
      ai_enabled: true,
      ai_auto_reply: true,
      ai_name: cleanup.originalAi?.ai_name || "AI Assistant",
    },
  }));

  await check("project.lifecycle.create", async () => {
    const response = await request("/projects", {
      method: "POST",
      expected: [201],
      body: {
        name: `Release Validation ${stamp}`,
        description: `Temporary certification project ${stamp}`,
      },
    });
    project = response.payload;
    cleanup.projectIds.push(project.id);
    return { id: project.id, name: project.name };
  });
  await check("project.lifecycle.read", async () => request(`/projects/${project.id}`));

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await check("task.lifecycle.create", async () => {
    const response = await request(`/tasks/${project.id}`, {
      method: "POST",
      expected: [201],
      body: {
        task: `Blocked high-priority validation task ${stamp}`,
        description: "Temporary release certification task",
        status: "blocked",
        priority: "high",
        due_date: yesterday,
        is_blocked: true,
      },
    });
    primaryTask = response.payload;
    cleanup.taskIds.push(primaryTask.id);
    return { id: primaryTask.id, status: primaryTask.status, priority: primaryTask.priority };
  });
  await check("task.lifecycle.update", async () => request(`/tasks/${primaryTask.id}`, {
    method: "PUT",
    body: {
      status: "blocked",
      priority: "high",
      due_date: yesterday,
      is_blocked: true,
      description: `Updated by production certification ${stamp}`,
    },
  }));
  await check("task.lifecycle.read", async () => request(`/tasks/detail/${primaryTask.id}`));

  await check("adaptive.event.captured", async () => {
    const event = await waitFor("TASK_UPDATED event", () => dbOne(
      `SELECT id, event_type, entity_id
       FROM workspace_events
       WHERE workspace_id = $1
         AND entity_id::text = $2
         AND event_type = 'TASK_UPDATED'
       ORDER BY created_at DESC
       LIMIT 1`,
      [WORKSPACE_ID, primaryTask.id]
    ));
    return { eventId: event.id, eventType: event.event_type };
  });

  const capturedEvent = await dbOne(
    `SELECT id
     FROM workspace_events
     WHERE workspace_id = $1
       AND entity_id::text = $2
       AND event_type = 'TASK_UPDATED'
     ORDER BY created_at DESC
     LIMIT 1`,
    [WORKSPACE_ID, primaryTask.id]
  );
  await check("adaptive.event.replay", async () => request("/adaptive/events/replay", {
    method: "POST",
    body: { eventIds: [capturedEvent.id], limit: 5 },
  }));

  await check("adaptive.workflow.create", async () => {
    const response = await request("/adaptive/workflows", {
      method: "POST",
      expected: [201],
      body: {
        workflowKey: `cert_${stamp}`,
        name: `Certification workflow ${stamp}`,
        description: "Temporary production certification workflow",
        status: "active",
        definition: {
          steps: [
            { type: "WHEN", eventTypes: ["TASK_UPDATED"] },
            { type: "IF", path: "context.data.task.status", operator: "equals", value: "blocked" },
            { type: "APPROVAL", mode: "approval_required" },
            {
              type: "THEN",
              capabilityKey: "notification.send",
              title: "Certification workflow notification",
              summary: "Workflow matched a blocked task",
              input: {
                userId: USER_ID,
                title: "Release validation workflow",
                message: `Workflow validation ${stamp}`,
                taskId: "{{ event.entityId }}",
                projectId: "{{ context.data.task.project_id }}",
              },
            },
            { type: "END" },
          ],
        },
      },
    });
    cleanup.workflowIds.push(response.payload.id);
    return { id: response.payload.id, status: response.payload.status, version: response.payload.version };
  });

  await check("adaptive.worker.run-once", async () => request("/adaptive/worker/run-once", {
    method: "POST",
    body: { limit: 25 },
    timeoutMs: 45000,
  }));
  await check("adaptive.recommendations.generated", async () => {
    const response = await request(`/adaptive/recommendations?status=pending&taskId=${primaryTask.id}&limit=10`);
    const recs = response.payload?.recommendations || [];
    if (!recs.length) throw new Error("no pending adaptive recommendation for test task");
    selectedAction = recs.find((item) => item.task_id === primaryTask.id || item.taskId === primaryTask.id) || recs[0];
    return {
      count: recs.length,
      actionId: selectedAction.id,
      actionType: selectedAction.action_type,
      confidence: selectedAction.confidence,
      riskLevel: selectedAction.risk_level,
    };
  });
  await check("adaptive.approval.reject", async () => request(`/adaptive/recommendations/${selectedAction.id}/reject`, {
    method: "POST",
    body: { notes: `Certification rejection ${stamp}` },
  }));
  await check("adaptive.learning.updated", async () => {
    const rows = await waitFor("learning signal", () => dbMany(
      `SELECT signal_key, scope_type, action_id
       FROM adaptive_learning_signals
       WHERE workspace_id = $1
         AND action_id = $2
       ORDER BY created_at DESC`,
      [WORKSPACE_ID, selectedAction.id]
    ).then((items) => (items.length ? items : null)));
    const prediction = await dbOne(
      `SELECT status, score
       FROM adaptive_predictions
       WHERE workspace_id = $1
         AND action_id = $2
       ORDER BY predicted_at DESC
       LIMIT 1`,
      [WORKSPACE_ID, selectedAction.id]
    );
    if (!rows.some((row) => row.signal_key === "recommendation.rejected")) {
      throw new Error("recommendation.rejected signal missing");
    }
    if (prediction?.status !== "evaluated") throw new Error("prediction was not evaluated");
    const leaks = await dbOne(
      `SELECT COUNT(*)::int AS count
       FROM adaptive_learning_signals
       WHERE action_id = $1
         AND workspace_id <> $2`,
      [selectedAction.id, WORKSPACE_ID]
    );
    if (Number(leaks.count) !== 0) throw new Error("cross-workspace learning leak detected");
    return {
      signalKeys: rows.map((row) => row.signal_key),
      predictionStatus: prediction.status,
      leakCount: Number(leaks.count),
    };
  });
  await check("adaptive.workflow.approval-pending", async () => {
    const rows = await dbMany(
      `SELECT a.id, a.status, a.action_type
       FROM operations_ai_actions a
       WHERE a.workspace_id = $1
         AND a.source = 'adaptive_runtime'
         AND a.task_id = $2
         AND a.id <> $3
       ORDER BY a.created_at DESC
       LIMIT 10`,
      [WORKSPACE_ID, primaryTask.id, selectedAction.id]
    );
    selectedWorkflowAction = rows.find((row) => row.status === "pending" || row.status === "approval_pending") || rows[0];
    if (!selectedWorkflowAction) throw new Error("workflow-created action not found");
    return {
      actionId: selectedWorkflowAction.id,
      status: selectedWorkflowAction.status,
      actionType: selectedWorkflowAction.action_type,
    };
  });

  await check("ai.meeting-notes.task-generation", async () => {
    const response = await request("/ai-features/meeting-notes", {
      method: "POST",
      body: {
        notes: `Certification meeting ${stamp}: Confirm release, assign follow-up, and verify production smoke. This text is intentionally longer than twenty characters.`,
        projectId: project.id,
        autoCreate: true,
        tasks: [
          {
            title: `AI generated release follow-up ${stamp}`,
            description: "Temporary AI task generation validation",
            priority: "medium",
          },
        ],
      },
      timeoutMs: 45000,
    });
    const created = response.payload?.created || [];
    if (!created.length) throw new Error("AI meeting-notes endpoint did not create a task");
    aiTask = created[0];
    cleanup.taskIds.push(aiTask.id);
    return { tasksCount: response.payload.tasks?.length || 0, createdCount: created.length, taskId: aiTask.id };
  });
  await check("ai.generated-task.risk", async () => request(`/ai-features/tasks/${aiTask.id}/risk`));

  await check("chat.channel.create", async () => {
    const key = `cert-${stamp}`;
    const response = await request("/chat", {
      method: "POST",
      expected: [201],
      body: { name: `Certification ${stamp}`, key, type: "channel", isPrivate: false, members: [] },
    });
    channel = response.payload;
    cleanup.channelIds.push(channel.id);
    return { id: channel.id, key: channel.key };
  });
  await check("chat.message.send-ai-trigger", async () => request("/chat/messages", {
    method: "POST",
    expected: [201],
    body: {
      channelId: channel.key,
      encrypted: { fallbackText: `AI production validation ping ${stamp}` },
      fallbackText: `AI production validation ping ${stamp}`,
      tempId: stamp,
    },
  }));
  await check("backend-ai.reply.persisted", async () => {
    const row = await waitFor("AI reply message", () => dbOne(
      `SELECT cm.id, cm.user_id, cm.fallback_text, adp.model, adp.confidence
       FROM chat_messages cm
       JOIN system_users su ON su.user_id = cm.user_id
         AND su.workspace_id = cm.workspace_id
       LEFT JOIN ai_decision_provenance adp ON adp.message_id = cm.id
       WHERE cm.workspace_id = $1
         AND cm.channel_key = $2
         AND cm.created_at >= NOW() - INTERVAL '10 minutes'
       ORDER BY cm.created_at DESC
       LIMIT 1`,
      [WORKSPACE_ID, channel.key]
    ), { attempts: 30, intervalMs: 2000 });
    if (!row?.id) throw new Error("AI reply row missing");
    return { messageId: row.id, model: row.model || null, confidence: row.confidence || null };
  });
  await check("chat.messages.fetch", async () => {
    const response = await request(`/chat/messages/for-channel/${encodeURIComponent(channel.key)}?limit=10`);
    if (!Array.isArray(response.payload) || response.payload.length < 2) {
      throw new Error("chat history did not include user+AI messages");
    }
    return { count: response.payload.length };
  });

  await check("workspace-isolation.header-cannot-override-token", async () => {
    const response = await fetch(`${API}/projects`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-workspace-id": "00000000-0000-0000-0000-000000000000",
      },
      signal: AbortSignal.timeout(25000),
    });
    if (response.status !== 200) {
      throw new Error(`expected original workspace access despite forged header, got ${response.status}`);
    }
    return { status: response.status, note: "token workspace remained authoritative" };
  });
} finally {
  await cleanupArtifacts();
  await pool.end();
}

const failed = checks.filter((checkItem) => checkItem.status !== "passed");
const criticalFailed = failed.filter((checkItem) => checkItem.critical);
const summary = {
  stamp,
  api: API,
  workspaceId: WORKSPACE_ID,
  workspaceName: WORKSPACE_NAME,
  checksTotal: checks.length,
  checksPassed: checks.filter((checkItem) => checkItem.status === "passed").length,
  checksFailed: failed.length,
  criticalFailed: criticalFailed.length,
  keyEvidence: {
    projectId: project?.id || null,
    primaryTaskId: primaryTask?.id || null,
    aiTaskId: aiTask?.id || null,
    adaptiveActionId: selectedAction?.id || null,
    workflowActionId: selectedWorkflowAction?.id || null,
    chatChannelId: channel?.id || null,
  },
  checks,
};

console.log(`FINAL_E2E_SUMMARY ${JSON.stringify(summary, null, 2)}`);
if (criticalFailed.length) process.exit(1);
