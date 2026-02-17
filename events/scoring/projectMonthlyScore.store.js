import pool from "../../db.js";
import { randomUUID } from "crypto";

/**
 * Save project-level monthly score
 * Enterprise-safe UPSERT
 */
export async function saveProjectMonthlyScore({
  workspaceId,
  userId,
  projectId,
  month,
  score,
  breakdown = null,
  reasoning = null,
}) {
  await pool.query(
    `
    INSERT INTO workspace_project_monthly_scores
      (id, workspace_id, project_id, user_id, month, score, breakdown, reasoning)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (workspace_id, project_id, user_id, month)
    DO UPDATE SET
      score = EXCLUDED.score,
      breakdown = EXCLUDED.breakdown,
      reasoning = EXCLUDED.reasoning
    `,
    [
      randomUUID(),
      workspaceId,
      projectId,
      userId,
      month,
      score,
      breakdown,
      reasoning,
    ]
  );
}
