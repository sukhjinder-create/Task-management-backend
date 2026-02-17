export function advancedForecast(scores = []) {

  // ---------- SAFETY ----------
  if (!Array.isArray(scores) || scores.length < 3) {
    return {
      predictedAverage: null,
      trend: "insufficient_data",
      riskProjection: "unknown",
      confidence: "low",
      momentum: 0
    };
  }

  // ---------- LINEAR REGRESSION ----------
  const n = scores.length;
  const x = scores.map((_, i) => i + 1);
  const y = scores;

  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);

  const slope =
    (n * sumXY - sumX * sumY) /
    (n * sumXX - sumX * sumX);

  const intercept = (sumY - slope * sumX) / n;

  const nextX = n + 1;
  const predictedAverage = Math.round(intercept + slope * nextX);

  // ---------- TREND DETECTION ----------
  let trend = "stable";
  if (slope > 2) trend = "improving";
  if (slope < -2) trend = "declining";

  // ---------- MOMENTUM (velocity of change) ----------
  const momentum = Number(slope.toFixed(2));

  // ---------- TRAJECTORY SHIFT (NEW INTELLIGENCE) ----------
// compares recent performance vs earlier performance
let trajectory = "steady";

if (scores.length >= 5) {
  const firstHalf = scores.slice(0, Math.floor(scores.length / 2));
  const secondHalf = scores.slice(Math.floor(scores.length / 2));

  const avgFirst =
    firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;

  const avgSecond =
    secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

  const delta = avgSecond - avgFirst;

  if (delta > 5) trajectory = "accelerating_improvement";
  else if (delta < -5) trajectory = "accelerating_decline";
  else trajectory = "steady_transition";
}

  // ---------- RISK PROJECTION ----------
  let riskProjection = "moderate";

  if (predictedAverage < 40) riskProjection = "high";
  else if (predictedAverage >= 70) riskProjection = "low";

  // ---------- CONFIDENCE ----------
  const variance =
    scores.reduce((sum, v) => sum + Math.pow(v - sumY / n, 2), 0) / n;

  let confidence = "medium";
  if (variance < 20) confidence = "high";
  if (variance > 80) confidence = "low";

 // ---------- ANALYTICAL REASONING (Deterministic AI Insight) ----------
let reasoningParts = [];

/**
 * Trend interpretation
 */
if (trend === "improving") {
  reasoningParts.push(
    "Historical scores show sustained upward movement, indicating strengthening execution consistency and gradual performance recovery."
  );
} else if (trend === "declining") {
  reasoningParts.push(
    "Recent score progression reflects weakening momentum, suggesting emerging operational or engagement challenges affecting outcomes."
  );
} else {
  reasoningParts.push(
    "Score movement remains relatively flat across recent months, indicating organizational stability without strong improvement acceleration."
  );
}

/**
 * Momentum interpretation
 */
if (Math.abs(momentum) > 4) {
  reasoningParts.push(
    "The magnitude of directional change suggests structural behavioral shifts rather than short-term fluctuations."
  );
} else {
  reasoningParts.push(
    "Momentum remains moderate, implying incremental behavioral change rather than systemic transformation."
  );
}

/**
 * Trajectory interpretation (NEW)
 */
if (trajectory === "accelerating_improvement") {
  reasoningParts.push(
    "Recent performance gains are occurring faster than earlier periods, suggesting behavioral adoption or leadership interventions are beginning to compound positively."
  );
}

if (trajectory === "accelerating_decline") {
  reasoningParts.push(
    "Performance deterioration has intensified in recent periods, indicating emerging systemic friction rather than isolated performance variance."
  );
}

if (trajectory === "steady_transition") {
  reasoningParts.push(
    "Performance progression shows gradual transition without sharp directional acceleration, implying incremental organizational change."
  );
}

/**
 * Risk interpretation
 */
if (riskProjection === "high") {
  reasoningParts.push(
    "Projected performance levels fall within elevated risk thresholds, increasing probability of productivity and engagement deterioration if patterns persist."
  );
} else if (riskProjection === "low") {
  reasoningParts.push(
    "Forecasted performance indicates controlled operational risk supported by stable or improving execution patterns."
  );
} else {
  reasoningParts.push(
    "Risk exposure remains moderate, suggesting performance stability but limited resilience against disruption."
  );
}

/**
 * Confidence explanation
 */
if (confidence === "high") {
  reasoningParts.push(
    "Low score variance across historical periods increases forecast reliability, reinforcing confidence in trajectory estimation."
  );
} else if (confidence === "low") {
  reasoningParts.push(
    "High historical variability introduces uncertainty, meaning projections should be interpreted cautiously."
  );
} else {
  reasoningParts.push(
    "Moderate variance indicates partial predictability, balancing stability with some uncertainty in future outcomes."
  );
}

const reasoning = reasoningParts.join(" ");

return {
  predictedAverage,
  trend,
  trajectory, // ⭐ NEW SIGNAL
  riskProjection,
  confidence,
  momentum,
  reasoning
};
}
