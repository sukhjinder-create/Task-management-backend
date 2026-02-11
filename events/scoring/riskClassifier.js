/**
 * Deterministic risk classifier
 * No DB
 * No AI
 */

const RISK_ORDER = ["LOW", "MEDIUM", "HIGH"];

export function classifyRisk({
  currentScore,
  trend,
  confidence,
}) {
  let baseRisk = "LOW";

  if (currentScore < 50) baseRisk = "HIGH";
  else if (currentScore < 70) baseRisk = "MEDIUM";

  let riskIndex = RISK_ORDER.indexOf(baseRisk);

  // Apply trend modifier ONLY if confidence is high
  if (confidence === "HIGH") {
    if (trend === "DECLINING") riskIndex += 1;
    if (trend === "IMPROVING") riskIndex -= 1;
  }

  // Clamp
  riskIndex = Math.max(0, Math.min(2, riskIndex));

  const riskLevel = RISK_ORDER[riskIndex];

  let recommendedAction = "Monitor performance";
  if (riskLevel === "MEDIUM") {
    recommendedAction = "Light coaching and check-ins";
  }
  if (riskLevel === "HIGH") {
    recommendedAction = "Immediate coaching intervention";
  }

  return {
    riskLevel,
    reason: buildReason({ currentScore, trend, confidence }),
    recommendedAction,
  };
}

function buildReason({ currentScore, trend, confidence }) {
  if (currentScore < 50 && trend === "DECLINING") {
    return "Low score with consistent downward trend";
  }
  if (trend === "DECLINING") {
    return "Performance declining over recent months";
  }
  if (trend === "IMPROVING") {
    return "Performance improving steadily";
  }
  return "Performance stable within expected range";
}
