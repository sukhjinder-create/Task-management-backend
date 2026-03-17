/**
 * Builds a human-readable evidence pack for the monthly score.
 * Deterministic and auditable — no DB, no AI.
 */

export function buildMonthlyEvidence({ month, baselineScore = 50, breakdown, score }) {
  const evidence = {
    period: month,
    baselineScore,
    finalScore: score,
    attendanceScore:   breakdown.attendanceScore   ?? null,
    productivityScore: breakdown.productivityScore ?? null,
    positiveFactors: [],
    negativeFactors: [],
    patterns: [],
    improvementLevers: [],
  };

  /* ── ATTENDANCE FACTORS ─────────────────────────────────── */
  if ((breakdown.presence || 0) >= 25) {
    evidence.positiveFactors.push({
      fact:   `Strong attendance presence (${breakdown.presence}/30 pts)`,
      impact: "+high",
      rule:   "presence >= 25",
      why:    "Consistent physical/virtual presence builds team trust",
    });
  } else if ((breakdown.presence || 0) < 15) {
    evidence.negativeFactors.push({
      fact:   `Low attendance presence (${breakdown.presence}/30 pts)`,
      impact: "-high",
      rule:   "presence < 15",
      why:    "Frequent absence reduces availability and accountability",
    });
    evidence.improvementLevers.push({
      action:         "Improve attendance consistency",
      expectedImpact: "+5 to +15 points",
      reason:         "Attendance is 40% of overall score",
    });
  }

  if ((breakdown.hourQuality || 0) >= 24) {
    evidence.positiveFactors.push({
      fact:   `Full working day hours maintained (${breakdown.hourQuality}/30 pts)`,
      impact: "+medium",
      rule:   "hourQuality >= 24",
      why:    "Logging 8h/day reflects full work commitment",
    });
  } else if ((breakdown.hourQuality || 0) < 15) {
    evidence.negativeFactors.push({
      fact:   `Short working hours detected (${breakdown.hourQuality}/30 pts)`,
      impact: "-medium",
      rule:   "hourQuality < 15",
      why:    "Average sign-in time significantly below 8h/day",
    });
  }

  if ((breakdown.activeRatio || 0) >= 20) {
    evidence.positiveFactors.push({
      fact:   `High active screen time (${breakdown.activeRatio}/25 pts)`,
      impact: "+medium",
      rule:   "activeRatio >= 20",
      why:    "Strong focus engagement during working hours",
    });
  } else if ((breakdown.activeRatio || 0) < 12) {
    evidence.negativeFactors.push({
      fact:   `Low screen-on ratio (${breakdown.activeRatio}/25 pts)`,
      impact: "-medium",
      rule:   "activeRatio < 12",
      why:    "Significant idle time detected during signed-in hours",
    });
    evidence.improvementLevers.push({
      action:         "Maintain active screen engagement during work hours",
      expectedImpact: "+3 to +8 points",
      reason:         "Screen-on time is a proxy for focused work",
    });
  }

  if ((breakdown.consistency || 0) < 10) {
    evidence.negativeFactors.push({
      fact:   `Recurring absence pattern detected (${breakdown.consistency}/15 pts)`,
      impact: "-medium",
      rule:   "consistency < 10",
      why:    "Chronic day-of-week absence reduces team predictability",
    });
  }

  /* ── PRODUCTIVITY FACTORS ───────────────────────────────── */
  if ((breakdown.taskCompletion || 0) >= 20) {
    evidence.positiveFactors.push({
      fact:   `High task completion rate (${breakdown.taskCompletion}/25 pts)`,
      impact: "+high",
      rule:   "taskCompletion >= 20",
      why:    "Consistently closing assigned work",
    });
  } else if ((breakdown.taskCompletion || 0) < 12) {
    evidence.negativeFactors.push({
      fact:   `Low task completion rate (${breakdown.taskCompletion}/25 pts)`,
      impact: "-high",
      rule:   "taskCompletion < 12",
      why:    "Many assigned tasks remain incomplete",
    });
    evidence.improvementLevers.push({
      action:         "Focus on closing existing tasks before taking new ones",
      expectedImpact: "+5 to +13 points",
      reason:         "Task completion is the largest productivity signal",
    });
  }

  if ((breakdown.timeliness || 0) >= 16) {
    evidence.positiveFactors.push({
      fact:   `Strong on-time delivery (${breakdown.timeliness}/20 pts)`,
      impact: "+medium",
      rule:   "timeliness >= 16",
      why:    "Delivering before deadlines reduces team risk",
    });
  } else if ((breakdown.timeliness || 0) < 8) {
    evidence.negativeFactors.push({
      fact:   `Poor deadline adherence (${breakdown.timeliness}/20 pts)`,
      impact: "-medium",
      rule:   "timeliness < 8",
      why:    "Tasks consistently completed late",
    });
    evidence.improvementLevers.push({
      action:         "Set realistic due dates and flag blockers early",
      expectedImpact: "+4 to +12 points",
      reason:         "Timeliness is 20% of productivity sub-score",
    });
  }

  if ((breakdown.storyPoints || 0) >= 16) {
    evidence.positiveFactors.push({
      fact:   `Strong story point velocity (${breakdown.storyPoints}/20 pts)`,
      impact: "+medium",
      rule:   "storyPoints >= 16",
      why:    "Completing high-complexity work efficiently",
    });
  } else if ((breakdown.storyPoints || 0) < 8) {
    evidence.negativeFactors.push({
      fact:   `Low story point velocity (${breakdown.storyPoints}/20 pts)`,
      impact: "-medium",
      rule:   "storyPoints < 8",
      why:    "Below workspace average on weighted task output",
    });
  }

  if ((breakdown.estimation || 0) >= 12) {
    evidence.positiveFactors.push({
      fact:   `Good estimation accuracy (${breakdown.estimation}/15 pts)`,
      impact: "+low",
      rule:   "estimation >= 12",
      why:    "Reliable estimator — actual hours match forecasts",
    });
  }

  if ((breakdown.blockerResolution || 0) < 6) {
    evidence.negativeFactors.push({
      fact:   `Blocked tasks not resolved promptly (${breakdown.blockerResolution}/10 pts)`,
      impact: "-low",
      rule:   "blockerResolution < 6",
      why:    "Unresolved blockers cascade to dependent tasks",
    });
    evidence.improvementLevers.push({
      action:         "Escalate blockers within 48h of detection",
      expectedImpact: "+2 to +10 points",
      reason:         "Unblocking work enables team-wide velocity",
    });
  }

  /* ── PATTERNS ───────────────────────────────────────────── */
  const attScore  = breakdown.attendanceScore  ?? 0;
  const prodScore = breakdown.productivityScore ?? 0;

  if (attScore >= 70 && prodScore < 50) {
    evidence.patterns.push({
      observation: "Present but low output",
      evidence:    "High attendance score with low productivity — may indicate task complexity or unclear priorities",
    });
  }

  if (attScore < 50 && prodScore >= 70) {
    evidence.patterns.push({
      observation: "High output despite low attendance",
      evidence:    "Strong productivity with limited presence — async/remote work pattern or short but focused sessions",
    });
  }

  if (attScore >= 70 && prodScore >= 70) {
    evidence.patterns.push({
      observation: "Consistently high performer",
      evidence:    "Both attendance and productivity above 70 — reliable team member",
    });
  }

  return evidence;
}
