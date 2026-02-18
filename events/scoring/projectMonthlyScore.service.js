import pool from "../../db.js";
import { randomUUID } from "crypto";
import { calculateProjectProductivity } from "./projectProductivity.engine.js";

function getMonthBoundaries(month) {
  const [year, m] = month.split("-").map(Number);

  return {
    startDate: new Date(year, m - 1, 1),
    endDate: new Date(year, m, 1), // first day next month
  };
}

export async function runProjectMonthlyScoring({
  workspaceId,
  month,
}) {
  const { startDate, endDate } = getMonthBoundaries(month);
  const { rows } = await pool.query(
  `
  SELECT DISTINCT project_id, assigned_to AS user_id
  FROM tasks
  WHERE workspace_id = $1
    AND assigned_to IS NOT NULL
    AND created_at >= $2
    AND created_at < $3
  `,
  [workspaceId, startDate, endDate]
);
  for (const row of rows) {
    const { project_id, user_id } = row;

    const { rows: projectTasks } = await pool.query(
  `
  SELECT status, progress, due_date
  FROM tasks
  WHERE workspace_id = $1
    AND project_id = $2
    AND assigned_to = $3
    AND created_at >= $4
    AND created_at < $5
  `,
  [workspaceId, project_id, user_id, startDate, endDate]
);

    if (!projectTasks.length) continue;

const productivityScore =
  calculateProjectProductivity(projectTasks);

    await pool.query(
      `
      INSERT INTO workspace_project_monthly_scores
      (id, workspace_id, project_id, user_id, month,
      score, breakdown)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (workspace_id, project_id, user_id, month)
      DO UPDATE SET
      score = EXCLUDED.score,
      breakdown = EXCLUDED.breakdown
      `,
      [
  randomUUID(),
  workspaceId,
  project_id,
  user_id,
  month,
  productivityScore,
  {
    taskCount: projectTasks.length,
    scoredBy: "projectProductivity.engine"
  },
]
    );
  }
}