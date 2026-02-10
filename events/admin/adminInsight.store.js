import pool from "../../db.js";
import { v4 as uuid } from "uuid";

export async function saveAdminInsight({
  workspaceId,
  period,
  insightType,
  data,
}) {
  await pool.query(
    `
    INSERT INTO workspace_admin_insights
      (id, workspace_id, period, insight_type, data)
    VALUES
      ($1, $2, $3, $4, $5)
    `,
    [
      uuid(),
      workspaceId,
      period,
      insightType,
      data,
    ]
  );
}
