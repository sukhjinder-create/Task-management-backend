import pool from "../../db.js";
import { v4 as uuid } from "uuid";

export async function saveNarrative({
  workspaceId,
  scope,
  subjectId,
  period,
  narrative,
  sourceData,
}) {
  await pool.query(
    `
    INSERT INTO workspace_llm_narratives
      (id, workspace_id, scope, subject_id, period, narrative, source_data)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      uuid(),
      workspaceId,
      scope,
      subjectId || null,
      period,
      narrative,
      sourceData,
    ]
  );
}
