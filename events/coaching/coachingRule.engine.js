/**
 * Decides which coaching nudges are applicable
 * based strictly on evidence
 */
export function evaluateCoachingRules(evidence) {
  const nudges = [];

  // Rule 1: Low task updates
  if (
    evidence.negativeFactors.some(f =>
      f.rule === "task_updates < 10"
    )
  ) {
    nudges.push({
      type: "TASK_VISIBILITY",
      action: "Post mid-task status updates",
      expectedImpact: "+6 to +10 points",
      reason:
        "Low task update frequency reduced visibility this month",
      evidence: evidence.negativeFactors.filter(
        f => f.rule === "task_updates < 10"
      ),
    });
  }

  // Rule 2: Low engagement
  if (
    evidence.negativeFactors.some(f =>
      f.rule === "activity < 20"
    )
  ) {
    nudges.push({
      type: "ENGAGEMENT",
      action: "Increase visible workspace activity",
      expectedImpact: "+8 points",
      reason:
        "Low recorded activity impacted collaboration score",
      evidence: evidence.negativeFactors.filter(
        f => f.rule === "activity < 20"
      ),
    });
  }

  return nudges;
}
