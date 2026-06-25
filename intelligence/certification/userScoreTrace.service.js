import pool from "../../db.js";
import { buildUserPerformanceResponse, buildUserTrendResponse } from "../analytics/intelligenceResponses.service.js";
import { collectUserEvidence } from "../engine/evidenceCollector.js";
import { adaptiveScore, roundScore } from "../engine/scorePrimitives.js";
import { evaluateUserIntelligence } from "../evaluators/userEvaluator.js";
import { getUserIntelligence } from "../repositories/unifiedIntelligence.repository.js";

const DEFAULT_WORKSPACE_NAME = "Apyhub";
const DEFAULT_USER_SEARCH = "Sukhjinder";

function avg(values = []) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return 0;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function round(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function compact(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function score(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

async function resolveWorkspace({ workspaceId = null, workspaceName = DEFAULT_WORKSPACE_NAME } = {}) {
  if (workspaceId) {
    const { rows } = await pool.query(
      `SELECT id, name, plan, billing_plan, is_active, status, created_at
       FROM workspaces
       WHERE id = $1
       LIMIT 1`,
      [workspaceId]
    );
    if (!rows[0]) {
      const err = new Error(`Workspace not found for id ${workspaceId}`);
      err.code = "TRACE_WORKSPACE_NOT_FOUND";
      throw err;
    }
    return { selected: rows[0], candidates: rows };
  }

  const { rows } = await pool.query(
    `SELECT id, name, plan, billing_plan, is_active, status, created_at
     FROM workspaces
     WHERE LOWER(name) = LOWER($1)
        OR LOWER(name) LIKE LOWER($2)
     ORDER BY
       CASE WHEN name = $1 THEN 0 ELSE 1 END,
       created_at ASC`,
    [workspaceName, `%${workspaceName}%`]
  );
  if (!rows[0]) {
    const err = new Error(`Workspace not found for ${workspaceName}`);
    err.code = "TRACE_WORKSPACE_NOT_FOUND";
    throw err;
  }
  return { selected: rows[0], candidates: rows };
}

async function resolveUser({ workspaceId, userId = null, userSearch = DEFAULT_USER_SEARCH } = {}) {
  if (userId) {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.email, u.role, u.workspace_id, wu.role AS workspace_role, u.created_at
       FROM users u
       LEFT JOIN workspace_users wu ON wu.user_id = u.id AND wu.workspace_id = u.workspace_id
       WHERE u.workspace_id = $1 AND u.id = $2
       LIMIT 1`,
      [workspaceId, userId]
    );
    if (!rows[0]) {
      const err = new Error(`User not found for id ${userId}`);
      err.code = "TRACE_USER_NOT_FOUND";
      throw err;
    }
    return { selected: rows[0], candidates: rows };
  }

  const search = String(userSearch || DEFAULT_USER_SEARCH).trim();
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.email, u.role, u.workspace_id, wu.role AS workspace_role, u.created_at
     FROM users u
     LEFT JOIN workspace_users wu ON wu.user_id = u.id AND wu.workspace_id = u.workspace_id
     WHERE u.workspace_id = $1
       AND (
         LOWER(u.username) = LOWER($2)
         OR LOWER(u.username) LIKE LOWER($3)
         OR LOWER(u.email) LIKE LOWER($3)
       )
     ORDER BY
       CASE WHEN LOWER(u.username) = LOWER($2) THEN 0 ELSE 1 END,
       u.created_at ASC`,
    [workspaceId, search, `%${search}%`]
  );
  if (!rows[0]) {
    const err = new Error(`User not found for ${search}`);
    err.code = "TRACE_USER_NOT_FOUND";
    throw err;
  }
  return { selected: rows[0], candidates: rows };
}

function domainRow(dimensions, key, label) {
  const domain = dimensions?.[key] || {};
  return {
    key,
    label,
    score: score(domain.score),
    confidence: score(domain.confidence),
    metrics: domain.metrics || {},
    drivers: domain.drivers || [],
    strengths: domain.strengths || [],
    concerns: domain.concerns || [],
  };
}

function scoreCompositionFromPersistedUser(user) {
  const dimensions = user?.dimensions || {};
  const attendance = user?.attendance || {};
  const rows = [
    domainRow(dimensions, "executionReliability", "Execution Reliability"),
    domainRow(dimensions, "deliveryEffectiveness", "Delivery Effectiveness"),
    domainRow(dimensions, "collaborationHealth", "Collaboration Health"),
    domainRow(dimensions, "workSustainability", "Work Sustainability"),
    domainRow(dimensions, "professionalDiscipline", "Professional Discipline"),
  ];

  const primaryRows = rows.filter((row) => row.key !== "professionalDiscipline");
  const professional = rows.find((row) => row.key === "professionalDiscipline");
  const confidenceAverage = avg(rows.map((row) => row.confidence));
  const coreScore = adaptiveScore(primaryRows.map((row) => ({ value: row.score })), {
    confidence: confidenceAverage,
  });
  const attendanceScore = score(attendance.score);
  const attendanceDrag = attendanceScore < 45 && coreScore > 70
    ? Math.min(8, (45 - attendanceScore) / 2)
    : 0;
  const attendanceLift = attendanceScore > 82 && coreScore < 62 ? 2 : 0;
  const finalRaw = (coreScore * 0.82) + ((professional?.score || 0) * 0.18) - attendanceDrag + attendanceLift;
  const finalScore = roundScore(finalRaw);

  const professionalMetrics = professional?.metrics || {};
  const professionalWithoutAttendance = adaptiveScore([
    { value: professionalMetrics.reviewCompletion },
    { value: professionalMetrics.updateHygiene },
    { value: professionalMetrics.workflowScore },
  ], { confidence: professional?.confidence ?? 75 });
  const finalWithoutAttendanceSignalRaw = (coreScore * 0.82) + (professionalWithoutAttendance * 0.18);
  const finalWithoutAttendanceSignal = roundScore(finalWithoutAttendanceSignalRaw);

  const professionalWithNeutralAttendance = adaptiveScore([
    { value: 60 },
    { value: professionalMetrics.reviewCompletion },
    { value: professionalMetrics.updateHygiene },
    { value: professionalMetrics.workflowScore },
  ], { confidence: professional?.confidence ?? 75 });
  const finalWithNeutralAttendanceRaw = (coreScore * 0.82) + (professionalWithNeutralAttendance * 0.18);
  const finalWithNeutralAttendance = roundScore(finalWithNeutralAttendanceRaw);

  return {
    formulaPath:
      "roundScore((coreScore * 0.82) + (professionalDiscipline * 0.18) - attendanceDrag + attendanceLift)",
    persistedFinalScore: score(user.score),
    reconstructedFinalScore: finalScore,
    reconstructedRawScore: round(finalRaw),
    coreScore,
    professionalDisciplineScore: professional?.score ?? null,
    confidenceAverage: round(confidenceAverage),
    attendanceScore,
    attendanceDrag: round(attendanceDrag),
    attendanceLift: round(attendanceLift),
    primaryDomains: primaryRows,
    professionalDiscipline: professional,
    attendanceContribution: {
      attendanceScore,
      enteredThrough: [
        "user_intelligence.attendance.score",
        "user_intelligence.dimensions.professionalDiscipline.metrics.attendanceScore",
        "userEvaluator attendance lift/drag rule",
      ],
      professionalWithAttendance: professional?.score ?? null,
      professionalWithoutAttendanceSignal: professionalWithoutAttendance,
      professionalWithNeutralAttendance,
      finalWithAttendance: finalScore,
      finalWithoutAttendanceSignal,
      finalWithNeutralAttendance,
      effectiveFinalLiftVsNoAttendanceSignal: finalScore - finalWithoutAttendanceSignal,
      effectiveFinalLiftVsNeutralAttendance: finalScore - finalWithNeutralAttendance,
      directAttendanceAdjustment: round(attendanceLift - attendanceDrag),
      materiallyAffectsScore: Math.abs(finalScore - finalWithoutAttendanceSignal) > 0,
      explanation:
        "Attendance is not cosmetic. It enters the Professional Discipline domain and may also add a bounded lift/drag. It does not override weak execution domains.",
    },
  };
}

async function loadSourceRow({ workspaceId, userId }) {
  const { rows } = await pool.query(
    `SELECT ui.id, ui.workspace_id, ui.user_id, ui.score, ui.band, ui.confidence,
            ui.evidence_hash, ui.calculation_version, ui.last_evaluated_at,
            ui.source_window, ui.created_at, ui.updated_at
     FROM user_intelligence ui
     WHERE ui.workspace_id = $1 AND ui.user_id = $2
     LIMIT 1`,
    [workspaceId, userId]
  );
  return rows[0] || null;
}

async function loadTaskEvidenceSummary({ workspaceId, userId, coverageStart, coverageEnd }) {
  const start = coverageStart ? `${coverageStart}T00:00:00.000Z` : new Date(Date.now() - 30 * 86400000).toISOString();
  const end = coverageEnd ? `${coverageEnd}T23:59:59.999Z` : new Date().toISOString();
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total_tasks,
       COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) IN ('completed', 'done', 'closed'))::int AS completed_tasks,
       COUNT(*) FILTER (WHERE due_date IS NOT NULL)::int AS due_date_tracked_tasks,
       COUNT(*) FILTER (
         WHERE due_date IS NOT NULL
           AND completed_at IS NOT NULL
           AND completed_at <= due_date
           AND LOWER(COALESCE(status, '')) IN ('completed', 'done', 'closed')
       )::int AS on_time_completed_tasks,
       COUNT(*) FILTER (
         WHERE due_date IS NOT NULL
           AND due_date < $4::timestamptz
           AND LOWER(COALESCE(status, '')) NOT IN ('completed', 'done', 'closed', 'cancelled')
       )::int AS overdue_open_tasks
     FROM tasks
     WHERE workspace_id = $1
       AND assigned_to = $2
       AND created_at <= $4::timestamptz
       AND (
         created_at >= $3::timestamptz
         OR updated_at >= $3::timestamptz
         OR LOWER(COALESCE(status, '')) NOT IN ('completed', 'done', 'closed', 'cancelled')
       )`,
    [workspaceId, userId, start, end]
  );
  return {
    ...(rows[0] || {}),
    coverageStart,
    coverageEnd,
    source: "tasks_filtered_to_user_intelligence_source_window",
  };
}

function cardAuthorityMap() {
  return [
    {
      field: "overall score",
      apiField: "score",
      authority: "user_intelligence.score",
      path: "GET /intelligence/user/performance -> getUserPerformance -> buildUserPerformanceResponse -> getUnifiedIntelligenceSnapshot -> getUserIntelligence",
      inlineScoreCalculation: false,
      legacyPath: false,
    },
    {
      field: "attendance evidence bar",
      apiField: "breakdown.attendanceScore",
      authority: "user_intelligence.attendance.score",
      path: "buildUserPerformanceResponse maps currentUser.attendance.score",
      inlineScoreCalculation: false,
      legacyPath: false,
    },
    {
      field: "productivity evidence bar",
      apiField: "breakdown.productivityScore",
      authority: "user_intelligence.dimensions.deliveryEffectiveness.score",
      path: "buildUserPerformanceResponse maps currentUser.dimensions.deliveryEffectiveness.score",
      inlineScoreCalculation: false,
      legacyPath: false,
    },
    {
      field: "risk badge",
      apiField: "intelligence.risk.level",
      authority: "user_intelligence.risk.level",
      path: "buildUserPerformanceResponse maps currentUser.risk",
      inlineScoreCalculation: false,
      legacyPath: false,
    },
    {
      field: "delta",
      apiField: "frontend delta from /intelligence/user/trend series",
      authority: "intelligence_snapshots for scope_type='user'",
      path: "Dashboard.jsx compares current score against the previous trend series point",
      inlineScoreCalculation: "rendering delta only, not score authority",
      legacyPath: false,
    },
    {
      field: "evidence text",
      apiField: "explanation",
      authority: "user_intelligence.drivers",
      path: "buildUserPerformanceResponse joins the first two currentUser.drivers",
      inlineScoreCalculation: false,
      legacyPath: false,
    },
  ];
}

export async function traceUserScoreForWorkspace({
  workspaceId = null,
  workspaceName = DEFAULT_WORKSPACE_NAME,
  userId = null,
  userSearch = DEFAULT_USER_SEARCH,
  includeRecomputed = true,
} = {}) {
  const workspaceResolution = await resolveWorkspace({ workspaceId, workspaceName });
  const workspace = workspaceResolution.selected;
  const userResolution = await resolveUser({
    workspaceId: workspace.id,
    userId,
    userSearch,
  });
  const user = userResolution.selected;
  const role = user.workspace_role || user.role || "user";

  const [performanceCard, trend, userIntelligence, sourceRow] = await Promise.all([
    buildUserPerformanceResponse({
      workspaceId: workspace.id,
      userId: user.id,
      role,
      month: new Date().toISOString().slice(0, 7),
    }),
    buildUserTrendResponse({
      workspaceId: workspace.id,
      userId: user.id,
      role,
      range: "30d",
    }),
    getUserIntelligence({ workspaceId: workspace.id, userId: user.id }),
    loadSourceRow({ workspaceId: workspace.id, userId: user.id }),
  ]);

  const composition = scoreCompositionFromPersistedUser(userIntelligence);
  const taskSummary = await loadTaskEvidenceSummary({
    workspaceId: workspace.id,
    userId: user.id,
    coverageStart: userIntelligence?.coverageStart,
    coverageEnd: userIntelligence?.coverageEnd,
  });
  const series = trend?.series || trend?.rows || [];
  const previousPoint = series.length >= 2 ? series[series.length - 2] : null;
  const currentPoint = series.length >= 1 ? series[series.length - 1] : null;

  let recomputed = null;
  if (includeRecomputed) {
    try {
      const evidence = await collectUserEvidence({
        workspaceId: workspace.id,
        userId: user.id,
        windowDays: 30,
      });
      const evaluated = evaluateUserIntelligence(evidence);
      recomputed = {
        score: evaluated.score,
        attendanceScore: evaluated.attendance?.score ?? null,
        deliveryEffectiveness: evaluated.dimensions?.deliveryEffectiveness?.score ?? null,
        executionReliability: evaluated.dimensions?.executionReliability?.score ?? null,
        evidenceHash: evaluated.evidenceHash,
        matchesPersistedScore: evaluated.score === userIntelligence.score,
        source: "non_persisted_recalculation_from_live_evidence",
      };
    } catch (err) {
      recomputed = {
        source: "non_persisted_recalculation_from_live_evidence",
        error: err.message,
        code: err.code || null,
      };
    }
  }

  return {
    source: "enterprise_intelligence_user_score_trace",
    generatedAt: new Date().toISOString(),
    workspaceResolution: {
      selected: workspace,
      candidates: workspaceResolution.candidates,
    },
    userResolution: {
      selected: user,
      candidates: userResolution.candidates,
    },
    displayedCard: {
      endpoint: "GET /intelligence/user/performance",
      score: performanceCard?.score ?? null,
      riskLevel: performanceCard?.intelligence?.risk?.level ?? null,
      attendanceBar: performanceCard?.breakdown?.attendanceScore ?? null,
      productivityBar: performanceCard?.breakdown?.productivityScore ?? null,
      explanation: performanceCard?.explanation ?? null,
      computedAt: performanceCard?.computedAt ?? null,
      coverageStart: performanceCard?.coverageStart ?? null,
      coverageEnd: performanceCard?.coverageEnd ?? null,
      attendanceClosedThroughDate: performanceCard?.attendanceClosedThroughDate ?? null,
      scoreExplanation: performanceCard?.scoreExplanation ?? null,
    },
    sourceRow: compact(sourceRow),
    fieldAuthorityMap: cardAuthorityMap(),
    persistedUserIntelligence: {
      id: userIntelligence?.id || null,
      score: userIntelligence?.score ?? null,
      band: userIntelligence?.band || null,
      confidence: userIntelligence?.confidence ?? null,
      risk: userIntelligence?.risk || null,
      dimensions: userIntelligence?.dimensions || null,
      attendance: userIntelligence?.attendance || null,
      drivers: userIntelligence?.drivers || [],
      strengths: userIntelligence?.strengths || [],
      concerns: userIntelligence?.concerns || [],
      computedAt: userIntelligence?.computedAt || null,
      coverageStart: userIntelligence?.coverageStart || null,
      coverageEnd: userIntelligence?.coverageEnd || null,
      attendanceClosedThroughDate: userIntelligence?.attendanceClosedThroughDate || null,
      calculationVersion: userIntelligence?.calculationVersion || null,
      evidenceHash: userIntelligence?.evidenceHash || null,
    },
    exactScoreComposition: composition,
    trendDelta: {
      source: "intelligence_snapshots",
      frontendLabelBeforeFix: "vs last month",
      correctedLabel: "vs previous intelligence point",
      previousPoint,
      currentPoint,
      delta: previousPoint ? round((performanceCard?.score ?? 0) - Number(previousPoint.score || 0)) : null,
    },
    taskEvidenceSummary: taskSummary,
    recomputedFromCurrentEvidence: recomputed,
    mismatchExplanation: {
      answer:
        "Attendance and Delivery Effectiveness are evidence/domain scores. The final score is the persisted canonical user_intelligence.score, reconstructed from execution reliability, delivery effectiveness, collaboration health, work sustainability, professional discipline, and bounded attendance adjustment.",
      uiWasMisleading:
        "Partially. Showing 'Attendance' and 'Productivity' beside the final score without saying they are evidence dimensions could imply the final score should average near those bars.",
    },
  };
}

export default {
  traceUserScoreForWorkspace,
};
