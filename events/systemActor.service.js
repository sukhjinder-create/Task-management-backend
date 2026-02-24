import pool from "../db.js";

/**
 * Returns workspace system user (AI / integrations actor)
 * One per workspace.
 */
export async function getSystemActorId(workspaceId) {
  const { rows } = await pool.query(
    `
    SELECT id
    FROM system_users
    WHERE workspace_id = $1
    LIMIT 1
    `,
    [workspaceId]
  );

  if (!rows.length) {
    throw new Error("System user not initialized for workspace");
  }

  return rows[0].id;
}