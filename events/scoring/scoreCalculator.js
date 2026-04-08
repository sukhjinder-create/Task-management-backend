import { SCORE_WEIGHTS, validateWeights } from "./scoreWeights.js";

function clampRatio(value) {
  if (value == null || Number.isNaN(Number(value))) return null;
  return Math.max(0, Math.min(1, Number(value)));
}

function scoreObservedDimensions(dimensions) {
  let observedWeight = 0;
  let weightedScore = 0;
  const breakdown = {};

  for (const [name, config] of Object.entries(dimensions)) {
    const ratio = clampRatio(config.ratio);
    if (ratio == null) {
      breakdown[name] = null;
      continue;
    }

    const points = Math.round(ratio * config.weight);
    breakdown[name] = points;
    observedWeight += config.weight;
    weightedScore += ratio * config.weight;
  }

  const score = observedWeight > 0
    ? Math.round((weightedScore / observedWeight) * 100)
    : null;

  return {
    score,
    observedWeight,
    breakdown,
  };
}

/**
 * Deterministic two-sub-score calculator.
 *
 * Attendance score is derived only from the attendance signals that were
 * actually observed. Missing telemetry is kept neutral instead of being treated
 * as proof of poor behavior.
 */
export function calculateScore(metrics) {
  validateWeights();

  const W = SCORE_WEIGHTS;

  const attNorm = {
    presence: clampRatio(metrics.attendancePresenceRatio),
    hourQuality: clampRatio(metrics.attendanceHourQualityRatio),
    availability: clampRatio(metrics.attendanceAvailabilityRatio),
    awsDiscipline: clampRatio(metrics.attendanceAwsDisciplineRatio),
    lunchDiscipline: clampRatio(metrics.attendanceLunchDisciplineRatio),
    consistency: clampRatio(metrics.attendanceConsistencyRatio),
  };

  const attendanceResult = scoreObservedDimensions({
    presence: {
      ratio: attNorm.presence,
      weight: W.attendancePresence,
    },
    hourQuality: {
      ratio: attNorm.hourQuality,
      weight: W.attendanceHourQuality,
    },
    availability: {
      ratio: attNorm.availability,
      weight: W.attendanceAvailability,
    },
    awsDiscipline: {
      ratio: attNorm.awsDiscipline,
      weight: W.attendanceAwsDiscipline,
    },
    lunchDiscipline: {
      ratio: attNorm.lunchDiscipline,
      weight: W.attendanceLunchDiscipline,
    },
    consistency: {
      ratio: attNorm.consistency,
      weight: W.attendanceConsistency,
    },
  });

  const prodNorm = {
    taskCompletion: clampRatio(metrics.taskCompletionRatio) ?? 0,
    timeliness: clampRatio(metrics.timelinessRatio) ?? 0,
    storyPoints: clampRatio(metrics.storyPointVelocityRatio) ?? 0,
    estimation: clampRatio(metrics.estimationAccuracyRatio) ?? 0,
    collaboration: clampRatio(metrics.collaborationRatio) ?? 0,
    blockerResolution: clampRatio(metrics.blockerResolutionRatio) ?? 0,
  };

  const productivityBreakdown = {
    taskCompletion: Math.round(prodNorm.taskCompletion * W.productivityTaskCompletion),
    timeliness: Math.round(prodNorm.timeliness * W.productivityTimeliness),
    storyPoints: Math.round(prodNorm.storyPoints * W.productivityStoryPoints),
    estimation: Math.round(prodNorm.estimation * W.productivityEstimation),
    collaboration: Math.round(prodNorm.collaboration * W.productivityCollaboration),
    blockerResolution: Math.round(prodNorm.blockerResolution * W.productivityBlockerResolution),
  };

  const productivityScore = Object.values(productivityBreakdown).reduce((sum, value) => sum + value, 0);

  const hasAttendanceTracking = metrics.hasAttendanceTracking ?? false;
  const effectiveAttScore = hasAttendanceTracking
    ? (attendanceResult.score ?? 50)
    : 50;

  const finalScore = Math.round(
    (effectiveAttScore * W.attendanceWeight / 100) +
    (productivityScore * W.productivityWeight / 100)
  );

  return {
    score: finalScore,
    attendanceScore: effectiveAttScore,
    productivityScore,
    breakdown: {
      attendanceScore: effectiveAttScore,
      productivityScore,
      hasAttendanceTracking,
      attendanceObservedWeight: attendanceResult.observedWeight,
      attendanceTelemetryStatus: metrics.attendanceTelemetryStatus ?? "missing",
      presence: attendanceResult.breakdown.presence,
      hourQuality: attendanceResult.breakdown.hourQuality,
      availability: attendanceResult.breakdown.availability,
      awsDiscipline: attendanceResult.breakdown.awsDiscipline,
      lunchDiscipline: attendanceResult.breakdown.lunchDiscipline,
      consistency: attendanceResult.breakdown.consistency,
      taskCompletion: productivityBreakdown.taskCompletion,
      timeliness: productivityBreakdown.timeliness,
      storyPoints: productivityBreakdown.storyPoints,
      estimation: productivityBreakdown.estimation,
      collaboration: productivityBreakdown.collaboration,
      blockerResolution: productivityBreakdown.blockerResolution,
    },
    normalizedMetrics: {
      ...attNorm,
      ...prodNorm,
    },
  };
}
