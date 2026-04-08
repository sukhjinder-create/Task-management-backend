/**
 * Builds a human-readable evidence pack for the monthly score.
 * Deterministic and auditable - no DB, no AI.
 */

function hasValue(value) {
  return value != null;
}

export function buildMonthlyEvidence({ month, baselineScore = 50, breakdown, score }) {
  const evidence = {
    period: month,
    baselineScore,
    finalScore: score,
    attendanceScore: breakdown.attendanceScore ?? null,
    productivityScore: breakdown.productivityScore ?? null,
    positiveFactors: [],
    negativeFactors: [],
    patterns: [],
    improvementLevers: [],
  };

  if (breakdown.attendanceTelemetryStatus === "missing") {
    evidence.patterns.push({
      observation: "Attendance telemetry missing",
      evidence: "Attendance was held neutral because no trustworthy attendance telemetry was recorded for the month.",
    });
  }

  if (hasValue(breakdown.presence)) {
    if (breakdown.presence >= 24) {
      evidence.positiveFactors.push({
        fact: `Strong working-day presence (${breakdown.presence}/30 pts)`,
        impact: "+high",
        rule: "presence >= 24",
        why: "Expected working-day attendance stayed consistently high.",
      });
    } else if (breakdown.presence < 15) {
      evidence.negativeFactors.push({
        fact: `Working-day absence reduced attendance score (${breakdown.presence}/30 pts)`,
        impact: "-high",
        rule: "presence < 15",
        why: "Expected working days without attendance were penalized after excluding holidays and approved leave.",
      });
      evidence.improvementLevers.push({
        action: "Reduce untracked working-day absences",
        expectedImpact: "+6 to +18 points",
        reason: "Presence is the strongest attendance factor.",
      });
    }
  }

  if (hasValue(breakdown.hourQuality)) {
    if (breakdown.hourQuality >= 16) {
      evidence.positiveFactors.push({
        fact: `Strong signed-in time quality (${breakdown.hourQuality}/20 pts)`,
        impact: "+medium",
        rule: "hourQuality >= 16",
        why: "Present days were backed by meaningful signed-in time, not just short check-ins.",
      });
    } else if (breakdown.hourQuality < 10) {
      evidence.negativeFactors.push({
        fact: `Short signed-in days detected (${breakdown.hourQuality}/20 pts)`,
        impact: "-medium",
        rule: "hourQuality < 10",
        why: "Average signed-in time on present days was materially below the expected working-day baseline.",
      });
    }
  }

  if (hasValue(breakdown.availability)) {
    if (breakdown.availability >= 12) {
      evidence.positiveFactors.push({
        fact: `Healthy available time inside signed-in window (${breakdown.availability}/15 pts)`,
        impact: "+medium",
        rule: "availability >= 12",
        why: "Most signed-in time was spent available rather than away or on break.",
      });
    } else if (breakdown.availability < 8) {
      evidence.negativeFactors.push({
        fact: `Low available time during signed-in hours (${breakdown.availability}/15 pts)`,
        impact: "-medium",
        rule: "availability < 8",
        why: "A large share of signed-in time was not marked as available.",
      });
    }
  }

  if (hasValue(breakdown.awsDiscipline) && breakdown.awsDiscipline < 8) {
    evidence.negativeFactors.push({
      fact: `AWS frequency or duration was high (${breakdown.awsDiscipline}/15 pts)`,
      impact: "-medium",
      rule: "awsDiscipline < 8",
      why: "Repeated or long AWS periods reduced attendance reliability.",
    });
    evidence.improvementLevers.push({
      action: "Keep AWS usage short and intentional",
      expectedImpact: "+3 to +10 points",
      reason: "Both AWS count and accumulated AWS duration now affect attendance.",
    });
  }

  if (hasValue(breakdown.lunchDiscipline) && breakdown.lunchDiscipline < 6) {
    evidence.negativeFactors.push({
      fact: `Lunch usage pattern was excessive (${breakdown.lunchDiscipline}/10 pts)`,
      impact: "-low",
      rule: "lunchDiscipline < 6",
      why: "Lunch frequency or accumulated lunch time exceeded the healthy range.",
    });
    evidence.improvementLevers.push({
      action: "Keep lunch usage within a consistent healthy range",
      expectedImpact: "+2 to +6 points",
      reason: "Lunch duration and repeat lunch events both affect attendance scoring.",
    });
  }

  if (hasValue(breakdown.consistency) && breakdown.consistency < 6) {
    evidence.negativeFactors.push({
      fact: `Recurring absence pattern detected (${breakdown.consistency}/10 pts)`,
      impact: "-medium",
      rule: "consistency < 6",
      why: "Attendance clustered away from specific working days, lowering reliability for the team.",
    });
  }

  if ((breakdown.taskCompletion || 0) >= 20) {
    evidence.positiveFactors.push({
      fact: `High task completion rate (${breakdown.taskCompletion}/25 pts)`,
      impact: "+high",
      rule: "taskCompletion >= 20",
      why: "Assigned work was consistently closed.",
    });
  } else if ((breakdown.taskCompletion || 0) < 12) {
    evidence.negativeFactors.push({
      fact: `Low task completion rate (${breakdown.taskCompletion}/25 pts)`,
      impact: "-high",
      rule: "taskCompletion < 12",
      why: "Many assigned tasks remained incomplete.",
    });
    evidence.improvementLevers.push({
      action: "Close existing tasks before starting additional work",
      expectedImpact: "+5 to +13 points",
      reason: "Task completion is the largest productivity signal.",
    });
  }

  if ((breakdown.timeliness || 0) >= 16) {
    evidence.positiveFactors.push({
      fact: `Strong on-time delivery (${breakdown.timeliness}/20 pts)`,
      impact: "+medium",
      rule: "timeliness >= 16",
      why: "Deadlines were handled reliably.",
    });
  } else if ((breakdown.timeliness || 0) < 8) {
    evidence.negativeFactors.push({
      fact: `Poor deadline adherence (${breakdown.timeliness}/20 pts)`,
      impact: "-medium",
      rule: "timeliness < 8",
      why: "Tasks were often delivered after deadline or remained overdue.",
    });
    evidence.improvementLevers.push({
      action: "Set realistic due dates and escalate blockers earlier",
      expectedImpact: "+4 to +12 points",
      reason: "Timeliness is 20% of the productivity sub-score.",
    });
  }

  if ((breakdown.storyPoints || 0) >= 16) {
    evidence.positiveFactors.push({
      fact: `Strong story point velocity (${breakdown.storyPoints}/20 pts)`,
      impact: "+medium",
      rule: "storyPoints >= 16",
      why: "Weighted output stayed above the workspace baseline.",
    });
  } else if ((breakdown.storyPoints || 0) < 8) {
    evidence.negativeFactors.push({
      fact: `Low story point velocity (${breakdown.storyPoints}/20 pts)`,
      impact: "-medium",
      rule: "storyPoints < 8",
      why: "Completed weighted output remained below expectation.",
    });
  }

  if ((breakdown.estimation || 0) >= 12) {
    evidence.positiveFactors.push({
      fact: `Good estimation accuracy (${breakdown.estimation}/15 pts)`,
      impact: "+low",
      rule: "estimation >= 12",
      why: "Estimated effort stayed close to actual effort.",
    });
  }

  if ((breakdown.blockerResolution || 0) < 6) {
    evidence.negativeFactors.push({
      fact: `Blocked tasks not resolved promptly (${breakdown.blockerResolution}/10 pts)`,
      impact: "-low",
      rule: "blockerResolution < 6",
      why: "Unresolved blockers slowed execution.",
    });
    evidence.improvementLevers.push({
      action: "Escalate blockers within 48 hours",
      expectedImpact: "+2 to +10 points",
      reason: "Faster unblocking improves both throughput and predictability.",
    });
  }

  const attScore = breakdown.attendanceScore ?? 0;
  const prodScore = breakdown.productivityScore ?? 0;

  if (breakdown.attendanceTelemetryStatus !== "missing" && attScore >= 70 && prodScore < 50) {
    evidence.patterns.push({
      observation: "Present but low output",
      evidence: "Attendance signals were strong, but productivity remained low. This can indicate task complexity, unclear priorities, or blocked execution.",
    });
  }

  if (breakdown.attendanceTelemetryStatus !== "missing" && attScore < 50 && prodScore >= 70) {
    evidence.patterns.push({
      observation: "High output despite weak attendance pattern",
      evidence: "Productivity stayed strong even though attendance indicators were weaker. This may reflect async execution, compressed work windows, or inconsistent presence.",
    });
  }

  if (breakdown.attendanceTelemetryStatus !== "missing" && attScore >= 70 && prodScore >= 70) {
    evidence.patterns.push({
      observation: "Consistently high performer",
      evidence: "Attendance and productivity both stayed above 70, showing dependable presence and execution.",
    });
  }

  return evidence;
}
