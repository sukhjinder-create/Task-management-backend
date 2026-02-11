/**
 * Coaching message builder
 * Deterministic
 * Evidence-driven
 * Enterprise safe
 */

export function buildCoachingMessage({
  messageKey,
  evidence,
  trend,
  riskLevel,
}) {
  switch (messageKey) {
    case "high_risk_declining":
      return highRiskDeclining(evidence, trend);

    case "high_risk_stable":
      return highRiskStable(evidence);

    case "medium_risk_declining":
      return mediumRiskDeclining(evidence);

    default:
      return null;
  }
}

/* ---------------- MESSAGE TEMPLATES ---------------- */

function highRiskDeclining(evidence, trend) {
  return {
    title: "Performance Risk Detected",
    urgency: "HIGH",
    tone: "supportive",
    summary:
      "Your performance score has declined consistently and requires attention.",

    explanation: [
      `Your score dropped from ${evidence.previousScore} to ${evidence.currentScore}`,
      ...extractKeyNegatives(evidence),
    ],

    recommendedActions: extractImprovementLevers(evidence),

    transparencyNote:
      "This assessment is based on task activity, attendance patterns, and consistency metrics.",
  };
}

function highRiskStable(evidence) {
  return {
    title: "Sustained Performance Risk",
    urgency: "HIGH",
    tone: "supportive",
    summary:
      "Your performance score remains below expectations, but has stabilized.",

    explanation: extractKeyNegatives(evidence),

    recommendedActions: extractImprovementLevers(evidence),
  };
}

function mediumRiskDeclining(evidence) {
  return {
    title: "Early Performance Decline",
    urgency: "MEDIUM",
    tone: "encouraging",
    summary:
      "We noticed a slight downward trend in your recent performance.",

    explanation: extractKeyNegatives(evidence),

    recommendedActions: extractImprovementLevers(evidence),
  };
}

/* ---------------- HELPERS ---------------- */

function extractKeyNegatives(evidence) {
  return (
    evidence.negativeFactors?.map(
      (f) => `${f.fact} (${f.why})`
    ) || []
  );
}

function extractImprovementLevers(evidence) {
  return (
    evidence.improvementLevers?.map(
      (l) => `${l.action} — ${l.reason}`
    ) || []
  );
}
