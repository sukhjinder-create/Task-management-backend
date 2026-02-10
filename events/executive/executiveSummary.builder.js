import pool from "../../db.js";

/**
 * Builds executive-grade facts from admin insights
 */
export async function buildExecutiveSummaryData({
  workspaceId,
  month,
  previousMonth,
}) {
  const { rows: current } = await pool.query(
    `
    SELECT insight_type, data
    FROM workspace_admin_insights
    WHERE workspace_id = $1 AND period = $2
    `,
    [workspaceId, month]
  );

  const { rows: previous } = await pool.query(
    `
    SELECT insight_type, data
    FROM workspace_admin_insights
    WHERE workspace_id = $1 AND period = $2
    `,
    [workspaceId, previousMonth]
  );

  const currentMap = mapInsights(current);
  const previousMap = mapInsights(previous);

  return {
    period: month,
    scoreTrend: calculateScoreTrend(
      previousMap.ORG_SCORE_OVERVIEW,
      currentMap.ORG_SCORE_OVERVIEW
    ),
    riskTrend: calculateRiskTrend(
      previousMap.RISK_DISTRIBUTION,
      currentMap.RISK_DISTRIBUTION
    ),
    coachingROI: currentMap.COACHING_EFFECTIVENESS || {},
    focusAreas: deriveFocusAreas(currentMap),
  };
}

// ---------------- HELPERS ----------------

function mapInsights(rows = []) {
  return rows.reduce((acc, r) => {
    acc[r.insight_type] = r.data;
    return acc;
  }, {});
}

function calculateScoreTrend(prev, curr) {
  if (!prev || !curr) return null;
  return {
    previousAvg: prev.averageScore,
    currentAvg: curr.averageScore,
    delta: curr.averageScore - prev.averageScore,
  };
}

function calculateRiskTrend(prev, curr) {
  if (!prev || !curr) return null;
  return {
    previousHighRisk: prev.highRisk,
    currentHighRisk: curr.highRisk,
    delta: curr.highRisk - prev.highRisk,
  };
}

function deriveFocusAreas(current) {
  const areas = [];

  if (current.RISK_DISTRIBUTION?.highRisk > 0) {
    areas.push("Reduce high-risk user concentration");
  }

  if (
    current.COACHING_EFFECTIVENESS &&
    (current.COACHING_EFFECTIVENESS.none || 0) > 0
  ) {
    areas.push("Refine low-impact coaching strategies");
  }

  return areas;
}
