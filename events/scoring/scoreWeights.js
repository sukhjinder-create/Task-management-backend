/**
 * Centralized score weights.
 *
 * Architecture: Two sub-scores → one overall score.
 *
 *   Overall = (attendanceScore × attendanceWeight/100)
 *           + (productivityScore × productivityWeight/100)
 *
 * Each sub-score is itself 0–100 built from its own dimensions.
 * Dimension weights within each sub-score must sum to 100.
 * Final aggregation weights must sum to 100.
 */

export const SCORE_WEIGHTS = {
  // ── FINAL AGGREGATION ───────────────────────────────────────
  attendanceWeight:   30,   // attendance sub-score contribution
  productivityWeight: 70,   // productivity sub-score contribution

  // ── ATTENDANCE SUB-DIMENSIONS (must sum to 100) ─────────────
  attendancePresence:     30,  // were they there?
  attendanceHourQuality:  30,  // did they work full days?
  attendanceActiveRatio:  25,  // screen-on / available (focus quality)
  attendanceConsistency:  15,  // no chronic day-of-week patterns

  // ── PRODUCTIVITY SUB-DIMENSIONS (must sum to 100) ───────────
  productivityTaskCompletion:  25,  // completed / assigned
  productivityTimeliness:      20,  // on-time completions
  productivityStoryPoints:     20,  // story points velocity
  productivityEstimation:      15,  // estimated vs actual hours
  productivityCollaboration:   10,  // comments + tags + watchers
  productivityBlockerResolution: 10, // blocked tasks resolved fast
};

/** Dev-time safety guard — throws if any group is misconfigured. */
export function validateWeights() {
  const W = SCORE_WEIGHTS;

  const aggTotal = W.attendanceWeight + W.productivityWeight;
  if (aggTotal !== 100)
    throw new Error(`Final aggregation weights must sum to 100. Got ${aggTotal}`);

  const attTotal = W.attendancePresence + W.attendanceHourQuality
    + W.attendanceActiveRatio + W.attendanceConsistency;
  if (attTotal !== 100)
    throw new Error(`Attendance sub-weights must sum to 100. Got ${attTotal}`);

  const prodTotal = W.productivityTaskCompletion + W.productivityTimeliness
    + W.productivityStoryPoints + W.productivityEstimation
    + W.productivityCollaboration + W.productivityBlockerResolution;
  if (prodTotal !== 100)
    throw new Error(`Productivity sub-weights must sum to 100. Got ${prodTotal}`);
}
