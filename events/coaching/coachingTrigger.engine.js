/**
 * Coaching trigger decision engine
 * Deterministic
 * Silent unless needed
 */

export function evaluateCoachingTrigger({
  riskLevel,
  trend,
  confidence,
  lastCoachedAt = null,
  now = new Date(),
}) {
  if (confidence !== "HIGH") {
    return { shouldTrigger: false, reason: "Low confidence" };
  }

  if (riskLevel === "LOW") {
    return { shouldTrigger: false, reason: "Low risk" };
  }

  // Cooldown enforcement (default 14 days)
  if (lastCoachedAt) {
    const daysSince =
      (now - new Date(lastCoachedAt)) / (1000 * 60 * 60 * 24);

    if (daysSince < 14) {
      return { shouldTrigger: false, reason: "Cooldown active" };
    }
  }

  // Decision matrix
  if (riskLevel === "HIGH" && trend === "DECLINING") {
    return buildTrigger("ESCALATION", "HIGH", "high_risk_declining");
  }

  if (riskLevel === "HIGH") {
    return buildTrigger("NUDGE", "HIGH", "high_risk_stable");
  }

  if (riskLevel === "MEDIUM" && trend === "DECLINING") {
    return buildTrigger("NUDGE", "MEDIUM", "medium_risk_declining");
  }

  return { shouldTrigger: false, reason: "No rule matched" };
}

function buildTrigger(type, priority, messageKey) {
  return {
    shouldTrigger: true,
    type,
    priority,
    messageKey,
    cooldownDays: 14,
  };
}
