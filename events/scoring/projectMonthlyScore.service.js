import pool from "../../db.js";
import { randomUUID } from "crypto";

export async function runProjectMonthlyScoring({
  workspaceId,
  month,
}) {
  // 1️⃣ Get distinct project-user pairs from tasks
  const { rows } = await pool.query(
    `
    SELECT DISTINCT project_id, assigned_to AS user_id
    FROM tasks
    WHERE workspace_id = $1
      AND assigned_to IS NOT NULL
    `,
    [workspaceId]
  );

  for (const row of rows) {
    const { project_id, user_id } = row;

    const { rows: taskStats } = await pool.query(
      `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'done') AS completed,
        AVG(progress) AS avg_progress
      FROM tasks
      WHERE workspace_id = $1
        AND project_id = $2
        AND assigned_to = $3
      `,
      [workspaceId, project_id, user_id]
    );

    const stats = taskStats[0];

    const total = Number(stats.total) || 0;
    const completed = Number(stats.completed) || 0;
    const avgProgress = Number(stats.avg_progress) || 0;

    if (total === 0) continue;

    const completionRatio = completed / total;
    const progressRatio = avgProgress / 100;

    const productivityScore =
      Math.round(completionRatio * 50) +
      Math.round(progressRatio * 50);

    await pool.query(
      `
      INSERT INTO workspace_project_monthly_scores
        (id, workspace_id, project_id, user_id, month,
         productivity_score, breakdown)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (workspace_id, project_id, user_id, month)
      DO UPDATE SET
        productivity_score = EXCLUDED.productivity_score,
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
          total,
          completed,
          avgProgress,
          completionRatio,
          progressRatio,
        },
      ]
    );
  }
}