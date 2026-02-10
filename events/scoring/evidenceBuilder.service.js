/**
 * Builds an evidence pack for explanations.
 * This is deterministic and auditable.
 */

export function buildMonthlyEvidence({
  month,
  baselineScore = 50,
  breakdown,
  score,
}) {
  const evidence = {
    period: month,
    baselineScore,
    finalScore: score,
    positiveFactors: [],
    negativeFactors: [],
    patterns: [],
    improvementLevers: [],
  };

  // -------- POSITIVE FACTORS --------
  if ((breakdown.taskUpdates || 0) >= 20) {
    evidence.positiveFactors.push({
      fact: `Task status was updated ${breakdown.taskUpdates} times`,
      impact: "+10",
      rule: "task_updates >= 20",
      why: "Frequent updates improve visibility and coordination",
    });
  }

  if ((breakdown.activity || 0) >= 50) {
    evidence.positiveFactors.push({
      fact: `Recorded ${breakdown.activity} total workspace actions`,
      impact: "+10",
      rule: "activity >= 50",
      why: "Consistent activity reflects engagement",
    });
  }

  // -------- NEGATIVE FACTORS --------
  if ((breakdown.taskUpdates || 0) < 10) {
    evidence.negativeFactors.push({
      fact: `Only ${breakdown.taskUpdates} task updates were recorded`,
      impact: "-6",
      rule: "task_updates < 10",
      why: "Low update frequency reduces task visibility",
    });
  }

  if ((breakdown.activity || 0) < 20) {
    evidence.negativeFactors.push({
      fact: `Low overall activity (${breakdown.activity} actions)`,
      impact: "-8",
      rule: "activity < 20",
      why: "Low engagement limits collaboration and momentum",
    });
  }

  // -------- PATTERNS --------
  if (
    breakdown.taskUpdates > 0 &&
    breakdown.activity / breakdown.taskUpdates > 10
  ) {
    evidence.patterns.push({
      observation: "Activity was concentrated outside task updates",
      evidence:
        "High overall activity relative to task update frequency",
    });
  }

  // -------- IMPROVEMENT LEVERS --------
  evidence.improvementLevers.push({
    action: "Post mid-task status updates",
    expectedImpact: "+6 to +10 points",
    reason: "Improves visibility and reduces last-minute risk",
  });

  return evidence;
}
