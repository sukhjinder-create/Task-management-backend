/**
 * Centralized score weights.
 *
 * Architecture: Two sub-scores to one overall score.
 *
 *   Overall = (attendanceScore * attendanceWeight/100)
 *           + (productivityScore * productivityWeight/100)
 *
 * Each sub-score is itself 0-100 built from its own dimensions.
 * Dimension weights within each sub-score must sum to 100.
 * Final aggregation weights must sum to 100.
 */

export const SCORE_WEIGHTS = {
  // Final aggregation
  attendanceWeight: 30,
  productivityWeight: 70,

  // Attendance sub-dimensions
  attendancePresence: 30,
  attendanceHourQuality: 20,
  attendanceAvailability: 15,
  attendanceAwsDiscipline: 15,
  attendanceLunchDiscipline: 10,
  attendanceConsistency: 10,

  // Productivity sub-dimensions
  productivityTaskCompletion: 25,
  productivityTimeliness: 20,
  productivityStoryPoints: 20,
  productivityEstimation: 15,
  productivityCollaboration: 10,
  productivityBlockerResolution: 10,
};

/** Dev-time safety guard - throws if any group is misconfigured. */
export function validateWeights() {
  const W = SCORE_WEIGHTS;

  const aggTotal = W.attendanceWeight + W.productivityWeight;
  if (aggTotal !== 100) {
    throw new Error(`Final aggregation weights must sum to 100. Got ${aggTotal}`);
  }

  const attTotal = W.attendancePresence
    + W.attendanceHourQuality
    + W.attendanceAvailability
    + W.attendanceAwsDiscipline
    + W.attendanceLunchDiscipline
    + W.attendanceConsistency;
  if (attTotal !== 100) {
    throw new Error(`Attendance sub-weights must sum to 100. Got ${attTotal}`);
  }

  const prodTotal = W.productivityTaskCompletion
    + W.productivityTimeliness
    + W.productivityStoryPoints
    + W.productivityEstimation
    + W.productivityCollaboration
    + W.productivityBlockerResolution;
  if (prodTotal !== 100) {
    throw new Error(`Productivity sub-weights must sum to 100. Got ${prodTotal}`);
  }
}
