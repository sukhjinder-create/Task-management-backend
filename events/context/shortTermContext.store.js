import pool from "../../db.js";
import { v4 as uuid } from "uuid";

/**
 * Upserts short-term context safely
 */
export async function upsertShortTermContext({
  workspaceId,
  subjectType,
  subjectId,
  context,
}) {
  await pool.query(
    `
    INSERT INTO workspace_short_term_context
      (id, workspace_id, subject_type, subject_id, context, last_updated)
    VALUES
      ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (workspace_id, subject_type, subject_id)
    DO UPDATE SET
      context = EXCLUDED.context,
      last_updated = NOW()
    `,
    [
      uuid(),
      workspaceId,
      subjectType,
      subjectId,
      context,
    ]
  );
}
