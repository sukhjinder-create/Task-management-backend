import { SCORE_WEIGHTS, validateWeights } from "./scoreWeights.js";

/**
 * Deterministic score calculator.
 * Input = normalized metrics (0–1 range).
 * Output = final score + breakdown.
 *
 * NO DB.
 * NO EVENTS.
 * NO AI.
 */
export function calculateScore(metrics) {
  validateWeights();

  /**
   * Expected metrics shape:
   * {
   *   attendanceRatio: 0–1,
   *   taskCompletionRatio: 0–1,
   *   timelinessRatio: 0–1,
   *   stabilityRatio: 0–1,
   *   collaborationRatio: 0–1
   * }
   */

  const clamp = (v) => Math.max(0, Math.min(1, v ?? 0));

  const normalized = {
    attendance: clamp(metrics.attendanceRatio),
    taskCompletion: clamp(metrics.taskCompletionRatio),
    timeliness: clamp(metrics.timelinessRatio),
    stability: clamp(metrics.stabilityRatio),
    collaboration: clamp(metrics.collaborationRatio),
  };

  const breakdown = {
    attendance: Math.round(normalized.attendance * SCORE_WEIGHTS.attendance),
    taskCompletion: Math.round(
      normalized.taskCompletion * SCORE_WEIGHTS.taskCompletion
    ),
    timeliness: Math.round(
      normalized.timeliness * SCORE_WEIGHTS.timeliness
    ),
    stability: Math.round(
      normalized.stability * SCORE_WEIGHTS.stability
    ),
    collaboration: Math.round(
      normalized.collaboration * SCORE_WEIGHTS.collaboration
    ),
  };

  const finalScore = Object.values(breakdown).reduce((a, b) => a + b, 0);

  return {
    score: finalScore,
    breakdown,
    normalizedMetrics: normalized,
  };
}
