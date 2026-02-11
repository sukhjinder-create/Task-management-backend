/**
 * Centralized score weights.
 * Sum MUST equal 100.
 * Change here = system-wide recalibration.
 */

export const SCORE_WEIGHTS = {
  attendance: 30,
  taskCompletion: 30,
  timeliness: 20,
  stability: 10,
  collaboration: 10,
};

// Guardrail (dev-time safety)
export function validateWeights() {
  const total = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
  if (total !== 100) {
    throw new Error(
      `Score weights must sum to 100. Current total = ${total}`
    );
  }
}
