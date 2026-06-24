import pool from "../../db.js";
import { v4 as uuid } from "uuid";

export async function saveExecutiveSummary({
  workspaceId,
  period,
  summary,
  sourceData,
}) {
  const { rows } = await pool.query(
    `
    INSERT INTO workspace_executive_summaries
      (id, workspace_id, period, summary, source_data, status)
    VALUES
      ($1, $2, $3, $4, $5, 'ready')
    ON CONFLICT (workspace_id, period)
    DO UPDATE SET
      summary = EXCLUDED.summary,
      source_data = EXCLUDED.source_data,
      status = 'ready'
    RETURNING *
    `,
    [uuid(), workspaceId, period, summary, sourceData]
  );
  return rows[0] || null;
}
