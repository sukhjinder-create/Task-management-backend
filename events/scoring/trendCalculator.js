/**
 * Deterministic trend calculator
 * NO DB
 * NO AI
 * Pure math
 */

export function calculateScoreTrend(monthlyScores = []) {
  if (monthlyScores.length < 2) {
    return {
      trend: "INSUFFICIENT_DATA",
      confidence: "LOW",
    };
  }

  const scores = monthlyScores.map(s => s.score);

  const first = scores[0];
  const last = scores[scores.length - 1];

  const delta = last - first;
  const averageChange = delta / (scores.length - 1);

  // Month-to-month changes
  const changes = [];
  for (let i = 1; i < scores.length; i++) {
    changes.push(scores[i] - scores[i - 1]);
  }

  // Std deviation (volatility)
  const mean =
    changes.reduce((a, b) => a + b, 0) / changes.length;

  const variance =
    changes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) /
    changes.length;

  const stdDev = Math.sqrt(variance);

  let volatility = "LOW";
  if (stdDev >= 10) volatility = "HIGH";
  else if (stdDev >= 5) volatility = "MEDIUM";

  let trend = "STABLE";
  if (delta >= 5) trend = "IMPROVING";
  else if (delta <= -5) trend = "DECLINING";

  let confidence = "LOW";
  if (scores.length >= 3 && volatility === "LOW") confidence = "HIGH";
  else if (scores.length >= 3) confidence = "MEDIUM";

  return {
    trend,
    delta,
    averageChange: Number(averageChange.toFixed(2)),
    volatility,
    confidence,
  };
}
