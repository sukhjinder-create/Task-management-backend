import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { evaluateProjectIntelligence } from "../intelligence/evaluators/projectEvaluator.js";
import { evaluateTeamIntelligence } from "../intelligence/evaluators/teamEvaluator.js";
import { evaluateUserIntelligence } from "../intelligence/evaluators/userEvaluator.js";
import { evaluateWorkspaceIntelligence } from "../intelligence/evaluators/workspaceEvaluator.js";

const root = process.cwd();
const frontendRoot = path.resolve(root, "..", "Task-management");

function read(relativePath, base = root) {
  return fs.readFileSync(path.join(base, relativePath), "utf8");
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function assertIncludes(source, needle, message) {
  assert.ok(source.includes(needle), message || `Expected ${needle}`);
}

function assertNotIncludes(source, needle, message) {
  assert.ok(!source.includes(needle), message || `Did not expect ${needle}`);
}

function buildSyntheticEvidence() {
  const userId = "11111111-1111-4111-8111-111111111111";
  const workspaceId = "22222222-2222-4222-8222-222222222222";
  const projectId = "33333333-3333-4333-8333-333333333333";
  const start = new Date("2026-06-01T00:00:00.000Z");
  const end = new Date("2026-06-14T23:59:59.999Z");
  const expectedWorkingDays = [];
  const nonWorkingDays = [];
  const attendance = [];
  const attendanceEvents = [];
  const attendanceByDate = new Map();
  const deliveryByDate = new Map();

  for (let i = 0; i < 14; i += 1) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) {
      nonWorkingDays.push({ date, expectedCapacity: 0, weekend: true });
      continue;
    }
    expectedWorkingDays.push({ date, expectedCapacity: 1 });
    const row = {
      workspace_id: workspaceId,
      user_id: userId,
      date,
      signed_in_minutes: i === 8 ? 0 : 500,
      available_minutes: i === 8 ? 0 : 390,
      aws_minutes: i === 8 ? 0 : 35,
      lunch_minutes: i === 8 ? 0 : 55,
      screen_on_minutes: i === 8 ? 0 : 360,
      screen_off_minutes: i === 8 ? 0 : 140,
    };
    attendance.push(row);
    attendanceByDate.set(date, row);
    if (row.signed_in_minutes > 0) {
      attendanceEvents.push(
        { event_type: "SIGN_IN", started_at: `${date}T09:15:00.000Z` },
        { event_type: "SIGN_OFF", started_at: `${date}T18:05:00.000Z` },
      );
    }
  }

  const weekendDate = nonWorkingDays[0].date;
  const weekendRow = {
    workspace_id: workspaceId,
    user_id: userId,
    date: weekendDate,
    signed_in_minutes: 180,
    available_minutes: 140,
    aws_minutes: 0,
    lunch_minutes: 20,
    screen_on_minutes: 120,
    screen_off_minutes: 60,
  };
  attendance.push(weekendRow);
  attendanceByDate.set(weekendDate, weekendRow);
  deliveryByDate.set(weekendDate, { completedTasks: 1, storyPoints: 3, timeLogHours: 2 });

  const tasks = [
    {
      id: "44444444-4444-4444-8444-444444444441",
      workspace_id: workspaceId,
      project_id: projectId,
      assigned_to: userId,
      added_by: userId,
      task: "Ship dashboard adapter",
      status: "completed",
      due_date: "2026-06-07T00:00:00.000Z",
      created_at: "2026-06-01T10:00:00.000Z",
      completed_at: "2026-06-06T16:00:00.000Z",
      estimation_hours: 8,
      story_points: 5,
    },
    {
      id: "44444444-4444-4444-8444-444444444442",
      workspace_id: workspaceId,
      project_id: projectId,
      assigned_to: userId,
      added_by: userId,
      task: "Resolve dependency",
      status: "completed",
      due_date: "2026-06-12T00:00:00.000Z",
      created_at: "2026-06-04T10:00:00.000Z",
      completed_at: "2026-06-10T16:00:00.000Z",
      estimation_hours: 4,
      story_points: 3,
    },
    {
      id: "44444444-4444-4444-8444-444444444443",
      workspace_id: workspaceId,
      project_id: projectId,
      assigned_to: userId,
      added_by: userId,
      task: "Document migration",
      status: "in-progress",
      due_date: "2026-06-20T00:00:00.000Z",
      created_at: "2026-06-09T10:00:00.000Z",
      completed_at: null,
      estimation_hours: 5,
      story_points: 2,
    },
  ];

  return {
    workspaceId,
    userId,
    range: {
      start,
      end,
      startDate: "2026-06-01",
      endDate: "2026-06-14",
      windowDays: 14,
    },
    calendar: {
      expectedWorkingDays,
      nonWorkingDays,
      holidayCount: 0,
      approvedLeaveDays: 0,
    },
    attendanceClosedThroughDate: "2026-06-14",
    attendanceCoverage: {
      startDate: "2026-06-01",
      endDate: "2026-06-14",
    },
    attendance,
    attendanceByDate,
    attendanceEvents,
    deliveryByDate,
    tasks,
    priorTasks: tasks.slice(0, 1),
    timeLogs: [
      { task_id: tasks[0].id, hours: 7.5, log_date: "2026-06-06" },
      { task_id: tasks[1].id, hours: 4, log_date: "2026-06-10" },
    ],
    comments: [
      { project_id: projectId, assigned_to: userId },
      { project_id: projectId, assigned_to: userId },
    ],
    watchers: [{ project_id: projectId }],
    taskLinks: [{ link_type: "is_blocked_by", status: "completed", completed_at: "2026-06-10T12:00:00.000Z" }],
    reviews: [{ status: "submitted" }],
    activity: [{ action_type: "STATUS_CHANGED" }, { action_type: "DESCRIPTION_UPDATED" }],
  };
}

const migration = read("migrations/20260624_enterprise_intelligence_rearchitecture.sql");
const cutoverMigration = read("migrations/20260624_enterprise_intelligence_cutover_controls.sql");
[
  "user_intelligence",
  "project_intelligence",
  "team_intelligence",
  "workspace_intelligence",
  "intelligence_snapshots",
  "intelligence_recalculation_events",
].forEach((table) => assertIncludes(migration, table, `Migration must create ${table}`));
assertIncludes(migration, "source_id TEXT", "Recalculation source IDs must support non-UUID audit identifiers");
assertIncludes(cutoverMigration, "enterprise_intelligence_cutover_controls", "Cutover controls migration must create the control table");
assertIncludes(cutoverMigration, "'legacy'", "Cutover controls must support legacy mode");
assertIncludes(cutoverMigration, "'shadow'", "Cutover controls must support shadow mode");
assertIncludes(cutoverMigration, "'unified'", "Cutover controls must support unified mode");

const historicalAnalytics = read("intelligence/analytics/historicalAnalytics.service.js");
const unifiedRepository = read("intelligence/repositories/unifiedIntelligence.repository.js");
assertIncludes(historicalAnalytics, "\"custom\"", "Historical analytics must accept custom ranges");
assertIncludes(unifiedRepository, "BETWEEN $5::date AND $6::date", "Snapshot repository must query custom date ranges without recalculation");
[
  "computedAt",
  "coverageStart",
  "coverageEnd",
  "attendanceClosedThroughDate",
  "snapshotDate",
  "intelligenceMode",
].forEach((field) => assertIncludes(unifiedRepository, field, `Repository must expose canonical time field ${field}`));

const dashboardService = stripComments(read("services/dashboard.service.js"));
const dashboardAdapter = stripComments(read("intelligence/analytics/unifiedDashboard.adapter.js"));
const cutoverIsolation = stripComments(read("intelligence/analytics/cutoverIsolation.service.js"));
const cutoverPolicy = stripComments(read("intelligence/cutover/enterpriseIntelligenceCutover.policy.js"));
const cutoverSwitch = stripComments(read("intelligence/cutover/sourceSwitch.service.js"));
const cutoverDiagnostics = stripComments(read("intelligence/cutover/cutoverDiagnostics.service.js"));
const legacyDashboardAdapter = stripComments(read("intelligence/legacy/legacyDashboard.adapter.js"));
const legacyIntelligenceAdapter = stripComments(read("intelligence/legacy/legacyIntelligence.adapter.js"));
const intelligenceResponses = stripComments(read("intelligence/analytics/intelligenceResponses.service.js"));
assertIncludes(dashboardService, "getDashboardOverviewFromIntelligence", "Dashboard service must read unified intelligence");
assertIncludes(dashboardService, "resolveCutoverResponse", "Dashboard service must route through staged cutover controls");
assertIncludes(dashboardService, "getLegacyDashboardOverview", "Dashboard service must keep explicit rollback adapter reachable during staged cutover");
assertNotIncludes(dashboardService, "dashboardScore", "Dashboard service must not import dashboard scoring formulas");
assertNotIncludes(dashboardService, "workspace_monthly_scores", "Dashboard service must not read legacy monthly scores");
assertIncludes(cutoverPolicy, "DEFAULT_CORE_MODE = CUTOVER_MODES.LEGACY", "Cutover policy must default safely to legacy mode");
assertIncludes(cutoverPolicy, "CORE_CUTOVER_SURFACES", "Cutover policy must enumerate core surfaces");
assertIncludes(cutoverPolicy, "ISOLATED_NON_CORE_SURFACES", "Cutover policy must enumerate isolated non-core surfaces");
assertIncludes(cutoverPolicy, "X-Enterprise-Intelligence-Mode", "Cutover policy must set mode header");
assertIncludes(cutoverPolicy, "X-Enterprise-Intelligence-Source", "Cutover policy must set source header");
assertIncludes(cutoverSwitch, "shadowCompared", "Cutover switch must expose shadow comparison state");
assertIncludes(cutoverSwitch, "legacy_scoring_rollback", "Cutover switch must support explicit legacy rollback source");
assertIncludes(cutoverSwitch, "[enterprise-intelligence-cutover]", "Cutover switch must emit operational observations");
assertIncludes(cutoverDiagnostics, "completeness", "Cutover diagnostics must report repository completeness");
assertIncludes(cutoverDiagnostics, "freshness", "Cutover diagnostics must report stale intelligence rows");
assertIncludes(cutoverDiagnostics, "recalculationFailures24h", "Cutover diagnostics must report recalculation failures");
assertIncludes(legacyDashboardAdapter, "legacy_scoring_rollback", "Legacy dashboard adapter must identify rollback output");
assertIncludes(legacyIntelligenceAdapter, "legacy_scoring_rollback", "Legacy intelligence adapter must identify rollback output");
assertIncludes(dashboardAdapter, "visualizations", "Dashboard adapter must provide repository-backed visualization configs");
assertIncludes(dashboardAdapter, "workspace_health_trends", "Admin dashboard must expose workspace health trends");
assertIncludes(dashboardAdapter, "team_comparisons", "Admin dashboard must expose team comparison charts");
assertIncludes(dashboardAdapter, "assigned_project_performance", "Manager dashboard must expose assigned project performance");
assertIncludes(dashboardAdapter, "personal_performance_trends", "User dashboard must expose personal performance trends");
assertIncludes(dashboardAdapter, "id: key", "Dashboard chart contract must expose a stable chart id");
assertIncludes(dashboardAdapter, "scope: scope ||", "Dashboard chart contract must expose chart scope metadata");
assertIncludes(dashboardAdapter, "axis: chartAxis()", "Dashboard chart contract must expose axis metadata");
assertIncludes(dashboardAdapter, "series: chartSeries(metric)", "Dashboard chart contract must expose series metadata");
assertIncludes(dashboardAdapter, "value: chartValue(point.value)", "Line chart values must use the canonical backend chart value shape");
assertIncludes(dashboardAdapter, "value: chartValue(row.value)", "Bar chart values must use the canonical backend chart value shape");
assertNotIncludes(dashboardAdapter, "scoreBand", "Dashboard adapter must not derive fallback score bands");
assertNotIncludes(dashboardAdapter, "100 - point.score", "Dashboard adapter must not derive risk chart values from score");
assertNotIncludes(dashboardAdapter, "100 - metricFromSnapshot", "Dashboard adapter must not synthesize risk values from alternate indexes");
assertNotIncludes(dashboardAdapter, "metricFromSnapshot(point, \"indexes.productivityIndex\", point.score)", "Productivity chart must not fall back to overall score");
assertNotIncludes(dashboardAdapter, "metricFromSnapshot(point, \"dimensions.workSustainability.score\", point.score)", "Workload chart must not fall back to overall score");
assertNotIncludes(dashboardAdapter, "metricFromSnapshot(point, \"dimensions.deliveryEffectiveness.score\", point.score)", "Delivery chart must not fall back to overall score");

const controller = stripComments(read("intelligence/intelligence.controller.js"));
const intelligenceRoutes = stripComments(read("intelligence/intelligence.routes.js"));
const executiveSummaryGenerator = stripComments(read("intelligence/executiveSummary.generator.js"));
const aiFeaturesService = stripComments(read("services/aiFeatures.service.js"));
assertIncludes(controller, "getUnifiedIntelligenceSnapshot", "Controller must expose unified intelligence snapshots");
assertIncludes(controller, "source: \"enterprise_intelligence\"", "Controller responses must mark enterprise source");
assertIncludes(controller, "getCutoverStatus", "Controller must expose cutover status");
assertIncludes(controller, "getCutoverHealth", "Controller must expose cutover health");
assertIncludes(controller, "updateCutoverControl", "Controller must expose cutover control updates");
assertIncludes(controller, "resolveCutoverResponse", "Controller must route core surfaces through cutover controls");
assertIncludes(intelligenceRoutes, "/cutover/status", "Routes must expose cutover status endpoint");
assertIncludes(intelligenceRoutes, "/cutover/health", "Routes must expose cutover health endpoint");
assertIncludes(intelligenceRoutes, "/cutover/controls", "Routes must expose cutover controls endpoint");
assertNotIncludes(controller, "runManualMonthlyScoring", "Active controller path must not trigger manual monthly scoring");
assertNotIncludes(controller, "Math.round", "Intelligence controller must not calculate scores inline");
assertNotIncludes(controller, ".reduce(", "Intelligence controller must not aggregate score math inline");
assertNotIncludes(controller, "healthScore =", "Intelligence controller must not compute health scores inline");
assertIncludes(intelligenceResponses, "buildAdminInsightsResponse", "Intelligence response aggregation must live outside controllers");
assertIncludes(intelligenceResponses, "surfaceClassification: \"derived_user_comparison\"", "Team comparison must be explicitly classified as a derived comparison surface");
assertIncludes(intelligenceResponses, "canonicalTeamAuthority: \"team_intelligence\"", "Team comparison must point to canonical team intelligence authority");
assertIncludes(intelligenceResponses, "teamScoreAuthority: false", "Team comparison must not masquerade as canonical team score authority");
assertIncludes(cutoverIsolation, "legacy_isolated_non_core", "Legacy/non-core paths must have explicit cutover isolation source");
assertIncludes(cutoverIsolation, "excluded_from_enterprise_intelligence_cutover", "Legacy/non-core paths must be explicitly excluded from cutover");
assertIncludes(cutoverIsolation, "dashboardEligible: false", "Isolated paths must not be dashboard-eligible");
assertIncludes(controller, "enterprise_specialty_profitability_oracle", "Profitability oracle must be explicitly isolated");
assertIncludes(controller, "enterprise_specialty_resignation_radar", "Resignation radar must be explicitly isolated");
assertIncludes(controller, "enterprise_specialty_ghost_work", "Ghost work analytics must be explicitly isolated");
assertIncludes(controller, "enterprise_specialty_org_truth_map", "Org truth map must be explicitly isolated");
assertIncludes(controller, "okr_goal_health", "OKR health must be explicitly isolated");
assertIncludes(intelligenceResponses, "legacyContext", "Executive summary data must keep isolated legacy context separate");
assertIncludes(intelligenceResponses, "okrHealth: null", "Core executive summary prompt must not silently consume isolated OKR health");
assertIncludes(executiveSummaryGenerator, "dashboardEligible !== false", "Executive summary generator must skip isolated OKR health");
assertIncludes(aiFeaturesService, "ai_task_deadline_risk", "AI task risk must be explicitly isolated");

const workspaceHealthService = stripComments(read("services/workspaceHealth.service.js"));
assertIncludes(workspaceHealthService, "getWorkspaceIntelligence", "Workspace health compatibility service must read enterprise intelligence");
assertIncludes(workspaceHealthService, "evaluateAndPersistWorkspace", "Workspace health compatibility service must delegate recalculation to the unified engine");
assertNotIncludes(workspaceHealthService, "INSERT INTO workspace_health", "Workspace health compatibility service must not write legacy health rows");
assertNotIncludes(workspaceHealthService, "FROM workspace_health", "Workspace health compatibility service must not read legacy health rows");

const socket = stripComments(read("realtime/socket.js"));
assertIncludes(socket, "getWorkspaceHealthScore", "Realtime health pulse must read persisted enterprise workspace intelligence");
assertNotIncludes(socket, "recomputeWorkspaceHealth", "Realtime health pulse must not trigger a second workspace recalculation");

const executionObserver = stripComments(read("events/observers/executionIntelligence.observer.js"));
assertIncludes(executionObserver, "queueImpactedIntelligenceRecalculation", "Integration execution observer must route into unified recalculation");
assertIncludes(executionObserver, "integration_execution_signal", "Integration execution observer must audit recalculation reason");

const workspaceEvidence = stripComments(read("intelligence/engine/evidenceCollector.js"));
const projectEvaluator = stripComments(read("intelligence/evaluators/projectEvaluator.js"));
const teamEvaluator = stripComments(read("intelligence/evaluators/teamEvaluator.js"));
const workspaceEvaluator = stripComments(read("intelligence/evaluators/workspaceEvaluator.js"));
assertIncludes(workspaceEvidence, "integration_entity_state", "Workspace evidence must include integration inventory");
assertIncludes(workspaceEvidence, "workspace_execution_signals", "Workspace evidence must include integration execution signals");
assertIncludes(workspaceEvaluator, "executionRealityIndex", "Workspace evaluator must expose integration/internal execution evidence as an enterprise index");
assertIncludes(teamEvaluator, "workloadBalanceIndex", "Team evaluator must expose workload balance");
assertIncludes(teamEvaluator, "blockerResolutionHealth", "Team evaluator must expose blocker/dependency flow health");
assertIncludes(projectEvaluator, "executionMomentum", "Project evaluator must expose execution momentum");
assertIncludes(projectEvaluator, "participationHealth", "Project evaluator must expose participation health");
assertIncludes(workspaceEvaluator, "attendanceReadinessIndex", "Workspace evaluator must expose attendance readiness");
assertIncludes(workspaceEvaluator, "capacitySustainabilityIndex", "Workspace evaluator must expose capacity sustainability");

const attendanceCron = read("cron/attendance.cron.js");
const monthlyIntelligenceCron = stripComments(read("cron/monthlyIntelligence.cron.js"));
const attendanceService = stripComments(read("services/attendance.service.js"));
const attendanceEvaluator = stripComments(read("intelligence/evaluators/attendanceEvaluator.js"));
const evidenceCollector = stripComments(read("intelligence/engine/evidenceCollector.js"));
assertIncludes(attendanceCron, "runAttendanceIntelligenceCloseout", "Attendance cron must run end-of-day intelligence closeout");
assertIncludes(attendanceCron, "aggregateDailyAttendance", "Attendance closeout must follow daily aggregation");
assertIncludes(monthlyIntelligenceCron, "writeSnapshot", "Monthly intelligence cron must capture repository snapshots");
assertIncludes(monthlyIntelligenceCron, "scheduled_intelligence_snapshot", "Monthly intelligence cron must audit snapshot capture");
assertNotIncludes(monthlyIntelligenceCron, "generateMonthlyScore", "Monthly intelligence cron must not generate legacy monthly scores");
assertNotIncludes(monthlyIntelligenceCron, "generateMonthlyCoaching", "Monthly intelligence cron must not depend on legacy monthly coaching");
assertNotIncludes(monthlyIntelligenceCron, "generateAdminInsights", "Monthly intelligence cron must not read legacy monthly score tables");
assertNotIncludes(attendanceService, "queueImpactedIntelligenceRecalculation", "Attendance events must not recalculate immediately");
assertIncludes(evidenceCollector, "MAX(date)::text AS closed_through", "Attendance evidence must be capped to closed attendance days");
assertIncludes(attendanceEvaluator, "MEANINGFUL_TIME_LOG_HOURS", "Attendance evaluator must reject trivial non-working day activity");
assertIncludes(attendanceEvaluator, "MAX_EXCEPTIONAL_ATTENDANCE_INDICATORS", "Attendance exceptional recognition must be bounded");
assertIncludes(attendanceEvaluator, "scoreInflation", "Attendance recognition must document no direct score inflation");

const recalculationQueue = stripComments(read("intelligence/realtime/recalculation.service.js"));
const unifiedEngine = stripComments(read("intelligence/engine/unifiedIntelligence.engine.js"));
const realDataValidator = stripComments(read("scripts/enterprise-intelligence-real-data-shadow-validation.js"));
const cutoverRunbook = read("docs/enterprise-intelligence/ENTERPRISE_PRODUCTION_CUTOVER_RUNBOOK.md");
const monitoringGuide = read("docs/enterprise-intelligence/ENTERPRISE_POST_CUTOVER_MONITORING_GUIDE.md");
const smokeChecklist = read("docs/enterprise-intelligence/ENTERPRISE_STAGED_ROLLOUT_SMOKE_TEST_CHECKLIST.md");
const goNoGoPackage = read("docs/enterprise-intelligence/ENTERPRISE_PRODUCTION_GO_NO_GO_PACKAGE.md");
assertIncludes(realDataValidator, "local_representative_seeded_workspace_snapshot", "Real-data validator must have a local representative fallback for unreachable DB hosts");
assertIncludes(realDataValidator, "representative_seeded_workspace_validation_passed_for_staged_cutover", "Real-data validator must emit a staged-cutover readiness signal for passing representative validation");
assertIncludes(realDataValidator, "team_comparison_score_mismatch", "Real-data validator must check derived team comparison consistency");
assertIncludes(cutoverRunbook, "legacy", "Cutover runbook must document legacy mode");
assertIncludes(cutoverRunbook, "shadow", "Cutover runbook must document shadow mode");
assertIncludes(cutoverRunbook, "unified", "Cutover runbook must document unified mode");
assertIncludes(cutoverRunbook, "Rollback", "Cutover runbook must document rollback");
assertIncludes(monitoringGuide, "/intelligence/cutover/health", "Monitoring guide must document health endpoint");
assertIncludes(monitoringGuide, "X-Enterprise-Intelligence-Mode", "Monitoring guide must document response headers");
assertIncludes(smokeChecklist, "legacy", "Smoke checklist must cover legacy mode");
assertIncludes(smokeChecklist, "shadow", "Smoke checklist must cover shadow mode");
assertIncludes(smokeChecklist, "unified", "Smoke checklist must cover unified mode");
assertIncludes(goNoGoPackage, "Go for staged production cutover only", "Go/no-go package must restrict approval to staged cutover");
assertIncludes(recalculationQueue, "COALESCE_DELAY_MS", "Recalculation queue must coalesce repeated events");
assertIncludes(recalculationQueue, "MAX_ATTEMPTS", "Recalculation queue must retry safely");
assertIncludes(recalculationQueue, "dedupeKey", "Recalculation queue must carry a stable dedupe key");
assertIncludes(recalculationQueue, "getRecalculationQueueDiagnostics", "Recalculation queue must expose diagnostics");
assertIncludes(unifiedEngine, "partial_recalculation_failed", "Unified engine must record partial recalculation failures");
assertIncludes(unifiedEngine, "workspace_aggregate_not_refreshed_after_partial_failure", "Workspace aggregate must not refresh after partial failure");

const triggerSources = [
  read("services/task.service.js"),
  read("services/comment.service.js"),
  read("services/timeTracking.service.js"),
  read("services/taskLinks.service.js"),
  read("services/sprint.service.js"),
  read("routes/leave.routes.js"),
  read("routes/reviews.routes.js"),
  read("routes/projectStatus.routes.js"),
  read("intelligence/realtime/attendanceCloseout.service.js"),
].join("\n");
[
  "task_created",
  "task_updated",
  "task_completed",
  "task_reassigned",
  "comment_added",
  "blocker_added",
  "blocker_resolved",
  "attendance_day_closed",
  "leave_approved",
  "review_submitted",
  "project_status_changed",
  "time_log_added",
  "milestone_completed",
].forEach((eventName) => assertIncludes(triggerSources, eventName, `Missing event trigger: ${eventName}`));

const dashboard = read("src/pages/Dashboard.jsx", frontendRoot);
assertIncludes(dashboard, "ResponsiveContainer", "Dashboard must render integrated charts");
assertIncludes(dashboard, "dashboardOverview?.visualizations?.charts", "Dashboard charts must consume backend visualization configs");
assertNotIncludes(dashboard, "30% of score", "Dashboard must not expose old score weighting copy");
assertNotIncludes(dashboard, "70% of score", "Dashboard must not expose old score weighting copy");
assertNotIncludes(dashboard, "Weighted from attendance and productivity", "Dashboard must not describe a static formula");

const result = evaluateUserIntelligence(buildSyntheticEvidence());
const repeatResult = evaluateUserIntelligence(buildSyntheticEvidence());
const syntheticEvidence = buildSyntheticEvidence();
assert.equal(result.subjectType, "user");
assert.equal(typeof result.score, "number");
assert.ok(result.score >= 0 && result.score <= 100);
assert.ok(result.confidence >= 0 && result.confidence <= 100);
assert.equal(result.score, repeatResult.score, "User intelligence evaluation must be deterministic");
assert.equal(result.evidenceHash, repeatResult.evidenceHash, "User intelligence evidence hash must be deterministic");
assert.ok(result.attendance?.metrics?.expectedWorkingDays > 0);
assert.equal(result.sourceWindow.attendanceClosedThroughDate, "2026-06-14");
assert.ok(result.attendance?.drivers?.length > 0, "Attendance evaluation must be explainable");
assert.ok(result.attendance?.metrics?.meaningfulDeliveryRule, "Attendance must document meaningful delivery");
assert.ok(Array.isArray(result.strengths), "User intelligence must include strengths");
assert.ok(Array.isArray(result.concerns), "User intelligence must include concerns");
assert.ok(Array.isArray(result.drivers), "User intelligence must include drivers");
assert.ok(result.evidenceHash, "User intelligence must include evidence hash");

const workspaceResult = evaluateWorkspaceIntelligence({
  workspaceId: "22222222-2222-4222-8222-222222222222",
  users: [
    { score: 82, dimensions: { deliveryEffectiveness: { score: 78 }, collaborationHealth: { score: 76 } }, risk: { level: "Low" } },
    { score: 54, dimensions: { deliveryEffectiveness: { score: 58 }, collaborationHealth: { score: 62 } }, risk: { level: "Medium" } },
  ],
  projects: [
    { score: 74, indexes: { velocityHealth: 72, completionConfidence: 76 }, risk: { level: "Low" } },
  ],
  teams: [
    { score: 70, indexes: { deliveryReliabilityIndex: 69, executionPredictability: 71 } },
  ],
  evidence: {
    execution: {
      internalTotal: 10,
      internalCompleted: 7,
      externalTotal: 4,
      externalCompleted: 3,
      totalWork: 14,
      completedWork: 10,
      externalProviderCount: 1,
      externalSignalCount: 3,
    },
  },
});
assert.ok(workspaceResult.indexes.executionRealityIndex >= 0, "Workspace intelligence must include execution reality index");
assert.ok(workspaceResult.indexes.attendanceReadinessIndex >= 0, "Workspace intelligence must include attendance readiness index");
assert.ok(workspaceResult.indexes.capacitySustainabilityIndex >= 0, "Workspace intelligence must include capacity sustainability index");
assert.equal(workspaceResult.analytics.execution.totalWork, 14, "Workspace intelligence must preserve execution evidence");

const projectResult = evaluateProjectIntelligence({
  workspaceId: syntheticEvidence.workspaceId,
  projectId: "33333333-3333-4333-8333-333333333333",
  range: syntheticEvidence.range,
  tasks: syntheticEvidence.tasks,
  sprints: [{ status: "completed" }, { status: "active" }],
  links: syntheticEvidence.taskLinks,
});
assert.ok(projectResult.indexes.executionMomentum >= 0, "Project intelligence must include execution momentum");
assert.ok(projectResult.indexes.participationHealth >= 0, "Project intelligence must include participation health");

const teamResult = evaluateTeamIntelligence({
  workspaceId: syntheticEvidence.workspaceId,
  teamKey: "manager:11111111-1111-4111-8111-111111111111",
  managerId: syntheticEvidence.userId,
  users: [
    { score: 82, dimensions: { collaborationHealth: { score: 76 }, executionReliability: { score: 80 }, workSustainability: { score: 74 } }, analytics: { assignedWork: 8 }, risk: { level: "Low" } },
    { score: 54, dimensions: { collaborationHealth: { score: 62 }, executionReliability: { score: 58 }, workSustainability: { score: 55 } }, analytics: { assignedWork: 3 }, risk: { level: "Medium" } },
  ],
  projects: [projectResult],
});
assert.ok(teamResult.indexes.workloadBalanceIndex >= 0, "Team intelligence must include workload balance");
assert.ok(teamResult.indexes.blockerResolutionHealth >= 0, "Team intelligence must include blocker resolution health");

console.log("Enterprise intelligence architecture verification passed", {
  syntheticScore: result.score,
  confidence: result.confidence,
  attendanceScore: result.attendance.score,
  workspaceExecutionIndex: workspaceResult.indexes.executionRealityIndex,
  projectMomentum: projectResult.indexes.executionMomentum,
  teamWorkloadBalance: teamResult.indexes.workloadBalanceIndex,
  indicators: result.indicators.length,
});
