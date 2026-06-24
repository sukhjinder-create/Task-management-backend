import pool from "../../db.js";
import { getDashboardOverviewFromIntelligence } from "./unifiedDashboard.adapter.js";

const DEFAULT_RANGES = ["30d", "90d", "6m", "1y", "all"];

async function listVerificationCandidates({ workspaceId = null, limit = 10 } = {}) {
  const params = [];
  const workspaceClause = workspaceId ? "WHERE d.workspace_id = $1" : "";
  if (workspaceId) params.push(workspaceId);

  const { rows } = await pool.query(
    `
    WITH dates AS (
      SELECT workspace_id, created_at::date AS evidence_date FROM tasks WHERE workspace_id IS NOT NULL
      UNION ALL
      SELECT workspace_id, COALESCE(completed_at, updated_at, created_at)::date AS evidence_date FROM tasks WHERE workspace_id IS NOT NULL
      UNION ALL
      SELECT workspace_id, created_at::date AS evidence_date FROM projects WHERE workspace_id IS NOT NULL
      UNION ALL
      SELECT workspace_id, date::date AS evidence_date FROM attendance_daily WHERE workspace_id IS NOT NULL
      UNION ALL
      SELECT workspace_id, log_date::date AS evidence_date FROM time_logs WHERE workspace_id IS NOT NULL
    ),
    spans AS (
      SELECT
        workspace_id,
        MIN(evidence_date)::text AS first_evidence_date,
        MAX(evidence_date)::text AS last_evidence_date,
        COUNT(DISTINCT evidence_date)::int AS distinct_evidence_days
      FROM dates
      WHERE evidence_date IS NOT NULL
      GROUP BY workspace_id
    ),
    admins AS (
      SELECT DISTINCT ON (wu.workspace_id)
        wu.workspace_id,
        wu.user_id AS admin_user_id
      FROM workspace_users wu
      JOIN users u ON u.id = wu.user_id
      WHERE COALESCE(wu.role, u.role) IN ('admin', 'super_admin', 'platform_admin')
      ORDER BY wu.workspace_id, wu.created_at ASC NULLS LAST
    )
    SELECT
      d.workspace_id,
      d.first_evidence_date,
      d.last_evidence_date,
      d.distinct_evidence_days,
      a.admin_user_id
    FROM spans d
    JOIN admins a ON a.workspace_id = d.workspace_id
    ${workspaceClause}
    ORDER BY d.distinct_evidence_days DESC, d.last_evidence_date DESC
    LIMIT ${Math.max(1, Math.min(25, Number(limit) || 10))}
    `,
    params
  );
  return rows;
}

function lineCharts(overview) {
  return (overview?.visualizations?.charts || []).filter((chart) => chart.type === "line");
}

function summaryKey(overview) {
  return overview?.executiveSummary?.persistence?.summaryId || overview?.executiveSummary?.summaryId || null;
}

function addFailure(failures, condition, message, details = {}) {
  if (!condition) failures.push({ message, details });
}

async function verifyCandidate(candidate, ranges = DEFAULT_RANGES) {
  const failures = [];
  const periodKeys = new Set();
  const rangeResults = [];

  for (const range of ranges) {
    const first = await getDashboardOverviewFromIntelligence({
      workspaceId: candidate.workspace_id,
      userId: candidate.admin_user_id,
      role: "admin",
      range,
    });
    const second = await getDashboardOverviewFromIntelligence({
      workspaceId: candidate.workspace_id,
      userId: candidate.admin_user_id,
      role: "admin",
      range,
    });

    const charts = lineCharts(first);
    const sparseCharts = charts.filter((chart) => chart.pointCount < 2);
    const firstSummaryId = summaryKey(first);
    const secondSummaryId = summaryKey(second);
    const periodKey = first.executiveSummary?.persistence?.periodKey || first.executiveSummary?.summaryBucket?.periodKey || null;
    if (periodKey) periodKeys.add(periodKey);

    addFailure(failures, charts.length > 0, "Dashboard overview must expose line charts", { range });
    addFailure(
      failures,
      sparseCharts.length === 0,
      "Dashboard range still has sparse line charts after materialization",
      { range, sparseCharts: sparseCharts.map((chart) => ({ key: chart.key, pointCount: chart.pointCount })) }
    );
    addFailure(failures, Boolean(firstSummaryId), "First request must return persisted summary id", { range });
    addFailure(
      failures,
      Boolean(secondSummaryId) && firstSummaryId === secondSummaryId,
      "Second request must reuse the same persisted summary bucket",
      { range, firstSummaryId, secondSummaryId }
    );

    rangeResults.push({
      range,
      dashboardRange: first.dashboardRange,
      lineCharts: charts.map((chart) => ({ key: chart.key, pointCount: chart.pointCount, sparse: chart.sparse })),
      historyMaterialization: first.analytics?.historyMaterialization || null,
      summary: {
        summaryId: firstSummaryId,
        reusedOnSecondRequest: firstSummaryId === secondSummaryId,
        periodKey,
        snapshotCount: first.executiveSummary?.metrics?.snapshotCount || null,
        headline: first.executiveSummary?.headline || null,
      },
    });
  }

  addFailure(
    failures,
    periodKeys.size >= ranges.length,
    "Each dashboard range must have its own stable summary period bucket",
    { periodKeys: [...periodKeys], ranges }
  );

  return {
    workspaceId: candidate.workspace_id,
    adminUserId: candidate.admin_user_id,
    evidence: {
      firstEvidenceDate: candidate.first_evidence_date,
      lastEvidenceDate: candidate.last_evidence_date,
      distinctEvidenceDays: candidate.distinct_evidence_days,
    },
    ranges: rangeResults,
    failures,
  };
}

export async function verifyDashboardHistoryMaterialization({ workspaceId = null, limit = 3, ranges = DEFAULT_RANGES } = {}) {
  const candidates = await listVerificationCandidates({ workspaceId, limit: Math.max(limit, 1) });
  const checked = [];
  for (const candidate of candidates) {
    if (Number(candidate.distinct_evidence_days) < 2) continue;
    checked.push(await verifyCandidate(candidate, ranges));
    if (checked.length >= limit) break;
  }

  const failures = checked.flatMap((result) =>
    result.failures.map((failure) => ({ workspaceId: result.workspaceId, ...failure }))
  );

  return {
    status: checked.length === 0 ? "skipped" : failures.length ? "failed" : "passed",
    checkedWorkspaceCount: checked.length,
    failures,
    results: checked,
  };
}

export default {
  verifyDashboardHistoryMaterialization,
};
