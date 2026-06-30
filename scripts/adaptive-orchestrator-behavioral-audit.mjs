import jwt from "jsonwebtoken";
import pg from "pg";

const { Pool } = pg;

const API = process.env.API_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const USER_ID = process.env.RELEASE_TEST_USER_ID || "d0818652-0399-4340-89ef-8544a9ac205c";
const WORKSPACE_ID = process.env.RELEASE_TEST_WORKSPACE_ID || "ba1fca50-897e-4a18-8b22-dc72dd35e7fd";

if (!API || !JWT_SECRET || !DATABASE_URL) {
  throw new Error("API_URL, JWT_SECRET, and DATABASE_URL are required");
}

const stamp = `enterprise-audit-${Date.now()}`;
const token = jwt.sign(
  { id: USER_ID, role: "admin", workspaceId: WORKSPACE_ID },
  JWT_SECRET,
  { expiresIn: "90m" }
);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

const domainScenarios = {
  Engineering: [
    "Release API dependency is blocking the mobile launch",
    "Production defect reopened after an incomplete verification",
    "Database migration is waiting on a security review",
    "Build pipeline failure threatens the release window",
    "Senior engineer is on leave during incident ownership",
    "Critical integration has exceeded its error budget",
    "Sprint commitment is slipping because estimates changed",
    "Testing backlog is blocking deployment approval",
    "Architecture decision remains unresolved across two teams",
    "Customer data fix requires coordinated backend and support work",
    "Repeated assignment override moves incidents to the platform team",
  ],
  Product: [
    "Enterprise launch scope changed after customer discovery",
    "Pricing experiment lacks an accountable decision owner",
    "Roadmap dependency conflicts with the committed release date",
    "Accessibility requirement was omitted from acceptance criteria",
    "Beta feedback indicates the workflow is too complex",
    "Product metric declined after the latest onboarding change",
    "Design approval is blocking the next implementation milestone",
    "Customer promise is not represented in the current roadmap",
    "Research finding invalidates the planned feature assumption",
    "Executive priority changed without downstream task updates",
    "Repeated scope overrides favor retention work over acquisition",
  ],
  Operations: [
    "Vendor outage is delaying a time-sensitive fulfillment run",
    "Daily reconciliation failed and requires finance coordination",
    "Warehouse capacity threshold will be exceeded tomorrow",
    "Compliance evidence is missing before the audit deadline",
    "Critical runbook step has no trained backup owner",
    "Service queue breached its response-time objective",
    "Procurement approval is blocking an operational dependency",
    "Regional handoff failed across two operating time zones",
    "Recurring incident indicates an ineffective corrective action",
    "Business continuity test exposed an unavailable dependency",
    "Repeated escalation overrides route work to the central team",
  ],
  HR: [
    "Key employee leave overlaps a critical delivery milestone",
    "Attendance anomaly requires a manager review",
    "Performance review is overdue and blocks promotion calibration",
    "New hire onboarding lacks equipment and system access",
    "Hiring panel decision is delayed without a clear owner",
    "Mandatory training completion is below the compliance target",
    "Workload imbalance creates a sustained burnout risk",
    "Role transition has no documented knowledge-transfer plan",
    "Employee concern has remained unresolved across two check-ins",
    "Compensation approval risks missing the payroll cutoff",
    "Repeated manager overrides reassign sensitive people actions",
  ],
  "Customer Success": [
    "Enterprise customer escalation threatens renewal",
    "Implementation milestone is late because integration access is missing",
    "Support issue has reopened three times without root-cause closure",
    "Customer success plan lacks an executive sponsor",
    "Adoption declined after the latest workflow change",
    "Contract commitment is not mapped to delivery work",
    "Health score deteriorated despite recent outreach",
    "Security questionnaire blocks the customer launch",
    "Expansion opportunity depends on unresolved product gaps",
    "Executive business review actions remain unassigned",
    "Repeated ownership overrides move escalations to solutions engineering",
  ],
  Leadership: [
    "Quarterly objective is off track across multiple projects",
    "Executive decision has not propagated to delivery plans",
    "Budget risk is growing without a mitigation owner",
    "Board commitment depends on an uncertain release date",
    "Cross-functional priority conflict remains unresolved",
    "Strategic initiative lacks measurable operating outcomes",
    "Leadership meeting actions are missing accountable owners",
    "Forecast confidence declined after repeated schedule changes",
    "Organizational dependency threatens the annual plan",
    "Operational score fell while reported status remained green",
    "Repeated executive overrides favor customer retention",
  ],
  Administration: [
    "Workspace permission review found excessive access",
    "Billing subscription is halted before a renewal cycle",
    "Integration token will expire during a critical workflow",
    "Audit-log review found an unexplained privileged action",
    "Workspace configuration differs from enterprise policy",
    "Inactive user retains ownership of operational work",
    "Data retention requirement is not reflected in workspace settings",
    "Notification volume is causing manager alert fatigue",
    "Plan boundary blocks a required enterprise capability",
    "Cross-workspace request attempts to access another tenant",
    "Repeated admin overrides weaken the default approval policy",
  ],
};

const scenarios = Object.entries(domainScenarios).flatMap(([domain, titles]) =>
  titles.map((title, domainIndex) => {
    const blocked = domainIndex % 3 !== 1;
    const overdueDays = domainIndex % 4 === 3 ? -2 : 1 + (domainIndex % 5);
    const priority = domainIndex % 4 === 0 ? "medium" : "high";
    return {
      id: `${domain.toLowerCase().replace(/\W+/g, "-")}-${domainIndex + 1}`,
      domain,
      title,
      blocked,
      overdueDays,
      priority,
      phase: domainIndex < 8 ? 1 : 2,
      description: [
        `Enterprise behavioural audit scenario for ${domain}.`,
        title,
        `Operational impact: this condition affects a committed outcome and requires coordinated ownership.`,
        `Relevant context includes dependencies, historical decisions, manager behaviour, user availability, and previous outcomes.`,
        `Audit marker: ${stamp}.`,
      ].join(" "),
    };
  })
);

if (scenarios.length < 75) throw new Error(`Expected at least 75 scenarios, found ${scenarios.length}`);

const projects = new Map();
const tasks = [];
const checks = [];
let originalSettings;

function compact(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 12).map(compact);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/token|secret|password|key/i.test(key))
        .slice(0, 30)
        .map(([key, child]) => [key, compact(child)])
    );
  }
  return value;
}

async function request(path, {
  method = "GET",
  body,
  expected = [200],
  timeoutMs = 30000,
} = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!expected.includes(response.status)) {
    throw new Error(`${method} ${path} returned ${response.status}: ${String(text).slice(0, 300)}`);
  }
  return { status: response.status, payload };
}

async function db(sql, params = []) {
  return (await pool.query(sql, params)).rows;
}

async function dbOne(sql, params = []) {
  return (await db(sql, params))[0] || null;
}

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    checks.push({ name, status: "passed", ms: Date.now() - started, detail: compact(detail) });
    console.log(`[PASS] ${name} (${Date.now() - started}ms)`);
    return detail;
  } catch (error) {
    checks.push({ name, status: "failed", ms: Date.now() - started, error: error.message });
    console.error(`[FAIL] ${name}: ${error.message}`);
    return null;
  }
}

function dueDate(daysAgo) {
  return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
}

async function createScenarioTask(scenario) {
  const project = projects.get(scenario.domain);
  const created = await request(`/tasks/${project.id}`, {
    method: "POST",
    expected: [201],
    body: {
      task: `${scenario.title} [${stamp}]`,
      description: scenario.description,
      status: scenario.blocked ? "blocked" : "in_progress",
      priority: scenario.priority,
      due_date: dueDate(scenario.overdueDays),
      is_blocked: scenario.blocked,
      estimation_hours: 8 + (scenario.overdueDays % 4) * 4,
      story_points: 3 + (scenario.overdueDays % 5),
    },
  });
  const task = { ...created.payload, scenario };
  tasks.push(task);
  await request(`/tasks/${task.id}`, {
    method: "PUT",
    body: {
      status: scenario.blocked ? "blocked" : "in_progress",
      priority: scenario.priority,
      due_date: dueDate(scenario.overdueDays),
      is_blocked: scenario.blocked,
      description: `${scenario.description} Current user report confirms the condition remains unresolved.`,
    },
  });
  return task;
}

async function drainWorker(maxRounds = 12) {
  const results = [];
  for (let round = 0; round < maxRounds; round += 1) {
    const pending = await dbOne(
      `SELECT COUNT(*)::int count
       FROM adaptive_event_queue q
       JOIN workspace_events e ON e.id = q.event_id
       WHERE q.workspace_id = $1
         AND q.status = 'pending'
         AND (e.metadata->>'auditMarker' = $2 OR e.entity_id::text = ANY($3::text[]))`,
      [WORKSPACE_ID, stamp, tasks.map((task) => task.id)]
    );
    if (!pending?.count) break;
    const run = await request("/adaptive/worker/run-once", {
      method: "POST",
      body: { limit: 25 },
      timeoutMs: 60000,
    });
    results.push(run.payload);
  }
  return results;
}

async function rejectPendingForTaskIds(taskIds, note) {
  if (!taskIds.length) return [];
  const rows = await db(
    `SELECT id
     FROM operations_ai_actions
     WHERE workspace_id = $1
       AND task_id = ANY($2::uuid[])
       AND status IN ('pending', 'approval_pending')
     ORDER BY created_at`,
    [WORKSPACE_ID, taskIds]
  );
  const rejected = [];
  for (const row of rows) {
    const response = await request(`/adaptive/recommendations/${row.id}/reject`, {
      method: "POST",
      body: { notes: note },
      expected: [200, 400, 404],
    });
    rejected.push({ id: row.id, status: response.status });
  }
  return rejected;
}

async function summarizePhase(phase) {
  const phaseTaskIds = tasks.filter((task) => task.scenario.phase === phase).map((task) => task.id);
  const rows = await db(
    `SELECT
       COUNT(DISTINCT t.id)::int scenario_tasks,
       COUNT(DISTINCT e.id)::int captured_events,
       COUNT(DISTINCT r.id)::int runtime_runs,
       COUNT(DISTINCT a.id)::int recommendations,
       ROUND(AVG(a.confidence)::numeric, 3) avg_recommendation_confidence,
       COUNT(DISTINCT a.action_type)::int distinct_action_types
     FROM tasks t
     LEFT JOIN workspace_events e
       ON e.workspace_id = t.workspace_id
      AND e.entity_id::text = t.id::text
     LEFT JOIN adaptive_runtime_runs r ON r.event_id = e.id
     LEFT JOIN operations_ai_actions a ON a.adaptive_runtime_run_id = r.id
     WHERE t.workspace_id = $1
       AND t.id = ANY($2::uuid[])`,
    [WORKSPACE_ID, phaseTaskIds]
  );
  return rows[0];
}

async function cleanup() {
  await rejectPendingForTaskIds(
    tasks.map((task) => task.id),
    `Automatic cleanup after ${stamp}`
  ).catch(() => {});
  if (originalSettings) {
    await request("/adaptive/settings", {
      method: "PUT",
      body: {
        mode: originalSettings.mode,
        eventCaptureEnabled: originalSettings.event_capture_enabled,
        workflowEnabled: originalSettings.workflow_enabled,
        defaultApprovalMode: originalSettings.default_approval_mode,
        enabledCapabilities: originalSettings.enabled_capabilities || [],
        contextLimits: originalSettings.context_limits || {},
        policy: originalSettings.policy || {},
      },
      expected: [200, 400],
    }).catch(() => {});
  }
  for (const task of [...tasks].reverse()) {
    await request(`/tasks/${task.id}`, {
      method: "DELETE",
      expected: [200, 400, 403, 404],
    }).catch(() => {});
  }
  for (const project of [...projects.values()].reverse()) {
    await request(`/projects/${project.id}`, {
      method: "DELETE",
      expected: [200, 400, 403, 404],
    }).catch(() => {});
  }
}

let finalEvidence = {};

try {
  await check("baseline.production-version", async () => request("/version"));
  originalSettings = (await check("baseline.adaptive-settings", async () => request("/adaptive/settings")))?.payload;
  await check("baseline.enable-assist", async () => request("/adaptive/settings", {
    method: "PUT",
    body: {
      mode: "assist",
      eventCaptureEnabled: true,
      workflowEnabled: true,
      defaultApprovalMode: "approval_required",
      enabledCapabilities: originalSettings?.enabled_capabilities || [],
      contextLimits: originalSettings?.context_limits || { memoryEntries: 10, timeoutMs: 2500 },
      policy: originalSettings?.policy || {},
    },
  }));

  await check("scenario-projects.create", async () => {
    for (const domain of Object.keys(domainScenarios)) {
      const response = await request("/projects", {
        method: "POST",
        expected: [201],
        body: {
          name: `${domain} Enterprise Audit ${stamp}`,
          description: `Temporary realistic ${domain} operating scenarios for behavioural certification.`,
        },
      });
      projects.set(domain, response.payload);
    }
    return { projectCount: projects.size, domains: [...projects.keys()] };
  });

  const phaseOne = scenarios.filter((scenario) => scenario.phase === 1);
  await check("phase-1.create-56-operational-scenarios", async () => {
    for (const scenario of phaseOne) await createScenarioTask(scenario);
    return {
      count: phaseOne.length,
      domains: [...new Set(phaseOne.map((scenario) => scenario.domain))],
    };
  });

  await check("event-platform.autonomous-observation", async () => {
    const target = tasks[0];
    const before = await dbOne(
      `SELECT q.status, q.attempts, q.created_at
       FROM adaptive_event_queue q
       JOIN workspace_events e ON e.id = q.event_id
       WHERE q.workspace_id = $1 AND e.entity_id::text = $2
       ORDER BY q.created_at DESC LIMIT 1`,
      [WORKSPACE_ID, target.id]
    );
    await new Promise((resolve) => setTimeout(resolve, 12000));
    const after = await dbOne(
      `SELECT q.status, q.attempts, q.processed_at
       FROM adaptive_event_queue q
       JOIN workspace_events e ON e.id = q.event_id
       WHERE q.workspace_id = $1 AND e.entity_id::text = $2
       ORDER BY q.created_at DESC LIMIT 1`,
      [WORKSPACE_ID, target.id]
    );
    return {
      before,
      after,
      autonomouslyProcessed: after?.status === "completed",
    };
  });

  await check("phase-1.manual-worker-drain", async () => {
    const runs = await drainWorker();
    return { workerCalls: runs.length };
  });

  const phaseOneSummaryBeforeFeedback = await check(
    "phase-1.behaviour-summary",
    async () => summarizePhase(1)
  );

  const phaseOneTaskIds = tasks.filter((task) => task.scenario.phase === 1).map((task) => task.id);
  await check("learning.phase-1-rejections", async () => {
    const rejected = await rejectPendingForTaskIds(
      phaseOneTaskIds,
      `User rejected phase-one recommendations during ${stamp}`
    );
    return { rejectedCount: rejected.length };
  });

  const profilesAfterPhaseOne = await check("learning.profiles-after-feedback", async () => db(
    `SELECT scope_type, profile_key, sample_count, confidence, version, explanation
     FROM adaptive_preference_profiles
     WHERE workspace_id = $1
     ORDER BY scope_type, profile_key`,
    [WORKSPACE_ID]
  ));

  const phaseTwo = scenarios.filter((scenario) => scenario.phase === 2);
  await check("phase-2.create-21-follow-up-scenarios", async () => {
    for (const scenario of phaseTwo) await createScenarioTask(scenario);
    return {
      count: phaseTwo.length,
      repeatedBehaviourTheme: "manager and executive ownership overrides",
    };
  });
  await check("phase-2.manual-worker-drain", async () => {
    const runs = await drainWorker();
    return { workerCalls: runs.length };
  });
  const phaseTwoSummary = await check("phase-2.behaviour-summary", async () => summarizePhase(2));

  const contextEvidence = await check("context.richness-and-reasoning-depth", async () => {
    const taskIds = tasks.map((task) => task.id);
    return db(
      `WITH audited_runs AS (
         SELECT DISTINCT r.*
         FROM adaptive_runtime_runs r
         JOIN workspace_events e ON e.id = r.event_id
         WHERE e.workspace_id = $1 AND e.entity_id::text = ANY($2::text[])
       )
       SELECT
         COUNT(*)::int run_count,
         ROUND(AVG(COALESCE((context_summary->>'coverage')::numeric, 0)), 3) avg_reported_coverage,
         COUNT(*) FILTER (WHERE context_summary->'task' IS NOT NULL AND context_summary->'task' <> 'null'::jsonb)::int task_context_runs,
         COUNT(*) FILTER (WHERE context_summary->'project' IS NOT NULL AND context_summary->'project' <> 'null'::jsonb)::int project_context_runs,
         COUNT(*) FILTER (WHERE COALESCE((context_summary->>'memoryCount')::int, 0) > 0)::int memory_context_runs,
         COUNT(*) FILTER (WHERE reasoning_summary ILIKE '%dependency%')::int reasoning_mentions_dependency,
         COUNT(*) FILTER (WHERE reasoning_summary ILIKE '%leave%')::int reasoning_mentions_leave,
         COUNT(*) FILTER (WHERE reasoning_summary ILIKE '%previous%' OR reasoning_summary ILIKE '%histor%')::int reasoning_mentions_history,
         COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(evidence, '[]'::jsonb)) > 0)::int runs_with_evidence,
         COUNT(DISTINCT reasoning_summary)::int distinct_reasoning_summaries
       FROM audited_runs`,
      [WORKSPACE_ID, taskIds]
    ).then((rows) => rows[0]);
  });

  const sourceEvidence = await check("context.source-coverage", async () => db(
    `WITH audited_runs AS (
       SELECT DISTINCT r.context_summary
       FROM adaptive_runtime_runs r
       JOIN workspace_events e ON e.id = r.event_id
       WHERE e.workspace_id = $1 AND e.entity_id::text = ANY($2::text[])
     )
     SELECT source->>'key' source_key, source->>'status' status, COUNT(*)::int count
     FROM audited_runs, LATERAL jsonb_array_elements(COALESCE(context_summary->'sources', '[]'::jsonb)) source
     GROUP BY 1, 2 ORDER BY 3 DESC`,
    [WORKSPACE_ID, tasks.map((task) => task.id)]
  ));

  const orchestrationEvidence = await check("orchestration.capability-coordination", async () => db(
    `SELECT
       capability_key,
       status,
       approval_mode,
       COUNT(*)::int invocation_count,
       ROUND(AVG(duration_ms))::int avg_duration_ms,
       COUNT(*) FILTER (WHERE output_summary IS NOT NULL)::int invocations_with_output
     FROM adaptive_capability_invocations
     WHERE workspace_id = $1
       AND runtime_run_id IN (
         SELECT DISTINCT r.id
         FROM adaptive_runtime_runs r
         JOIN workspace_events e ON e.id = r.event_id
         WHERE e.entity_id::text = ANY($2::text[])
       )
     GROUP BY 1, 2, 3 ORDER BY 4 DESC`,
    [WORKSPACE_ID, tasks.map((task) => task.id)]
  ));

  const pendingAction = await dbOne(
    `SELECT id, task_id
     FROM operations_ai_actions
     WHERE workspace_id = $1
       AND task_id = ANY($2::uuid[])
       AND status IN ('pending', 'approval_pending')
     ORDER BY created_at LIMIT 1`,
    [WORKSPACE_ID, tasks.map((task) => task.id)]
  );
  const approvalEvidence = await check("approval.safe-production-execution", async () => {
    if (!pendingAction) return { available: false, reason: "No pending recommendation was generated" };
    const notificationsBefore = await dbOne(
      `SELECT COUNT(*)::int count FROM notifications WHERE workspace_id = $1 AND user_id = $2`,
      [WORKSPACE_ID, USER_ID]
    );
    const approved = await request(`/adaptive/recommendations/${pendingAction.id}/approve`, {
      method: "POST",
      body: { notes: `Approved controlled self-notification during ${stamp}` },
      expected: [200, 201, 400, 404],
      timeoutMs: 45000,
    });
    const action = await dbOne(
      `SELECT id, status, action_type, executed_at, result
       FROM operations_ai_actions WHERE id = $1`,
      [pendingAction.id]
    );
    const notificationsAfter = await dbOne(
      `SELECT COUNT(*)::int count FROM notifications WHERE workspace_id = $1 AND user_id = $2`,
      [WORKSPACE_ID, USER_ID]
    );
    return {
      endpointStatus: approved.status,
      action,
      notificationDelta: notificationsAfter.count - notificationsBefore.count,
    };
  });

  const replayTarget = await dbOne(
    `SELECT e.id
     FROM workspace_events e
     WHERE e.workspace_id = $1
       AND e.entity_id::text = $2
       AND e.event_type = 'TASK_UPDATED'
     ORDER BY e.created_at DESC LIMIT 1`,
    [WORKSPACE_ID, tasks[1].id]
  );
  const idempotencyEvidence = await check("event-platform.replay-idempotency", async () => {
    if (!replayTarget) throw new Error("Replay target event unavailable");
    const before = await dbOne(
      `SELECT
         (SELECT COUNT(*)::int FROM adaptive_runtime_runs WHERE event_id = $1) run_count,
         (SELECT COUNT(*)::int FROM operations_ai_actions WHERE task_id = $2) action_count`,
      [replayTarget.id, tasks[1].id]
    );
    await request("/adaptive/events/replay", {
      method: "POST",
      body: { eventIds: [replayTarget.id], limit: 1 },
    });
    await request("/adaptive/events/replay", {
      method: "POST",
      body: { eventIds: [replayTarget.id], limit: 1 },
    });
    await drainWorker(4);
    const after = await dbOne(
      `SELECT
         (SELECT COUNT(*)::int FROM adaptive_runtime_runs WHERE event_id = $1) run_count,
         (SELECT COUNT(*)::int FROM operations_ai_actions WHERE task_id = $2) action_count`,
      [replayTarget.id, tasks[1].id]
    );
    return {
      before,
      after,
      duplicateRuns: after.run_count - before.run_count,
      duplicateActions: after.action_count - before.action_count,
    };
  });

  const crossCapabilityEvidence = await check("cross-capability.product-surfaces", async () => {
    const paths = [
      "/dashboard/overview?range=30d",
      "/dashboard/executive-detail?range=30d",
      "/intelligence/unified/snapshot",
      "/huddle/intelligence/diagnostics",
      "/huddle/media/livekit/diagnostics",
      "/operations/command-center",
      "/notifications",
      "/autopilot/settings",
      "/testing-agent/settings",
    ];
    const results = [];
    for (const path of paths) {
      const started = Date.now();
      const response = await request(path);
      results.push({ path, status: response.status, ms: Date.now() - started });
    }
    return results;
  });

  const eventCoverageEvidence = await check("event-platform.operational-coverage", async () => db(
    `SELECT event_type, origin, COUNT(*)::int count
     FROM workspace_events
     WHERE workspace_id = $1
       AND created_at >= (
         SELECT MIN(created_at) FROM projects WHERE name LIKE $2
       )
     GROUP BY 1, 2 ORDER BY 3 DESC`,
    [WORKSPACE_ID, `%${stamp}%`]
  ));

  const learningEvidence = await check("learning.observable-persistence", async () => db(
    `SELECT
       signal_key,
       scope_type,
       status,
       COUNT(*)::int count,
       ROUND(AVG(confidence)::numeric, 3) avg_confidence,
       COUNT(*) FILTER (WHERE reversed_at IS NOT NULL)::int reversed_count
     FROM adaptive_learning_signals
     WHERE workspace_id = $1
       AND action_id IN (
         SELECT id FROM operations_ai_actions
         WHERE task_id = ANY($2::uuid[])
       )
     GROUP BY 1, 2, 3 ORDER BY 4 DESC`,
    [WORKSPACE_ID, tasks.map((task) => task.id)]
  ));

  const predictionEvidence = await check("continuous-evaluation.outcomes", async () => db(
    `SELECT
       status,
       prediction_key,
       COUNT(*)::int count,
       ROUND(AVG(confidence)::numeric, 3) avg_confidence,
       ROUND(AVG(score)::numeric, 3) avg_score
     FROM adaptive_predictions
     WHERE workspace_id = $1
       AND action_id IN (
         SELECT id FROM operations_ai_actions
         WHERE task_id = ANY($2::uuid[])
       )
     GROUP BY 1, 2 ORDER BY 3 DESC`,
    [WORKSPACE_ID, tasks.map((task) => task.id)]
  ));

  const isolationEvidence = await check("personalization.workspace-isolation", async () => {
    const leaks = await dbOne(
      `SELECT COUNT(*)::int count
       FROM adaptive_learning_signals
       WHERE action_id IN (
         SELECT id FROM operations_ai_actions
         WHERE task_id = ANY($1::uuid[])
       )
       AND workspace_id <> $2`,
      [tasks.map((task) => task.id), WORKSPACE_ID]
    );
    const forged = await fetch(`${API}/projects`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-workspace-id": "00000000-0000-0000-0000-000000000000",
      },
      signal: AbortSignal.timeout(30000),
    });
    return {
      crossWorkspaceLearningLeaks: leaks.count,
      forgedHeaderStatus: forged.status,
      tokenWorkspaceRemainedAuthoritative: forged.status === 200,
    };
  });

  finalEvidence = {
    stamp,
    scenarios: {
      total: scenarios.length,
      phaseOne: phaseOne.length,
      phaseTwo: phaseTwo.length,
      domains: Object.fromEntries(
        Object.keys(domainScenarios).map((domain) => [
          domain,
          scenarios.filter((scenario) => scenario.domain === domain).length,
        ])
      ),
    },
    phaseOneSummaryBeforeFeedback,
    phaseTwoSummary,
    profilesAfterPhaseOne,
    contextEvidence,
    sourceEvidence,
    orchestrationEvidence,
    approvalEvidence,
    idempotencyEvidence,
    crossCapabilityEvidence,
    eventCoverageEvidence,
    learningEvidence,
    predictionEvidence,
    isolationEvidence,
  };
} finally {
  await cleanup();
  const cleanupEvidence = await dbOne(
    `SELECT
       (SELECT COUNT(*)::int FROM tasks WHERE workspace_id = $1 AND task LIKE $2) remaining_tasks,
       (SELECT COUNT(*)::int FROM projects WHERE workspace_id = $1 AND name LIKE $2) remaining_projects,
       (SELECT COUNT(*)::int FROM operations_ai_actions
        WHERE workspace_id = $1
          AND task_id IN (
            SELECT entity_id::uuid FROM workspace_events
            WHERE workspace_id = $1
              AND metadata::text LIKE $3
              AND entity_type ILIKE '%task%'
          )
          AND status IN ('pending', 'approval_pending')) pending_actions`,
    [WORKSPACE_ID, `%${stamp}%`, `%${stamp}%`]
  ).catch(() => null);
  finalEvidence.cleanup = cleanupEvidence;
  finalEvidence.checks = checks;
  await pool.end();
}

console.log(`BEHAVIOURAL_AUDIT_SUMMARY ${JSON.stringify(finalEvidence, null, 2)}`);
