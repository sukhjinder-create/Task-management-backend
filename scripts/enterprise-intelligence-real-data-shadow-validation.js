import fs from "node:fs";
import path from "node:path";
import pool from "../db.js";

const docsDir = path.join(process.cwd(), "docs", "enterprise-intelligence");
const outputPath = path.join(docsDir, "real-data-shadow-validation-output.json");
const representativeDatasetPath = path.join(docsDir, "representative-workspace-shadow-dataset.json");

const connectivityErrorCodes = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENETUNREACH",
]);

function baseResult() {
  return {
    generatedAt: new Date().toISOString(),
    status: "unknown",
    readiness: "not_evaluated",
    source: null,
    tables: {},
    coverage: {},
    samples: {},
    anomalies: {},
    findings: [],
  };
}

async function tableExists(tableName) {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return Boolean(rows[0]?.exists);
}

function summarizeDeltas(rows = []) {
  const comparable = rows.filter((row) => row.legacy_score != null && row.new_score != null);
  const largeDeltas = comparable
    .map((row) => ({
      ...row,
      delta_abs: Math.abs(Number(row.delta) || 0),
    }))
    .filter((row) => row.delta_abs >= 25)
    .slice(0, 10);
  const contradictions = comparable
    .filter((row) => (
      (Number(row.new_score) >= 75 && Number(row.legacy_score) < 50) ||
      (Number(row.new_score) < 50 && Number(row.legacy_score) >= 75)
    ))
    .slice(0, 10);

  return {
    comparable: comparable.length,
    largeDeltaCount: largeDeltas.length,
    contradictionCount: contradictions.length,
    largeDeltas,
    contradictions,
  };
}

function compareScores({ unifiedRows = [], legacyRows = [], idKey, nameKey = null }) {
  const legacyById = new Map(legacyRows.map((row) => [String(row[idKey]), row]));
  const rows = unifiedRows.map((row) => {
    const legacy = legacyById.get(String(row[idKey]));
    const newScore = Number(row.score);
    const legacyScore = legacy?.legacyScore == null ? null : Number(legacy.legacyScore);
    return {
      [idKey]: row[idKey],
      ...(nameKey ? { [nameKey]: row[nameKey] || legacy?.[nameKey] || null } : {}),
      new_score: Number.isFinite(newScore) ? newScore : null,
      legacy_score: Number.isFinite(legacyScore) ? legacyScore : null,
      delta: Number.isFinite(newScore) && Number.isFinite(legacyScore)
        ? Math.round((newScore - legacyScore) * 100) / 100
        : null,
      band: row.band || null,
      risk_level: row.risk?.level || null,
      confidence: row.confidence ?? null,
      computed_at: row.computedAt || null,
    };
  });

  return {
    rows,
    summary: summarizeDeltas(rows),
  };
}

function analyzeAttendance(users = []) {
  const anomalies = [];
  const rows = users.map((user) => {
    const metrics = user.attendance?.metrics || {};
    const indicators = user.attendance?.indicators || [];
    const nonWorkingAttendance = Number(metrics.nonWorkingAttendanceDays) || 0;
    const meaningful = Number(metrics.nonWorkingMeaningfulDeliveryDays) || 0;
    const informational = Number(metrics.nonWorkingInformationalDays) || 0;
    const bonus = Number(metrics.exceptionalContributionBonus) || 0;
    const row = {
      userId: user.userId,
      username: user.username,
      score: user.attendance?.score ?? null,
      expectedWorkingDays: metrics.expectedWorkingDays ?? null,
      approvedLeaveDays: metrics.approvedLeaveDays ?? null,
      approvedHalfDays: metrics.approvedHalfDays ?? null,
      nonWorkingAttendanceDays: nonWorkingAttendance,
      nonWorkingMeaningfulDeliveryDays: meaningful,
      nonWorkingInformationalDays: informational,
      exceptionalContributionBonus: bonus,
      burnoutRiskLevel: metrics.burnoutRiskLevel || null,
      attendanceClosedThroughDate: user.attendanceClosedThroughDate || null,
      indicators,
    };

    if (metrics.nonWorkingPenaltyApplied === true) {
      anomalies.push({
        type: "non_working_day_penalty",
        severity: "blocker",
        userId: user.userId,
        message: "Non-working day attendance was marked as penalized.",
      });
    }
    if (bonus > 4) {
      anomalies.push({
        type: "exceptional_contribution_bonus_unbounded",
        severity: "blocker",
        userId: user.userId,
        message: "Exceptional contribution bonus exceeds bounded recognition cap.",
      });
    }
    if (nonWorkingAttendance > 0 && meaningful + informational !== nonWorkingAttendance) {
      anomalies.push({
        type: "non_working_day_classification_gap",
        severity: "review",
        userId: user.userId,
        message: "Non-working day attendance was not fully classified as meaningful or informational.",
      });
    }
    return row;
  });

  return { rows, anomalies };
}

function analyzeProjects(projects = []) {
  const anomalies = [];
  const rows = projects.map((project) => {
    const indexes = project.indexes || {};
    if (Number(project.score) >= 75 && Number(indexes.completionConfidence) < 55) {
      anomalies.push({
        type: "project_score_confidence_contradiction",
        severity: "blocker",
        projectId: project.projectId,
        message: "Project has a strong score but weak completion confidence.",
      });
    }
    if (Number(project.score) >= 75 && Number(indexes.dependencyRisk) < 55) {
      anomalies.push({
        type: "project_dependency_contradiction",
        severity: "review",
        projectId: project.projectId,
        message: "Project has a strong score while dependency health is weak.",
      });
    }
    return {
      projectId: project.projectId,
      projectName: project.projectName,
      score: project.score,
      completionConfidence: indexes.completionConfidence ?? null,
      dependencyRisk: indexes.dependencyRisk ?? null,
      executionMomentum: indexes.executionMomentum ?? null,
      riskLevel: project.risk?.level || null,
    };
  });
  return { rows, anomalies };
}

function analyzeWorkspace({ workspace, users = [], projects = [], teams = [] }) {
  const anomalies = [];
  const userAverage = users.length
    ? Math.round((users.reduce((sum, user) => sum + Number(user.score || 0), 0) / users.length) * 100) / 100
    : null;
  const projectAverage = projects.length
    ? Math.round((projects.reduce((sum, project) => sum + Number(project.score || 0), 0) / projects.length) * 100) / 100
    : null;
  const teamAverage = teams.length
    ? Math.round((teams.reduce((sum, team) => sum + Number(team.score || 0), 0) / teams.length) * 100) / 100
    : null;

  if (workspace?.score != null && userAverage != null && Math.abs(Number(workspace.score) - userAverage) > 30) {
    anomalies.push({
      type: "workspace_user_aggregate_gap",
      severity: "review",
      message: "Workspace score is far away from average user score.",
    });
  }
  if (workspace?.risk?.level === "Low" && users.some((user) => user.risk?.level === "High")) {
    anomalies.push({
      type: "workspace_risk_masking",
      severity: "review",
      message: "Workspace risk is low while at least one user is high risk.",
    });
  }

  return {
    row: {
      workspaceId: workspace?.workspaceId || null,
      score: workspace?.score ?? null,
      band: workspace?.band || null,
      riskLevel: workspace?.risk?.level || null,
      confidence: workspace?.confidence ?? null,
      userAverage,
      projectAverage,
      teamAverage,
      computedAt: workspace?.computedAt || null,
    },
    anomalies,
  };
}

function analyzeTeamComparison({ derivedRows = [], users = [], teams = [] }) {
  const anomalies = [];
  const userById = new Map(users.map((user) => [String(user.userId), user]));
  const rows = derivedRows.map((row) => {
    const user = userById.get(String(row.userId));
    if (!user) {
      anomalies.push({
        type: "team_comparison_missing_user_authority",
        severity: "blocker",
        userId: row.userId,
        message: "Derived team comparison row has no matching user_intelligence authority row.",
      });
    } else if (Number(row.score) !== Number(user.score)) {
      anomalies.push({
        type: "team_comparison_score_mismatch",
        severity: "blocker",
        userId: row.userId,
        message: "Derived team comparison row score differs from user_intelligence score.",
      });
    }
    return {
      userId: row.userId,
      username: row.username,
      score: row.score,
      authorityScore: user?.score ?? null,
      classification: "derived_user_comparison",
    };
  });

  return {
    classification: {
      surfaceClassification: "derived_user_comparison",
      scoreAuthority: "user_intelligence",
      canonicalTeamAuthority: "team_intelligence",
      teamScoreAuthority: false,
      canonicalTeamRowsAvailable: teams.length,
    },
    rows,
    anomalies,
  };
}

function analyzeSnapshots(snapshots = [], expectedSubjects = []) {
  const snapshotKeys = new Set(snapshots.map((snapshot) => `${snapshot.scopeType}:${snapshot.subjectKey}`));
  const missing = expectedSubjects.filter((subject) => !snapshotKeys.has(`${subject.scopeType}:${subject.subjectKey}`));
  return {
    totalSnapshots: snapshots.length,
    missing,
    anomalies: missing.map((subject) => ({
      type: "missing_snapshot",
      severity: "blocker",
      subject,
      message: "Expected historical snapshot is missing for representative subject.",
    })),
  };
}

function severityCounts(anomalyGroups) {
  const counts = { blocker: 0, review: 0, info: 0 };
  for (const group of Object.values(anomalyGroups)) {
    for (const anomaly of group?.anomalies || []) {
      counts[anomaly.severity] = (counts[anomaly.severity] || 0) + 1;
    }
  }
  return counts;
}

function runRepresentativeDatasetValidation(dbError) {
  const result = baseResult();
  const dataset = JSON.parse(fs.readFileSync(representativeDatasetPath, "utf8"));
  const unified = dataset.unified || {};
  const legacy = dataset.legacy || {};

  result.source = {
    type: "local_representative_seeded_workspace_snapshot",
    path: representativeDatasetPath,
    datasetName: dataset.metadata?.name || null,
    workspaceId: dataset.workspace?.workspaceId || null,
    fallbackReason: "configured_database_unreachable",
    originalDatabaseError: dbError ? { message: dbError.message, code: dbError.code || null } : null,
    limitations: [
      "Representative seeded workspace data, not live production rows.",
      "Validates schema contracts, score sanity, cutover classifications, and anomaly rules locally.",
    ],
  };
  result.tables = {
    user_intelligence: "file_backed_representative",
    project_intelligence: "file_backed_representative",
    team_intelligence: "file_backed_representative",
    workspace_intelligence: "file_backed_representative",
    intelligence_snapshots: "file_backed_representative",
    workspace_monthly_scores: "file_backed_legacy_reference",
    workspace_project_monthly_scores: "file_backed_legacy_reference",
  };
  result.coverage = dataset.coverage || {};

  result.samples.users = compareScores({
    unifiedRows: unified.users || [],
    legacyRows: legacy.users || [],
    idKey: "userId",
    nameKey: "username",
  });
  result.samples.projects = compareScores({
    unifiedRows: unified.projects || [],
    legacyRows: legacy.projects || [],
    idKey: "projectId",
    nameKey: "projectName",
  });
  result.samples.workspaces = compareScores({
    unifiedRows: unified.workspace ? [unified.workspace] : [],
    legacyRows: legacy.workspace ? [legacy.workspace] : [],
    idKey: "workspaceId",
  });

  result.anomalies.attendance = analyzeAttendance(unified.users || []);
  result.anomalies.projects = analyzeProjects(unified.projects || []);
  result.anomalies.workspace = analyzeWorkspace({
    workspace: unified.workspace,
    users: unified.users || [],
    projects: unified.projects || [],
    teams: unified.teams || [],
  });
  result.anomalies.teamComparison = analyzeTeamComparison({
    derivedRows: dataset.derivedTeamComparison?.rows || [],
    users: unified.users || [],
    teams: unified.teams || [],
  });
  result.anomalies.snapshots = analyzeSnapshots(
    unified.snapshots || [],
    dataset.expectedSnapshots || []
  );

  const issueCounts = [
    result.samples.users.summary.largeDeltaCount,
    result.samples.users.summary.contradictionCount,
    result.samples.projects.summary.largeDeltaCount,
    result.samples.projects.summary.contradictionCount,
    result.samples.workspaces.summary.largeDeltaCount,
    result.samples.workspaces.summary.contradictionCount,
  ].reduce((sum, count) => sum + count, 0);
  const counts = severityCounts(result.anomalies);

  if (issueCounts > 0 || counts.blocker > 0) {
    result.status = "completed_with_findings";
    result.readiness = "review_required_before_cutover";
    result.findings.push(`${issueCounts} large delta/contradiction issue(s), ${counts.blocker} blocker anomaly/anomalies.`);
  } else {
    result.status = counts.review > 0 ? "completed_with_review_notes" : "completed";
    result.readiness = "representative_seeded_workspace_validation_passed_for_staged_cutover";
    result.findings.push("Representative workspace validation completed with no large deltas, contradictions, or blocker anomalies.");
  }

  if (counts.review > 0) {
    result.findings.push(`${counts.review} review-level anomaly/anomalies should be watched during staged cutover.`);
  }

  return result;
}

async function runDatabaseValidation() {
  const result = baseResult();
  result.source = {
    type: "reachable_database",
    limitations: [],
  };

  const requiredTables = [
    "user_intelligence",
    "project_intelligence",
    "team_intelligence",
    "workspace_intelligence",
    "intelligence_snapshots",
    "workspace_monthly_scores",
    "workspace_project_monthly_scores",
  ];

  for (const table of requiredTables) {
    result.tables[table] = await tableExists(table);
  }

  const missingUnified = ["user_intelligence", "project_intelligence", "team_intelligence", "workspace_intelligence"]
    .filter((table) => !result.tables[table]);
  if (missingUnified.length) {
    result.status = "blocked";
    result.readiness = "blocked_missing_unified_tables";
    result.findings.push(`Missing unified table(s): ${missingUnified.join(", ")}`);
    return result;
  }

  if (!result.tables.workspace_monthly_scores || !result.tables.workspace_project_monthly_scores) {
    result.status = "partial";
    result.readiness = "shadow_comparison_limited_legacy_tables_missing";
    result.findings.push("Legacy monthly score tables are unavailable; only unified row sanity can be checked.");
  }

  if (result.tables.workspace_monthly_scores) {
    const { rows } = await pool.query(
      `SELECT
         ui.workspace_id::text,
         ui.user_id::text,
         u.username,
         ui.score AS new_score,
         wms.score AS legacy_score,
         ui.score - wms.score AS delta,
         ui.last_evaluated_at AS new_computed_at,
         wms.month AS legacy_month
       FROM user_intelligence ui
       LEFT JOIN users u ON u.id = ui.user_id
       LEFT JOIN workspace_monthly_scores wms
         ON wms.workspace_id = ui.workspace_id
        AND wms.user_id = ui.user_id
        AND wms.month = to_char(CURRENT_DATE, 'YYYY-MM')
       ORDER BY ABS(ui.score - COALESCE(wms.score, ui.score)) DESC NULLS LAST
       LIMIT 25`
    );
    result.samples.users = {
      rows,
      summary: summarizeDeltas(rows),
    };
  }

  if (result.tables.workspace_project_monthly_scores) {
    const { rows } = await pool.query(
      `SELECT
         pi.workspace_id::text,
         pi.project_id::text,
         p.name AS project_name,
         pi.score AS new_score,
         wpms.score AS legacy_score,
         pi.score - wpms.score AS delta,
         pi.last_evaluated_at AS new_computed_at,
         wpms.month AS legacy_month
       FROM project_intelligence pi
       LEFT JOIN projects p ON p.id = pi.project_id
       LEFT JOIN workspace_project_monthly_scores wpms
         ON wpms.workspace_id = pi.workspace_id
        AND wpms.project_id = pi.project_id
        AND wpms.month = to_char(CURRENT_DATE, 'YYYY-MM')
       ORDER BY ABS(pi.score - COALESCE(wpms.score, pi.score)) DESC NULLS LAST
       LIMIT 25`
    );
    result.samples.projects = {
      rows,
      summary: summarizeDeltas(rows),
    };
  }

  const { rows: workspaceRows } = await pool.query(
    `SELECT
       wi.workspace_id::text,
       wi.score AS new_workspace_score,
       wi.band,
       wi.confidence,
       wi.last_evaluated_at,
       wi.source_window,
       wi.indexes,
       wi.risk
     FROM workspace_intelligence wi
     ORDER BY wi.last_evaluated_at DESC
     LIMIT 10`
  );
  result.samples.workspaces = workspaceRows;

  const { rows: attendanceRows } = await pool.query(
    `SELECT
       workspace_id::text,
       user_id::text,
       score,
       attendance->'metrics' AS attendance_metrics,
       attendance->'indicators' AS attendance_indicators,
       last_evaluated_at
     FROM user_intelligence
     WHERE attendance IS NOT NULL
     ORDER BY last_evaluated_at DESC
     LIMIT 25`
  );
  result.samples.attendance = attendanceRows;

  const { rows: teamRows } = await pool.query(
    `SELECT
       workspace_id::text,
       team_key,
       manager_id::text,
       score,
       indexes,
       risk,
       last_evaluated_at
     FROM team_intelligence
     ORDER BY last_evaluated_at DESC
     LIMIT 25`
  );
  result.samples.teams = teamRows;

  const issueCounts = [
    result.samples.users?.summary?.largeDeltaCount || 0,
    result.samples.users?.summary?.contradictionCount || 0,
    result.samples.projects?.summary?.largeDeltaCount || 0,
    result.samples.projects?.summary?.contradictionCount || 0,
  ].reduce((sum, count) => sum + count, 0);

  if (issueCounts > 0) {
    result.status = result.status === "partial" ? "partial_with_findings" : "completed_with_findings";
    result.readiness = "review_required_before_cutover";
    result.findings.push(`${issueCounts} large delta or contradiction sample(s) require review.`);
  } else if (result.status === "partial") {
    result.findings.push("Unified intelligence sanity completed with limited legacy comparison.");
  } else {
    result.status = "completed";
    result.readiness = "shadow_validation_passed_for_sample";
    result.findings.push("No large deltas or contradictions found in sampled rows.");
  }

  return result;
}

async function run() {
  try {
    return await runDatabaseValidation();
  } catch (err) {
    if (connectivityErrorCodes.has(err.code)) {
      return runRepresentativeDatasetValidation(err);
    }
    const result = baseResult();
    result.status = "blocked";
    result.readiness = "blocked_database_validation_error";
    result.error = {
      message: err.message,
      code: err.code || null,
    };
    return result;
  }
}

try {
  const result = await run();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log("Enterprise intelligence real-data shadow validation", {
    status: result.status,
    readiness: result.readiness,
    source: result.source?.type,
    outputPath,
    findings: result.findings,
  });
  if (result.status === "blocked") {
    process.exitCode = 1;
  }
} finally {
  await pool.end().catch(() => {});
}
