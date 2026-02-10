import pool from "../../db.js";
import { saveYearlyPerformance } from "./yearlyPerformance.store.js";

/**
 * Generates yearly performance from 12 monthly scores
 */
export async function generateYearlyPerformance({
  workspaceId,
  year,
}) {
  const { rows: monthly } = await pool.query(
    `
    SELECT user_id, month, score
    FROM workspace_monthly_scores
    WHERE workspace_id = $1
      AND LEFT(month, 4)::int = $2
    ORDER BY month ASC
    `,
    [workspaceId, year]
  );

  const byUser = groupByUser(monthly);

  for (const userId of Object.keys(byUser)) {
    const scores = byUser[userId].map(r => r.score);

    const yearlyScore = Math.round(
      scores.reduce((a, b) => a + b, 0) / scores.length
    );

    const trends = calculateTrends(scores);
    const consistency = calculateConsistency(scores);

    const reasoning = [
      `Average monthly score: ${yearlyScore}`,
      trends.summary,
      consistency.summary,
    ];

    await saveYearlyPerformance({
      workspaceId,
      userId,
      year,
      yearlyScore,
      trends,
      consistency,
      reasoning,
    });
  }
}

// ---------------- HELPERS ----------------

function groupByUser(rows = []) {
  return rows.reduce((acc, r) => {
    acc[r.user_id] = acc[r.user_id] || [];
    acc[r.user_id].push(r);
    return acc;
  }, {});
}

function calculateTrends(scores = []) {
  if (scores.length < 2) {
    return {
      direction: "stable",
      summary: "Not enough data to determine trend.",
    };
  }

  const diff = scores[scores.length - 1] - scores[0];

  if (diff > 10) {
    return {
      direction: "upward",
      summary: "Performance improved significantly over the year.",
    };
  }

  if (diff < -10) {
    return {
      direction: "downward",
      summary: "Performance declined over the year.",
    };
  }

  return {
    direction: "stable",
    summary: "Performance remained consistent throughout the year.",
  };
}

function calculateConsistency(scores = []) {
  const max = Math.max(...scores);
  const min = Math.min(...scores);

  if (max - min <= 10) {
    return {
      level: "high",
      summary: "Performance was highly consistent.",
    };
  }

  if (max - min <= 25) {
    return {
      level: "medium",
      summary: "Performance showed moderate variation.",
    };
  }

  return {
    level: "low",
    summary: "Performance was inconsistent across months.",
  };
}
