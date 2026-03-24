import { SCORE_WEIGHTS, validateWeights } from "./scoreWeights.js";

/**
 * Deterministic two-sub-score calculator.
 *
 * Attendance score  (0–100) × 40%
 * Productivity score (0–100) × 60%
 * ──────────────────────────────────
 * Overall score     (0–100)
 *
 * NO DB. NO EVENTS. NO AI.
 */
export function calculateScore(metrics) {
  validateWeights();

  const W = SCORE_WEIGHTS;
  const clamp = (v) => Math.max(0, Math.min(1, v ?? 0));

  /* ── ATTENDANCE SUB-SCORE (0–100) ────────────────────────── */
  const attNorm = {
    presence:     clamp(metrics.attendancePresenceRatio),
    hourQuality:  clamp(metrics.attendanceHourQualityRatio),
    activeRatio:  clamp(metrics.attendanceActiveTimeRatio),
    consistency:  clamp(metrics.attendanceConsistencyRatio),
  };

  const attendanceBreakdown = {
    presence:    Math.round(attNorm.presence    * W.attendancePresence),
    hourQuality: Math.round(attNorm.hourQuality * W.attendanceHourQuality),
    activeRatio: Math.round(attNorm.activeRatio * W.attendanceActiveRatio),
    consistency: Math.round(attNorm.consistency * W.attendanceConsistency),
  };

  const attendanceScore = Object.values(attendanceBreakdown).reduce((a, b) => a + b, 0);

  /* ── PRODUCTIVITY SUB-SCORE (0–100) ──────────────────────── */
  const prodNorm = {
    taskCompletion:      clamp(metrics.taskCompletionRatio),
    timeliness:          clamp(metrics.timelinessRatio),
    storyPoints:         clamp(metrics.storyPointVelocityRatio),
    estimation:          clamp(metrics.estimationAccuracyRatio),
    collaboration:       clamp(metrics.collaborationRatio),
    blockerResolution:   clamp(metrics.blockerResolutionRatio),
  };

  const productivityBreakdown = {
    taskCompletion:    Math.round(prodNorm.taskCompletion    * W.productivityTaskCompletion),
    timeliness:        Math.round(prodNorm.timeliness        * W.productivityTimeliness),
    storyPoints:       Math.round(prodNorm.storyPoints       * W.productivityStoryPoints),
    estimation:        Math.round(prodNorm.estimation        * W.productivityEstimation),
    collaboration:     Math.round(prodNorm.collaboration     * W.productivityCollaboration),
    blockerResolution: Math.round(prodNorm.blockerResolution * W.productivityBlockerResolution),
  };

  const productivityScore = Object.values(productivityBreakdown).reduce((a, b) => a + b, 0);

  /* ── ATTENDANCE SCORING ──────────────────────────────────── */
  // Attendance is always scored against the work calendar (Mon–Fri by default,
  // minus holidays + approved leave). Absence on a working day is penalised.
  // Only fall back to neutral (50) if no expected working days exist in the
  // month (e.g., the month hasn't started yet or a misconfigured schedule).
  const hasAttendanceTracking = metrics.hasAttendanceTracking ?? true;
  const effectiveAttScore = hasAttendanceTracking ? attendanceScore : 50;

  /* ── OVERALL SCORE ───────────────────────────────────────── */
  const finalScore = Math.round(
    (effectiveAttScore * W.attendanceWeight   / 100) +
    (productivityScore * W.productivityWeight / 100)
  );

  return {
    score: finalScore,
    attendanceScore: effectiveAttScore,
    productivityScore,
    breakdown: {
      // Top-level sub-scores
      attendanceScore: effectiveAttScore,
      productivityScore,
      hasAttendanceTracking,
      // Attendance detail
      ...attendanceBreakdown,
      // Productivity detail
      ...productivityBreakdown,
    },
    normalizedMetrics: { ...attNorm, ...prodNorm },
  };
}
