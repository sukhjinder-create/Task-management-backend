import pool from "../../db.js";
import { v4 as uuid } from "uuid";

export async function saveExecutiveSummary({
  workspaceId,
  period,
  summary,
  sourceData,
}) {
  await pool.query(
    `
    INSERT INTO workspace_executive_summaries
      (id, workspace_id, period, summary, source_data)
    VALUES
      ($1, $2, $3, $4, $5)
    ON CONFLICT (workspace_id, period)
    DO UPDATE SET
      summary = EXCLUDED.summary,
      source_data = EXCLUDED.source_data
    `,
    [uuid(), workspaceId, period, summary, sourceData]
  );
}
