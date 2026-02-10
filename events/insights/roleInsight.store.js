import pool from "../../db.js";
import { v4 as uuid } from "uuid";

export async function saveRoleInsight({
  workspaceId,
  role,
  subjectId,
  month,
  insights,
}) {
  await pool.query(
    `
    INSERT INTO workspace_monthly_role_insights
      (id, workspace_id, role, subject_id, month, insights)
    VALUES
      ($1, $2, $3, $4, $5, $6)
    `,
    [
      uuid(),
      workspaceId,
      role,
      subjectId || null,
      month,
      insights,
    ]
  );
}
