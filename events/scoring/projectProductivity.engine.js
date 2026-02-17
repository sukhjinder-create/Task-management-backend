/**
 * ENTERPRISE PROJECT PRODUCTIVITY ENGINE
 *
 * Deterministic
 * Transparent
 * Auditable
 */

export function calculateProjectProductivity(tasks = []) {
  if (!tasks.length) return 0;

  let completed = 0;
  let active = 0;
  let overdue = 0;

  for (const task of tasks) {
    const status = (task.status || "").toLowerCase();

    // Normalize statuses
    if (["completed", "done", "closed"].includes(status)) {
      completed++;
    }

    if (["in-progress", "in progress", "stage"].includes(status)) {
      active++;
    }

    if (
      task.due_date &&
      new Date(task.due_date) < new Date() &&
      !["completed", "done", "closed"].includes(status)
    ) {
      overdue++;
    }
  }

  const total = tasks.length;
  const completionRate = completed / total;

  const score =
    completionRate * 80 +
    (active / total) * 15 -
    (overdue / total) * 20;

  return Math.max(0, Math.min(100, Math.round(score)));
}
