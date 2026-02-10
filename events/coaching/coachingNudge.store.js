import pool from "../../db.js";
import { v4 as uuid } from "uuid";

export async function saveCoachingNudge({
  workspaceId,
  userId,
  period,
  nudgeType,
  message,
  evidence,
  expectedImpact,
}) {
  await pool.query(
    `
    INSERT INTO workspace_coaching_nudges
      (id, workspace_id, user_id, period, nudge_type, message, evidence, expected_impact)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      uuid(),
      workspaceId,
      userId,
      period,
      nudgeType,
      message,
      evidence,
      expectedImpact,
    ]
  );
}
