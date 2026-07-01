import jwt from "jsonwebtoken";
import pg from "pg";

const { Pool } = pg;

const API = process.env.API_URL || "http://localhost:5000";
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const apiUrl = new URL(API);
const databaseUrl = new URL(DATABASE_URL);
const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
if (!localHosts.has(apiUrl.hostname) || !localHosts.has(databaseUrl.hostname)) {
  throw new Error(`LOCAL_CERTIFICATION_SAFETY_BLOCKED api=${apiUrl.hostname} database=${databaseUrl.hostname}`);
}

let USER_ID = process.env.RELEASE_TEST_USER_ID || null;
let WORKSPACE_ID = process.env.RELEASE_TEST_WORKSPACE_ID || null;
let token = process.env.RELEASE_TEST_TOKEN || null;

if (!token && USER_ID && WORKSPACE_ID && JWT_SECRET) {
  token = jwt.sign(
    { id: USER_ID, role: "admin", workspaceId: WORKSPACE_ID },
    JWT_SECRET,
    { expiresIn: "3h" }
  );
}

if (!token) {
  const response = await fetch(`${API}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "enterprise-auditor@localhost.test",
      name: "Enterprise Certification Auditor",
      workspaceName: "Adaptive Orchestrator Local Certification V2",
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Local dev login failed: ${response.status} ${await response.text()}`);
  const session = await response.json();
  token = session.token;
  USER_ID = session.user?.id;
  WORKSPACE_ID = session.workspace?.id || session.user?.workspaceId;
}

if (!token || !USER_ID || !WORKSPACE_ID) throw new Error("Local audit identity could not be established");

const stamp = `enterprise-audit-${Date.now()}`;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: false,
  max: 10,
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
    "Security patch rollout conflicts with a contractual uptime window",
    "Mobile release is blocked by an unresolved API compatibility defect",
    "Observability gaps prevent incident responders from confirming recovery",
    "Shared platform capacity is exhausted by competing launch workloads",
    "AI service context contract changed before backend rollout approval",
    "Realtime huddle quality regression blocks customer-facing validation",
    "Adaptive runtime worker backlog threatens the daily operating review",
    "Database failover rehearsal exposes missing ownership for recovery tasks",
    "External integration webhook retries are creating duplicate engineering work",
    "Release branch protection exception requires security and QA sign-off",
    "Technical debt remediation conflicts with an enterprise pilot milestone",
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
    "Regulatory requirement changes the committed product acceptance criteria",
    "Two product teams claim ownership of the same customer workflow",
    "Experiment results require an immediate roadmap sequencing decision",
    "Localization launch depends on unresolved design-system coverage",
    "AI-generated task suggestions require product governance before rollout",
    "Self-serve onboarding promise is missing support readiness criteria",
    "Enterprise pilot feedback changes the workflow approval threshold",
    "Public launch narrative depends on unresolved reliability evidence",
    "Product analytics instrumentation is inconsistent across mobile and web",
    "Feature flag rollout lacks a rollback owner for customer cohorts",
    "User research indicates notification timing causes manager fatigue",
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
    "Month-end processing is at risk because an upstream data feed is late",
    "Regional support capacity is below the forecast incident demand",
    "A critical supplier has failed its service-level commitment twice",
    "Disaster-recovery ownership is ambiguous across infrastructure teams",
    "Operational command center has stale ownership for incident handoff",
    "Automated workflow approval is unsafe during a high-risk fulfillment window",
    "Business continuity evidence is spread across meetings and wiki pages",
    "Night-shift support handover omitted a critical customer escalation",
    "Regional compliance checklist conflicts with the global process template",
    "Internal service outage requires coordinated notification and follow-up",
    "Queue recovery needs validation before the next operating cycle",
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
    "A new manager inherited reviews without historical coaching context",
    "Workforce planning conflicts with the approved delivery portfolio",
    "Critical-role succession coverage is below the enterprise target",
    "Employee onboarding feedback exposes a repeated access-control delay",
    "Leave approval creates a capacity gap for customer escalation ownership",
    "Manager review edits repeatedly change recommendation timing",
    "Performance calibration needs evidence from projects and huddle outcomes",
    "New hire workspace permissions conflict with least-privilege policy",
    "People operations escalation requires a reversible learning signal",
    "Team transfer changes task ownership without updating project context",
    "Training non-compliance blocks enterprise audit readiness",
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
    "Renewal forecast changed after a customer leadership transition",
    "Implementation risk is rising across three dependent customer teams",
    "Customer data residency requirements conflict with the launch design",
    "Support sentiment indicates an emerging product reliability pattern",
    "Strategic customer asks for proof of AI-task generation governance",
    "Executive sponsor changed before open escalation actions were assigned",
    "Support runbook update has not propagated to active customer work",
    "Renewal-risk account needs a cross-functional approval workflow",
    "Customer success plan conflicts with product release sequencing",
    "Incident follow-up requires both task creation and executive context refresh",
    "Customer security review requires validated evidence from testing agent",
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
    "Portfolio funding no longer matches the declared strategic priorities",
    "Acquisition integration milestones have no cross-functional owner",
    "Forecast variance requires a board-level corrective narrative",
    "Enterprise risk appetite conflicts with the planned release approach",
    "Board update requires causal evidence for adaptive recommendation accuracy",
    "Operating cadence changed after repeated executive recommendation edits",
    "Workspace score improved but underlying customer risk remains unresolved",
    "Enterprise pilot gate requires proof of tenant-safe personalization",
    "Strategic dependency spans product, engineering, and customer success",
    "Leadership asks for one auditable plan across meeting outcomes and tasks",
    "Quarterly business review requires rollback-safe automation evidence",
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
    "Privileged access recertification is incomplete before the audit window",
    "Data-classification policy is not enforced by a connected integration",
    "Service-account ownership is missing for a business-critical connector",
    "Retention exceptions have accumulated without documented approvals",
    "Secret rotation runbook is incomplete for a newly deployed internal service",
    "Admin approval workflow needs proof of role-boundary enforcement",
    "Billing plan boundary changes require backward-compatible mobile behavior",
    "Superadmin audit trail must explain an adaptive runtime policy update",
    "Workspace isolation test attempts to reuse another tenant recommendation",
    "Notification preference migration risks breaking existing user settings",
    "Provider credential expiry requires preemptive operating-system alerting",
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

if (scenarios.length < 100) throw new Error(`Expected at least 100 scenarios, found ${scenarios.length}`);

const projects = new Map();
const tasks = [];
const checks = [];
const organizationUsers = [];
const seededIds = {
  leaveTypes: [], reviewCycles: [], objectives: [], wikiSpaces: [],
  memoryEntries: [], digestRuns: [], huddleSessions: [],
};
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

async function seedRealisticOrganization() {
  console.log("[SEED] people");
  const personas = [
    ["Aarav Mehta", "CEO", "Leadership", "admin"],
    ["Maya Rao", "CTO", "Engineering", "admin"],
    ["Kabir Shah", "COO", "Operations", "admin"],
    ["Isha Verma", "CFO", "Finance", "admin"],
    ["Neha Kapoor", "VP Product", "Product", "manager"],
    ["Rohan Gupta", "VP Customer Success", "Customer Success", "manager"],
    ["Anika Bose", "Engineering Manager", "Engineering", "manager"],
    ["Vikram Nair", "Product Manager", "Product", "manager"],
    ["Sara Khan", "Operations Manager", "Operations", "manager"],
    ["Diya Singh", "People Operations Manager", "HR", "manager"],
    ["Arjun Malhotra", "Finance Manager", "Finance", "manager"],
    ["Naina Joshi", "Sales Manager", "Sales", "manager"],
    ["Dev Patel", "Support Manager", "Support", "manager"],
    ["Tara Iyer", "Customer Success Manager", "Customer Success", "manager"],
    ["Sahil Jain", "Senior Backend Engineer", "Engineering", "user"],
    ["Meera Das", "Frontend Engineer", "Engineering", "user"],
    ["Omar Ali", "Mobile Engineer", "Engineering", "user"],
    ["Leena Roy", "Platform Engineer", "Engineering", "user"],
    ["Kunal Bhat", "QA Lead", "Quality", "user"],
    ["Riya Sen", "QA Engineer", "Quality", "user"],
    ["Aditya Kulkarni", "Product Designer", "Design", "user"],
    ["Pooja Menon", "UX Researcher", "Design", "user"],
    ["Farhan Sheikh", "Account Executive", "Sales", "user"],
    ["Simran Kaur", "Support Engineer", "Support", "user"],
  ];

  for (let index = 0; index < personas.length; index += 1) {
    const [name, title, department, role] = personas[index];
    const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}.${stamp}@localhost.test`;
    const user = await dbOne(
      `INSERT INTO users (username, email, role, workspace_id, added_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, username, email, role`,
      [`${name} — ${title} [${stamp}]`, email, role, WORKSPACE_ID, USER_ID]
    );
    await db(
      `INSERT INTO workspace_users (workspace_id, user_id, role, manager_id, billing_status, activated_at)
       VALUES ($1,$2,$3,$4,'active',NOW())`,
      [WORKSPACE_ID, user.id, role === "user" ? "member" : role, USER_ID]
    );
    organizationUsers.push({ ...user, name, title, department, role });
  }

  console.log("[SEED] leave-and-attendance");
  const leaveTypes = await db(
    `INSERT INTO leave_types (workspace_id, name, color, max_days)
     VALUES ($1,$2,'#6366f1',24),($1,$3,'#ef4444',12) RETURNING id`,
    [WORKSPACE_ID, `Annual Leave ${stamp}`, `Medical Leave ${stamp}`]
  );
  seededIds.leaveTypes.push(...leaveTypes.map((row) => row.id));
  for (const user of organizationUsers.slice(14, 18)) {
    await db(
      `INSERT INTO leave_requests
        (workspace_id,user_id,leave_type_id,start_date,end_date,days,reason,status,reviewed_by,reviewed_at)
       VALUES ($1,$2,$3,CURRENT_DATE,CURRENT_DATE + 2,3,$4,'approved',$5,NOW())`,
      [WORKSPACE_ID, user.id, leaveTypes[0].id, `Critical delivery overlap — ${stamp}`, USER_ID]
    );
  }
  for (let index = 0; index < organizationUsers.length; index += 1) {
    const user = organizationUsers[index];
    await db(
      `INSERT INTO attendance_daily
        (workspace_id,user_id,date,signed_in_minutes,available_minutes,aws_minutes,lunch_minutes,screen_on_minutes,screen_off_minutes)
       SELECT $1,$2,CURRENT_DATE-day_offset,$3,$4,$5,45,$6,$7
       FROM generate_series(0,13) AS day_offset
       ON CONFLICT (workspace_id,user_id,date) DO NOTHING`,
      [WORKSPACE_ID, user.id, 420 - (index % 5) * 35, 360 - (index % 4) * 30, 45 + (index % 3) * 20, 390, 30]
    );
  }

  console.log("[SEED] reviews");
  const cycle = await dbOne(
    `INSERT INTO review_cycles (workspace_id,name,type,start_date,end_date,status)
     VALUES ($1,$2,'quarterly',CURRENT_DATE-90,CURRENT_DATE+7,'active') RETURNING id`,
    [WORKSPACE_ID, `Q2 Enterprise Review ${stamp}`]
  );
  seededIds.reviewCycles.push(cycle.id);
  for (const user of organizationUsers.slice(14)) {
    await db(
      `INSERT INTO performance_reviews
        (cycle_id,reviewee_id,reviewer_id,type,status,overall_score,strengths,improvements,goals_next,submitted_at)
       VALUES ($1,$2,$3,'manager',$4,$5,$6,$7,$8,CASE WHEN $4='submitted' THEN NOW() END)`,
      [cycle.id, user.id, organizationUsers[6].id, user.id.endsWith("0") ? "pending" : "submitted",
        3.2 + (organizationUsers.indexOf(user) % 4) * 0.4,
        `Cross-functional execution evidence ${stamp}`,
        "Improve dependency visibility and earlier risk escalation",
        "Own one measurable reliability outcome"]
    );
  }

  console.log("[SEED] goals");
  const objectiveTitles = [
    "Improve enterprise release predictability", "Reduce customer escalation recurrence",
    "Increase platform reliability", "Shorten onboarding time-to-value",
    "Strengthen audit readiness", "Improve operating margin",
  ];
  for (let index = 0; index < objectiveTitles.length; index += 1) {
    const objective = await dbOne(
      `INSERT INTO okr_objectives
        (workspace_id,owner_id,title,description,time_period,status,progress)
       VALUES ($1,$2,$3,$4,'2026-Q3',$5,$6) RETURNING id`,
      [WORKSPACE_ID, organizationUsers[index].id, `${objectiveTitles[index]} [${stamp}]`,
        "Cross-functional objective with delivery, people and customer dependencies.",
        index % 3 === 0 ? "at_risk" : "on_track", 38 + index * 7]
    );
    seededIds.objectives.push(objective.id);
    await db(
      `INSERT INTO okr_key_results
        (objective_id,title,owner_id,type,target_value,current_value,unit,due_date,status)
       VALUES ($1,$2,$3,'number',100,$4,'percent',CURRENT_DATE+60,$5)`,
      [objective.id, `Measured enterprise outcome ${index + 1}`, organizationUsers[index + 6].id,
        30 + index * 8, index % 3 === 0 ? "at_risk" : "on_track"]
    );
  }

  console.log("[SEED] knowledge");
  const wikiSpace = await dbOne(
    `INSERT INTO wiki_spaces (workspace_id,name,slug,created_by)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [WORKSPACE_ID, `Enterprise Operating System ${stamp}`, `enterprise-os-${Date.now()}`, USER_ID]
  );
  seededIds.wikiSpaces.push(wikiSpace.id);
  const knowledgeTitles = ["Incident command", "Release governance", "Customer escalation",
    "Leave coverage", "Architecture decisions", "Security approval", "Executive operating review", "Business continuity"];
  for (let index = 0; index < knowledgeTitles.length; index += 1) {
    await db(
      `INSERT INTO wiki_pages
        (space_id,title,slug,content,content_text,created_by,updated_by,position)
       VALUES ($1,$2,$3,$4,$4,$5,$5,$6)`,
      [wikiSpace.id, `${knowledgeTitles[index]} [${stamp}]`, `${knowledgeTitles[index].replace(/\s+/g, "-")}-${Date.now()}-${index}`,
        `Verified operating policy for ${knowledgeTitles[index]}. Owners must preserve evidence and approval boundaries.`, USER_ID, index]
    );
  }

  console.log("[SEED] memory");
  for (let index = 0; index < 10; index += 1) {
    const row = await dbOne(
      `INSERT INTO workspace_memory_entries
        (workspace_id,title,content,tags,visibility,created_by,source_entity_type,metadata,is_pinned)
       VALUES ($1,$2,$3,$4::jsonb,'workspace',$5,'historical_decision',$6::jsonb,$7) RETURNING id`,
      [WORKSPACE_ID, `Historical decision ${index + 1} [${stamp}]`,
        `Leadership decision ${index + 1}: protect customer commitments while preserving approval and workspace boundaries.`,
        JSON.stringify(["decision", "enterprise", index % 2 ? "delivery" : "customer"]), USER_ID,
        JSON.stringify({ auditMarker: stamp, decisionOwner: organizationUsers[index % organizationUsers.length].id }), index < 2]
    );
    seededIds.memoryEntries.push(row.id);
  }

  console.log("[SEED] executive-digests");
  for (let index = 0; index < 3; index += 1) {
    const digest = await dbOne(
      `INSERT INTO workspace_digest_runs
        (workspace_id,user_id,role_scope,digest_type,delivery_mode,summary,content,status)
       VALUES ($1,$2,'executive','daily_os','preview',$3,$4::jsonb,'generated') RETURNING id`,
      [WORKSPACE_ID, USER_ID, `Executive operating summary ${index + 1} [${stamp}]`,
        JSON.stringify({ risks: ["delivery", "customer", "capacity"], decisions: ["sequence work", "preserve governance"], auditMarker: stamp })]
    );
    seededIds.digestRuns.push(digest.id);
  }

  console.log("[SEED] meetings");
  for (let index = 0; index < 3; index += 1) {
    const session = await dbOne(
      `INSERT INTO huddle_sessions
        (workspace_id,scope_type,scope_key,started_by,host_user_id,state,mode,visibility,ended_at,ended_by,end_reason,metadata)
       VALUES ($1::uuid,'workspace',($1::uuid)::text,$2,$2,'ended','audio_video','workspace',NOW()-($3||' hours')::interval,$2,'completed',$4::jsonb)
       RETURNING id`,
      [WORKSPACE_ID, USER_ID, index + 1, JSON.stringify({ auditMarker: stamp, title: `Executive operating review ${index + 1}` })]
    );
    seededIds.huddleSessions.push(session.id);
    await db(
      `INSERT INTO huddle_meeting_digests
        (workspace_id,session_id,digest_type,status,digest_json,provenance_json,metadata,created_by)
       VALUES ($1,$2,'executive','ready',$3::jsonb,$4::jsonb,$5::jsonb,$6)`,
      [WORKSPACE_ID, session.id,
        JSON.stringify({ summary: "Cross-functional operating review identified delivery and customer risk.", decisions: ["Escalate the dependency"], actions: [{ title: "Resolve cross-team dependency", ownerId: organizationUsers[6].id }] }),
        JSON.stringify({ sources: ["meeting transcript", "participant confirmation"], confidence: 0.91 }),
        JSON.stringify({ auditMarker: stamp }), USER_ID]
    );
  }

  return {
    people: organizationUsers.length,
    departments: [...new Set(organizationUsers.map((user) => user.department))],
    executives: organizationUsers.filter((user) => ["CEO", "CTO", "COO", "CFO"].includes(user.title)).length,
    managers: organizationUsers.filter((user) => user.role === "manager").length,
    individualContributors: organizationUsers.filter((user) => user.role === "user").length,
    leaveRecords: 4,
    attendanceDays: organizationUsers.length * 14,
    reviews: organizationUsers.slice(14).length,
    goals: seededIds.objectives.length,
    knowledgeArticles: knowledgeTitles.length,
    historicalDecisions: seededIds.memoryEntries.length,
    executiveSummaries: seededIds.digestRuns.length,
    meetings: seededIds.huddleSessions.length,
  };
}

async function createScenarioTask(scenario) {
  const project = projects.get(scenario.domain);
  const departmentAliases = {
    Leadership: ["Leadership"], Administration: ["Operations", "Finance"],
  };
  const targetDepartments = departmentAliases[scenario.domain] || [scenario.domain];
  const candidates = organizationUsers.filter((user) => targetDepartments.includes(user.department));
  const owner = candidates[tasks.length % Math.max(candidates.length, 1)] || organizationUsers[tasks.length % organizationUsers.length];
  const created = await request(`/tasks/${project.id}`, {
    method: "POST",
    expected: [201],
    body: {
      task: `${scenario.title} [${stamp}]`,
      description: scenario.description,
      status: scenario.blocked ? "blocked" : "in_progress",
      priority: scenario.priority,
      assigned_to: owner?.id || null,
      due_date: dueDate(scenario.overdueDays),
      is_blocked: scenario.blocked,
      estimation_hours: 8 + (scenario.overdueDays % 4) * 4,
      story_points: 3 + (scenario.overdueDays % 5),
    },
  });
  const task = { ...created.payload, scenario };
  task.auditOwner = owner ? { id: owner.id, title: owner.title, department: owner.department } : null;
  tasks.push(task);
  await request(`/tasks/${task.id}`, {
    method: "PUT",
    body: {
      status: scenario.blocked ? "blocked" : "in_progress",
      priority: scenario.priority,
      assigned_to: owner?.id || null,
      due_date: dueDate(scenario.overdueDays),
      is_blocked: scenario.blocked,
      description: `${scenario.description} Current user report confirms the condition remains unresolved.`,
    },
  });
  return task;
}

async function seedTaskDependencies(taskSubset) {
  let created = 0;
  for (let index = 1; index < taskSubset.length; index += 4) {
    const source = taskSubset[index - 1];
    const target = taskSubset[index];
    await db(
      `INSERT INTO task_links (source_task_id,target_task_id,link_type,workspace_id,created_by)
       VALUES ($1,$2,'blocks',$3,$4) ON CONFLICT DO NOTHING`,
      [source.id, target.id, WORKSPACE_ID, USER_ID]
    );
    await request(`/tasks/${target.id}`, {
      method: "PUT",
      body: { description: `${target.scenario.description} Verified dependency: ${source.task} blocks this outcome.`, is_blocked: true },
    });
    created += 1;
  }
  return created;
}

async function enqueueMeetingIntelligenceEvent() {
  const sessionId = seededIds.huddleSessions[0];
  const projectId = projects.values().next().value?.id || null;
  const event = await dbOne(
    `INSERT INTO workspace_events
      (id,workspace_id,actor_user_id,event_type,entity_type,entity_id,metadata,schema_version,origin,correlation_id,trace_id,occurred_at)
     VALUES (gen_random_uuid(),$1,$2,'MEETING_ENDED','meeting',$3,$4::jsonb,1,'local_certification',gen_random_uuid(),gen_random_uuid(),NOW())
     RETURNING id`,
    [WORKSPACE_ID, USER_ID, sessionId, JSON.stringify({ auditMarker: stamp, projectId, summary: "Executive operating review completed with governed actions." })]
  );
  await db(
    `INSERT INTO adaptive_event_queue (workspace_id,event_id,status,available_at)
     VALUES ($1,$2,'pending',NOW()) ON CONFLICT DO NOTHING`,
    [WORKSPACE_ID, event.id]
  );
  return { eventId: event.id, sessionId, projectId };
}

async function enqueueNativeOperationalEvents() {
  const projectId = projects.values().next().value?.id || null;
  const taskId = tasks[0]?.id || null;
  const targetUser = organizationUsers.find((user) => user.role === "user") || organizationUsers[0];
  const nativeEvents = [
    ["LEAVE_APPROVED", "people", targetUser?.id, "Approved leave overlaps customer escalation ownership"],
    ["ATTENDANCE_CHANGED", "people", targetUser?.id, "Material availability drop detected for critical delivery owner"],
    ["GOAL_UPDATED", "goal", seededIds.objectives[0] || null, "At-risk objective requires delivery realignment"],
    ["REVIEW_UPDATED", "review", seededIds.reviewCycles[0] || null, "Manager review update requires governed follow-through"],
    ["KNOWLEDGE_UPDATED", "knowledge", seededIds.wikiSpaces[0] || null, "Operating runbook changed for escalation response"],
    ["EXECUTIVE_SUMMARY_GENERATED", "executive_summary", seededIds.digestRuns[0] || null, "Executive context highlights unresolved customer and delivery risk"],
    ["CUSTOMER_ESCALATION", "customer", taskId, "Enterprise customer escalation threatens renewal and needs accountable work"],
    ["INCIDENT_REPORTED", "incident", taskId, "Production incident requires validation and stakeholder notification"],
    ["SECURITY_RISK_DETECTED", "security", taskId, "Security risk requires approval-gated response and testing evidence"],
  ];
  const created = [];
  for (const [eventType, entityType, entityId, summary] of nativeEvents) {
    const row = await dbOne(
      `INSERT INTO workspace_events
        (id,workspace_id,actor_user_id,event_type,entity_type,entity_id,metadata,schema_version,origin,correlation_id,trace_id,occurred_at)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6::jsonb,1,'local_native_enterprise',gen_random_uuid(),gen_random_uuid(),NOW())
       RETURNING id,event_type`,
      [
        WORKSPACE_ID,
        USER_ID,
        eventType,
        entityType,
        entityId,
        JSON.stringify({
          auditMarker: stamp,
          actorRole: "admin",
          projectId,
          taskId,
          userId: targetUser?.id || null,
          ownerId: targetUser?.id || null,
          priority: eventType.includes("SECURITY") || eventType.includes("INCIDENT") ? "critical" : "high",
          riskLevel: eventType.includes("SECURITY") || eventType.includes("INCIDENT") || eventType.includes("CUSTOMER") ? "critical" : "high",
          title: summary,
          summary,
          teamId: organizationUsers.find((user) => user.department === "Engineering")?.id || null,
          departmentId: organizationUsers.find((user) => user.department === "Leadership")?.id || null,
          enterpriseId: WORKSPACE_ID,
        }),
      ]
    );
    await db(
      `INSERT INTO adaptive_event_queue (workspace_id,event_id,status,available_at)
       VALUES ($1,$2,'pending',NOW()) ON CONFLICT DO NOTHING`,
      [WORKSPACE_ID, row.id]
    );
    created.push(row);
  }
  await request("/adaptive/worker/run-once", { method: "POST", body: { limit: 50 }, timeoutMs: 90000 });
  return created;
}

async function runSyntheticLoad(eventCount = 1000) {
  const beforeMemory = process.memoryUsage().rss;
  const inserted = await dbOne(
    `WITH events AS (
       INSERT INTO workspace_events
         (id,workspace_id,actor_user_id,event_type,entity_type,metadata,schema_version,origin,correlation_id,trace_id,occurred_at)
       SELECT gen_random_uuid(),$1,$2,'LOAD_TEST_SIGNAL','audit_load',
              jsonb_build_object('auditMarker',$3::text,'sequence',n),1,'local_load',gen_random_uuid(),gen_random_uuid(),NOW()
       FROM generate_series(1,$4::int) n RETURNING id
     ), queued AS (
       INSERT INTO adaptive_event_queue (workspace_id,event_id,status,available_at)
       SELECT $1,id,'pending',NOW() FROM events RETURNING id
     ) SELECT COUNT(*)::int count FROM queued`,
    [WORKSPACE_ID, USER_ID, stamp, eventCount]
  );
  const started = Date.now();
  let workerCalls = 0;
  while (workerCalls < 40) {
    const pending = await dbOne(
      `SELECT COUNT(*)::int count FROM adaptive_event_queue q
       JOIN workspace_events e ON e.id=q.event_id
       WHERE q.workspace_id=$1 AND q.status='pending' AND e.metadata->>'auditMarker'=$2 AND e.origin='local_load'`,
      [WORKSPACE_ID, stamp]
    );
    if (!pending.count) break;
    await request("/adaptive/worker/run-once", { method: "POST", body: { limit: 100 }, timeoutMs: 120000 });
    workerCalls += 1;
  }
  const elapsedMs = Date.now() - started;
  const queue = await dbOne(
    `SELECT COUNT(*)::int total,
            COUNT(*) FILTER (WHERE q.status='completed')::int completed,
            COUNT(*) FILTER (WHERE q.status='failed')::int failed,
            COUNT(*) FILTER (WHERE q.status='pending')::int pending,
            ROUND(AVG(EXTRACT(EPOCH FROM (q.processed_at-q.created_at))*1000)::numeric,2) avg_queue_latency_ms,
            ROUND(MAX(EXTRACT(EPOCH FROM (q.processed_at-q.created_at))*1000)::numeric,2) max_queue_latency_ms
     FROM adaptive_event_queue q JOIN workspace_events e ON e.id=q.event_id
     WHERE q.workspace_id=$1 AND e.metadata->>'auditMarker'=$2 AND e.origin='local_load'`,
    [WORKSPACE_ID, stamp]
  );
  return {
    inserted: inserted.count,
    workerCalls,
    elapsedMs,
    throughputPerSecond: Number((queue.completed / Math.max(elapsedMs / 1000, 0.001)).toFixed(2)),
    harnessRssDeltaBytes: process.memoryUsage().rss - beforeMemory,
    queue,
  };
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
  if (tasks.length) {
    await db(
      `UPDATE operations_ai_actions
       SET status = 'rejected',
           approved_at = COALESCE(approved_at, NOW()),
           updated_at = NOW()
       WHERE workspace_id = $1
         AND task_id = ANY($2::uuid[])
         AND status IN ('pending', 'approval_pending')`,
      [WORKSPACE_ID, tasks.map((task) => task.id)]
    ).catch(() => {});
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
  await db(`DELETE FROM huddle_sessions WHERE id = ANY($1::uuid[])`, [seededIds.huddleSessions]).catch(() => {});
  await db(`DELETE FROM workspace_digest_runs WHERE id = ANY($1::uuid[])`, [seededIds.digestRuns]).catch(() => {});
  await db(`DELETE FROM workspace_memory_entries WHERE id = ANY($1::uuid[])`, [seededIds.memoryEntries]).catch(() => {});
  await db(`DELETE FROM wiki_spaces WHERE id = ANY($1::uuid[])`, [seededIds.wikiSpaces]).catch(() => {});
  await db(`DELETE FROM okr_objectives WHERE id = ANY($1::uuid[])`, [seededIds.objectives]).catch(() => {});
  await db(`DELETE FROM review_cycles WHERE id = ANY($1::uuid[])`, [seededIds.reviewCycles]).catch(() => {});
  for (const user of [...organizationUsers].reverse()) {
    await db(`DELETE FROM users WHERE id=$1`, [user.id]).catch(() => {});
  }
  await db(`DELETE FROM leave_types WHERE id = ANY($1::uuid[])`, [seededIds.leaveTypes]).catch(() => {});
}

let finalEvidence = {};

try {
  await check("baseline.local-safety", async () => ({
    api: API, databaseHost: databaseUrl.hostname, database: databaseUrl.pathname.slice(1),
    productionBlocked: localHosts.has(apiUrl.hostname) && localHosts.has(databaseUrl.hostname),
  }));
  await check("baseline.local-version", async () => request("/version"));
  const organizationEvidence = await check("enterprise-organization.seed", seedRealisticOrganization);
  if (!organizationEvidence) throw new Error("Realistic organization seed is a mandatory certification prerequisite");
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

  const contractCatalogEvidence = await check("platform.contracts-readiness-and-workflow-catalog", async () => {
    const status = (await request("/adaptive/status")).payload;
    const catalog = (await request("/adaptive/workflow-catalog")).payload;
    if (status.contextHealth?.status !== "available") throw new Error("Context provider contracts are not available");
    if (!catalog.events?.length || !catalog.capabilities?.length || !catalog.templates?.length) {
      throw new Error("Workflow catalog is missing business vocabulary, capabilities, or templates");
    }
    return {
      healthStatus: status.status,
      contextReady: status.contextHealth.status === "available",
      contextProviders: status.contextHealth.providers?.length || 0,
      catalogEvents: catalog.events.length,
      catalogCapabilities: catalog.capabilities.length,
      catalogTemplates: catalog.templates.length,
    };
  });

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
  await check(`phase-1.create-${phaseOne.length}-operational-scenarios`, async () => {
    for (const scenario of phaseOne) await createScenarioTask(scenario);
    const dependencyCount = await seedTaskDependencies(tasks.filter((task) => task.scenario.phase === 1));
    return {
      count: phaseOne.length,
      dependencyCount,
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
  await check(`phase-2.create-${phaseTwo.length}-follow-up-scenarios`, async () => {
    for (const scenario of phaseTwo) await createScenarioTask(scenario);
    const dependencyCount = await seedTaskDependencies(tasks.filter((task) => task.scenario.phase === 2));
    return {
      count: phaseTwo.length,
      dependencyCount,
      repeatedBehaviourTheme: "manager and executive ownership overrides",
    };
  });
  await check("phase-2.manual-worker-drain", async () => {
    const runs = await drainWorker();
    return { workerCalls: runs.length };
  });
  const phaseTwoSummary = await check("phase-2.behaviour-summary", async () => summarizePhase(2));

  const nativeEventEvidence = await check("event-platform.native-enterprise-event-behaviour", async () => {
    const created = await enqueueNativeOperationalEvents();
    const rows = await db(
      `SELECT
         e.event_type,
         COUNT(DISTINCT r.id)::int runtime_runs,
         COUNT(DISTINCT a.id)::int recommendations,
         COUNT(DISTINCT a.capability_key)::int selected_capabilities,
         COUNT(*) FILTER (WHERE a.payload->'planningDecision'->>'registryDriven' = 'true')::int registry_planned_actions
       FROM workspace_events e
       LEFT JOIN adaptive_runtime_runs r ON r.event_id=e.id
       LEFT JOIN operations_ai_actions a ON a.adaptive_runtime_run_id=r.id
       WHERE e.id = ANY($1::uuid[])
       GROUP BY e.event_type
       ORDER BY e.event_type`,
      [created.map((event) => event.id)]
    );
    const missing = rows.filter((row) => Number(row.runtime_runs || 0) < 1);
    if (missing.length) throw new Error(`Native events did not process: ${missing.map((row) => row.event_type).join(", ")}`);
    return { created: created.length, rows };
  });

  const meetingEvent = await check("orchestration.meeting-event-enqueue", enqueueMeetingIntelligenceEvent);
  await check("orchestration.meeting-event-process", async () => {
    const run = await request("/adaptive/worker/run-once", { method: "POST", body: { limit: 25 }, timeoutMs: 60000 });
    return run.payload;
  });
  const meetingPlanEvidence = await check("orchestration.meeting-plan", async () => db(
    `SELECT a.id,a.capability_key,a.action_type,a.status,a.approval_mode,a.confidence,
            p.objective,p.status AS plan_status,s.step_index,s.depends_on
     FROM operations_ai_actions a
     JOIN adaptive_runtime_runs r ON r.id=a.adaptive_runtime_run_id
     LEFT JOIN adaptive_execution_plans p ON p.runtime_run_id=r.id
     LEFT JOIN adaptive_execution_plan_steps s ON s.action_id=a.id
     WHERE r.event_id=$1 ORDER BY s.step_index,a.created_at`,
    [meetingEvent?.eventId]
  ));

  const governedExecutions = await check("orchestration.governed-cross-capability-execution", async () => {
    const candidates = await db(
      `SELECT a.id,a.capability_key,a.status,s.step_index FROM operations_ai_actions a
       JOIN adaptive_runtime_runs r ON r.id=a.adaptive_runtime_run_id
       LEFT JOIN adaptive_execution_plan_steps s ON s.action_id=a.id
       WHERE r.event_id=$1 AND a.status IN ('pending','approval_pending')
       ORDER BY s.step_index NULLS LAST,a.created_at`,
      [meetingEvent?.eventId]
    );
    const results = [];
    for (const action of candidates.slice(0, 4)) {
      const response = await request(`/adaptive/recommendations/${action.id}/approve`, {
        method: "POST", body: { notes: `Governed local execution ${stamp}`, execute: true },
        expected: [200, 400], timeoutMs: 90000,
      });
      const persisted = await dbOne(
        `SELECT id,capability_key,status,executed_at,result FROM operations_ai_actions WHERE id=$1`,
        [action.id]
      );
      results.push({ endpointStatus: response.status, ...persisted });
    }
    return results;
  });

  const learningVariationEvidence = await check("learning.accept-reject-edit-ignore", async () => {
    const pending = await db(
      `SELECT id FROM operations_ai_actions
       WHERE workspace_id=$1 AND task_id=ANY($2::uuid[]) AND status IN ('pending','approval_pending')
       ORDER BY created_at DESC LIMIT 4`,
      [WORKSPACE_ID, tasks.filter((task) => task.scenario.phase === 2).map((task) => task.id)]
    );
    const feedback = [];
    if (pending[0]) feedback.push((await request(`/adaptive/recommendations/${pending[0].id}/feedback`, {
      method: "POST", body: { feedback: "edited", changes: { timing: "next_business_hour" }, note: `Manager edit ${stamp}` },
    })).payload);
    if (pending[1]) feedback.push((await request(`/adaptive/recommendations/${pending[1].id}/feedback`, {
      method: "POST", body: { feedback: "ignored", note: `Manager ignored ${stamp}` },
    })).payload);
    if (pending[2]) feedback.push((await request(`/adaptive/recommendations/${pending[2].id}/reject`, {
      method: "POST", body: { notes: `Manager rejected ${stamp}` },
    })).payload);
    if (pending[3]) feedback.push((await request(`/adaptive/recommendations/${pending[3].id}/approve`, {
      method: "POST", body: { notes: `Manager accepted ${stamp}`, execute: false },
    })).payload);
    return { signalCount: feedback.length, actionIds: pending.map((row) => row.id) };
  });

  const adaptiveStrategyEvidence = await check("learning.strategy-affects-planning-and-policy", async () => {
    const rows = await db(
      `SELECT scope_type, profile_key, sample_count, confidence, profile_value, explanation
       FROM adaptive_preference_profiles
       WHERE workspace_id=$1 AND profile_key='adaptive_strategy'
       ORDER BY sample_count DESC, updated_at DESC`,
      [WORKSPACE_ID]
    );
    const planned = await dbOne(
      `SELECT
         COUNT(*)::int actions,
         COUNT(*) FILTER (WHERE payload->'planningDecision'->>'registryDriven' = 'true')::int registry_driven,
         COUNT(*) FILTER (WHERE payload->'personalization'->>'strategySource' IS NOT NULL)::int strategy_personalized,
         COUNT(*) FILTER (WHERE payload->>'recommendedTiming' IS NOT NULL)::int timing_influenced
       FROM operations_ai_actions
       WHERE workspace_id=$1
         AND adaptive_runtime_run_id IN (
           SELECT id FROM adaptive_runtime_runs WHERE workspace_id=$1 AND started_at > NOW() - INTERVAL '1 hour'
         )`,
      [WORKSPACE_ID]
    );
    if (!rows.length) throw new Error("No adaptive_strategy profile was produced");
    return { profiles: rows, planned };
  });

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
         COUNT(*) FILTER (WHERE context_summary#>>'{operationalGraph,relevance,projectId}' IS NOT NULL)::int project_context_runs,
         COUNT(*) FILTER (WHERE COALESCE((context_summary->>'memoryCount')::int, 0) > 0)::int memory_context_runs,
         COUNT(*) FILTER (WHERE evidence::text ILIKE '%task_dependency%')::int reasoning_mentions_dependency,
         COUNT(*) FILTER (WHERE evidence::text ILIKE '%assignee_availability%')::int reasoning_mentions_leave,
         COUNT(*) FILTER (WHERE COALESCE((context_summary#>>'{operationalGraph,priorOutcomeCount}')::int,0) > 0)::int reasoning_mentions_history,
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

  const causalEvidence = await check("continuous-evaluation.causal-outcome-ledger", async () => {
    await db(
      `UPDATE adaptive_predictions
       SET evaluate_after = NOW()
       WHERE workspace_id=$1
         AND prediction_key LIKE 'outcome.%'
         AND action_id IN (
           SELECT id FROM operations_ai_actions
           WHERE task_id = ANY($2::uuid[])
         )
         AND status='pending'`,
      [WORKSPACE_ID, tasks.map((task) => task.id)]
    );
    await request("/adaptive/worker/run-once", { method: "POST", body: { limit: 50 }, timeoutMs: 90000 });
    const summary = await dbOne(
      `SELECT
         COUNT(*)::int evaluations,
         ROUND(AVG(score)::numeric, 3) avg_score,
         COUNT(*) FILTER (WHERE causal_claim->>'method' IS NOT NULL)::int with_causal_method,
         COUNT(DISTINCT causal_claim->>'method')::int distinct_methods
       FROM adaptive_causal_evaluations
       WHERE workspace_id=$1
         AND action_id IN (
           SELECT id FROM operations_ai_actions
           WHERE task_id = ANY($2::uuid[])
         )`,
      [WORKSPACE_ID, tasks.map((task) => task.id)]
    );
    if (!summary?.evaluations) throw new Error("No causal outcome evaluations were produced");
    return summary;
  });

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

  const governanceEvidence = await check("governance.roles-approval-and-tenant-boundaries", async () => {
    const member = organizationUsers.find((user) => user.role === "user");
    const memberToken = JWT_SECRET ? jwt.sign(
      { id: member.id, role: "user", workspaceId: WORKSPACE_ID }, JWT_SECRET, { expiresIn: "30m" }
    ) : null;
    const privilegedStatuses = {};
    if (memberToken) {
      for (const [key, path, method] of [
        ["settings", "/adaptive/settings", "GET"],
        ["worker", "/adaptive/worker/run-once", "POST"],
      ]) {
        const response = await fetch(`${API}${path}`, {
          method, headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
          body: method === "POST" ? JSON.stringify({ limit: 1 }) : undefined,
        });
        privilegedStatuses[key] = response.status;
      }
    }
    const pending = await dbOne(
      `SELECT id FROM operations_ai_actions WHERE workspace_id=$1 AND status IN ('pending','approval_pending') ORDER BY created_at DESC LIMIT 1`,
      [WORKSPACE_ID]
    );
    let directExecuteStatus = null;
    if (pending) directExecuteStatus = (await request(`/adaptive/recommendations/${pending.id}/execute`, {
      method: "POST", expected: [200, 400],
    })).status;

    const second = await fetch(`${API}/auth/dev-login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `isolated-${stamp}@localhost.test`, name: "Isolated Tenant Auditor", workspaceName: `Isolated Tenant ${stamp}` }),
    }).then((response) => response.json());
    const foreignProject = projects.values().next().value;
    const foreignResponse = await fetch(`${API}/projects/${foreignProject.id}`, {
      headers: { authorization: `Bearer ${second.token}` },
    });
    return {
      memberPrivilegedStatuses: privilegedStatuses,
      directExecuteStatus,
      directExecuteBlocked: directExecuteStatus === 400,
      foreignWorkspaceProjectStatus: foreignResponse.status,
      foreignWorkspaceReadBlocked: [401, 403, 404].includes(foreignResponse.status),
      secondWorkspaceId: second.workspace?.id,
    };
  });

  const aiServiceEvidence = await check("ai-service.local-auth-and-context", async () => {
    const base = "http://localhost:5005";
    const health = await fetch(`${base}/health`);
    const ready = await fetch(`${base}/ready`);
    const invalid = await fetch(`${base}/ai/health`, {
      method: "POST", headers: { authorization: "Bearer invalid-local-certification-token" },
    });
    const secret = process.env.INTERNAL_SERVICE_SECRET || process.env.AI_SERVICE_SECRET;
    const valid = await fetch(`${base}/ai/health`, {
      method: "POST", headers: { authorization: `Bearer ${secret}` },
    });
    const preview = await fetch(`${base}/ai/chat/preview`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: WORKSPACE_ID, userId: USER_ID, intent: "enterprise_status" }),
      signal: AbortSignal.timeout(30000),
    });
    return {
      health: { status: health.status, body: await health.json() },
      readiness: { status: ready.status, body: await ready.json() },
      invalidAuthStatus: invalid.status,
      validAuth: { status: valid.status, body: await valid.json() },
      contextPreview: { status: preview.status, body: await preview.json().catch(() => null) },
    };
  });

  const performanceEvidence = await check("performance.2000-event-throughput", () => runSyntheticLoad(2000));

  finalEvidence = {
    stamp,
    environment: { api: API, database: databaseUrl.pathname.slice(1), localOnly: true },
    organizationEvidence,
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
    meetingPlanEvidence,
    governedExecutions,
    learningVariationEvidence,
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
    governanceEvidence,
    aiServiceEvidence,
    contractCatalogEvidence,
    nativeEventEvidence,
    adaptiveStrategyEvidence,
    causalEvidence,
    performanceEvidence,
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
