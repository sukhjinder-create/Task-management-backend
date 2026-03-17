import pool from "../db.js";

export async function listTemplates({ workspaceId, projectId }) {
  const params = [workspaceId];
  let projectClause = "";
  if (projectId) {
    params.push(projectId);
    projectClause = `AND (it.project_id IS NULL OR it.project_id = $${params.length})`;
  }
  const { rows } = await pool.query(
    `SELECT it.*, u.username AS created_by_name
     FROM issue_templates it
     LEFT JOIN users u ON u.id = it.created_by
     WHERE it.workspace_id = $1
       ${projectClause}
     ORDER BY it.name ASC`,
    params
  );
  return rows;
}

export async function createTemplate({ workspaceId, projectId, name, description, defaultFields, createdBy }) {
  if (!name?.trim()) throw new Error("Template name is required");
  const { rows } = await pool.query(
    `INSERT INTO issue_templates (workspace_id, project_id, name, description, default_fields, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [workspaceId, projectId || null, name.trim(), description || null, JSON.stringify(defaultFields || {}), createdBy]
  );
  return rows[0];
}

export async function updateTemplate({ id, workspaceId, name, description, defaultFields }) {
  const { rows } = await pool.query(
    `UPDATE issue_templates
     SET name = COALESCE($1, name),
         description = COALESCE($2, description),
         default_fields = COALESCE($3, default_fields),
         updated_at = NOW()
     WHERE id = $4 AND workspace_id = $5
     RETURNING *`,
    [name || null, description || null, defaultFields ? JSON.stringify(defaultFields) : null, id, workspaceId]
  );
  if (!rows[0]) throw new Error("Template not found");
  return rows[0];
}

export async function deleteTemplate({ id, workspaceId }) {
  const { rows } = await pool.query(
    `DELETE FROM issue_templates WHERE id = $1 AND workspace_id = $2 RETURNING id`,
    [id, workspaceId]
  );
  if (!rows[0]) throw new Error("Template not found");
}
