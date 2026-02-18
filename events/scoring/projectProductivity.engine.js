/**
 * ENTERPRISE PROJECT PRODUCTIVITY ENGINE
 *
 * Deterministic
 * Transparent
 * Auditable
 */

export function calculateProjectProductivity(tasks = []) {
  if (!tasks.length) return 0;

  const now = new Date();

  let completed = 0;
  let active = 0;
  let overdue = 0;
  let touched = 0;

  for (const task of tasks) {
    const status = (task.status || "").toLowerCase();

    // COMPLETION
    if (["completed", "done", "closed"].includes(status)) {
      completed++;
    }

    // MOMENTUM
    if (["in-progress", "in progress", "stage"].includes(status)) {
      active++;
    }

    // RISK
    if (
      task.due_date &&
      new Date(task.due_date) < now &&
      !["completed", "done", "closed"].includes(status)
    ) {
      overdue++;
    }

    // PARTICIPATION
    if (task.progress > 0 || status !== "pending") {
      touched++;
    }
  }

  const total = tasks.length;

  // ---------- NORMALIZED SIGNALS ----------
  const completionImpact = completed / total;
  const momentum = active / total;
  const riskDiscipline = 1 - overdue / total;
  const participation = touched / total;

  // ---------- FINAL SCORE ----------
  const score =
    completionImpact * 60 +
    momentum * 20 +
    riskDiscipline * 10 +
    participation * 10;

  return Math.max(0, Math.min(100, Math.round(score)));
}
