import pool from "../db.js";

/**
 * Fetch the system user for a workspace
 * MUST exist because it is created at workspace creation time
 */
export async function getSystemUserByWorkspace(workspaceId) {
  if (!workspaceId) {
    throw new Error("workspaceId is required to fetch system user");
  }

  const { rows } = await pool.query(
    `SELECT * FROM system_users WHERE workspace_id = $1 LIMIT 1`,
    [workspaceId]
  );

  if (!rows[0]) {
    throw new Error(
      `System user missing for workspace ${workspaceId}. This indicates a workspace creation bug.`
    );
  }

  return rows[0];
}

/**
 * Utility: check if a userId belongs to a system user
 * Used to prevent AI loops
 */
export async function isSystemUserId(userId) {
  if (!userId) return false;

  const { rows } = await pool.query(
    `SELECT 1 FROM system_users WHERE id = $1 LIMIT 1`,
    [userId]
  );

  return rows.length > 0;
}
