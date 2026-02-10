import pool from "../../db.js";
import { v4 as uuid } from "uuid";

export async function saveMonthlyScore({
  workspaceId,
  userId,
  month,
  score,
  breakdown,
  reasoning,
  improvements,
}) {
  await pool.query(
    `
    INSERT INTO workspace_monthly_scores
      (id, workspace_id, user_id, month, score, breakdown, reasoning, improvements)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      uuid(),
      workspaceId,
      userId,
      month,
      score,
      breakdown,
      reasoning,
      improvements,
    ]
  );
}
