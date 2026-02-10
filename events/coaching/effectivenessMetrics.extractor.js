/**
 * Extracts comparable metrics for effectiveness tracking
 */
export function extractMetricsForNudge({
  nudgeType,
  evidence,
}) {
  switch (nudgeType) {
    case "TASK_VISIBILITY":
      return {
        taskUpdates: countFromEvidence(
          evidence,
          "taskUpdates"
        ),
      };

    case "ENGAGEMENT":
      return {
        activity: countFromEvidence(
          evidence,
          "activity"
        ),
      };

    default:
      return {};
  }
}

// Helper: pulls metric from evidence safely
function countFromEvidence(evidence, key) {
  return evidence?.summary?.[key] ?? null;
}
