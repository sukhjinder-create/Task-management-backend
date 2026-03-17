import pool from "../db.js";

export async function listSavedFilters({ workspaceId, userId, projectId }) {
  const params = [workspaceId, userId];
  let projectClause = "";
  if (projectId) {
    params.push(projectId);
    projectClause = `AND (sf.project_id IS NULL OR sf.project_id = $${params.length})`;
  }
  const { rows } = await pool.query(
    `SELECT sf.*, u.username AS owner_name
     FROM saved_filters sf
     LEFT JOIN users u ON u.id = sf.user_id
     WHERE sf.workspace_id = $1
       AND (sf.user_id = $2 OR sf.is_shared = true)
       ${projectClause}
     ORDER BY sf.created_at DESC`,
    params
  );
  return rows;
}

export async function createSavedFilter({ workspaceId, userId, projectId, name, filterConfig, isShared }) {
  if (!name?.trim()) throw new Error("Filter name is required");
  const { rows } = await pool.query(
    `INSERT INTO saved_filters (workspace_id, user_id, project_id, name, filter_config, is_shared)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [workspaceId, userId, projectId || null, name.trim(), JSON.stringify(filterConfig || {}), isShared || false]
  );
  return rows[0];
}

export async function deleteSavedFilter({ id, userId, workspaceId }) {
  const { rows } = await pool.query(
    `DELETE FROM saved_filters WHERE id = $1 AND user_id = $2 AND workspace_id = $3 RETURNING id`,
    [id, userId, workspaceId]
  );
  if (!rows[0]) throw new Error("Filter not found or not yours");
}
