import pool from "../../db.js";
import { v4 as uuid } from "uuid";

export async function saveYearlyPerformance({
  workspaceId,
  userId,
  year,
  yearlyScore,
  trends,
  consistency,
  reasoning,
}) {
  await pool.query(
    `
    INSERT INTO workspace_yearly_performance
      (id, workspace_id, user_id, year, yearly_score, trends, consistency, reasoning)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      uuid(),
      workspaceId,
      userId,
      year,
      yearlyScore,
      trends,
      consistency,
      reasoning,
    ]
  );
}
