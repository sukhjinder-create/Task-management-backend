/**
 * ENTERPRISE PROJECT PRODUCTIVITY ENGINE
 *
 * Deterministic. Transparent. Auditable.
 * Now factors in: story points, task type (bug ratio penalty).
 */

export function calculateProjectProductivity(tasks = []) {
  if (!tasks.length) return 0;

  const now = new Date();

  let completed       = 0;
  let active          = 0;
  let overdue         = 0;
  let touched         = 0;
  let bugCount        = 0;
  let totalPoints     = 0;
  let completedPoints = 0;

  for (const task of tasks) {
    const status = (task.status || "").toLowerCase();
    const isDone = ["completed", "done", "closed"].includes(status);

    if (isDone) completed++;
    if (["in-progress", "in progress", "stage"].includes(status)) active++;
    if (task.due_date && new Date(task.due_date) < now && !isDone) overdue++;
    if (task.progress > 0 || status !== "pending") touched++;
    if ((task.task_type || "").toLowerCase() === "bug") bugCount++;

    if (task.story_points > 0) {
      totalPoints += Number(task.story_points);
      if (isDone) completedPoints += Number(task.story_points);
    }
  }

  const total = tasks.length;

  // ---------- NORMALIZED SIGNALS ----------
  const completionRate  = completed / total;
  const momentum        = active / total;
  const riskDiscipline  = 1 - overdue / total;
  const participation   = touched / total;
  const pointVelocity   = totalPoints > 0 ? completedPoints / totalPoints : completionRate;

  // Bug ratio penalty: high defect density reduces project health score
  const bugRatio       = bugCount / total;
  const qualityPenalty = bugRatio > 0.6 ? 0.70
    : bugRatio > 0.4 ? 0.85
    : bugRatio > 0.2 ? 0.95
    : 1.0;

  // ---------- FINAL SCORE ----------
  // completion 40 + points 20 + momentum 15 + risk 15 + participation 10
  const rawScore =
    completionRate * 40 +
    pointVelocity  * 20 +
    momentum       * 15 +
    riskDiscipline * 15 +
    participation  * 10;

  return Math.max(0, Math.min(100, Math.round(rawScore * qualityPenalty)));
}
