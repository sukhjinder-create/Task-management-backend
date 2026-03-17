import pool from "../db.js";

export async function listTags({ workspaceId }) {
  const { rows } = await pool.query(
    `SELECT * FROM tags WHERE workspace_id = $1 ORDER BY name ASC`,
    [workspaceId]
  );
  return rows;
}

export async function createTag({ workspaceId, name, color = "#6366f1" }) {
  if (!name?.trim()) throw new Error("Tag name is required");
  const { rows } = await pool.query(
    `INSERT INTO tags (workspace_id, name, color) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, name) DO UPDATE SET color = EXCLUDED.color
     RETURNING *`,
    [workspaceId, name.trim(), color]
  );
  return rows[0];
}

export async function updateTag({ id, workspaceId, name, color }) {
  const { rows } = await pool.query(
    `UPDATE tags SET name = COALESCE($1, name), color = COALESCE($2, color)
     WHERE id = $3 AND workspace_id = $4 RETURNING *`,
    [name || null, color || null, id, workspaceId]
  );
  if (!rows[0]) throw new Error("Tag not found");
  return rows[0];
}

export async function deleteTag({ id, workspaceId }) {
  const { rows } = await pool.query(
    `DELETE FROM tags WHERE id = $1 AND workspace_id = $2 RETURNING id`,
    [id, workspaceId]
  );
  if (!rows[0]) throw new Error("Tag not found");
}

export async function getTaskTags({ taskId }) {
  const { rows } = await pool.query(
    `SELECT t.* FROM tags t
     JOIN task_tag_assignments a ON a.tag_id = t.id
     WHERE a.task_id = $1
     ORDER BY t.name ASC`,
    [taskId]
  );
  return rows;
}

export async function setTaskTags({ taskId, tagIds, workspaceId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM task_tag_assignments WHERE task_id = $1`, [taskId]);
    for (const tagId of tagIds) {
      await client.query(
        `INSERT INTO task_tag_assignments (task_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [taskId, tagId]
      );
    }
    await client.query("COMMIT");
    return getTaskTags({ taskId });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function addTaskTag({ taskId, tagId }) {
  await pool.query(
    `INSERT INTO task_tag_assignments (task_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [taskId, tagId]
  );
  return getTaskTags({ taskId });
}

export async function removeTaskTag({ taskId, tagId }) {
  await pool.query(
    `DELETE FROM task_tag_assignments WHERE task_id = $1 AND tag_id = $2`,
    [taskId, tagId]
  );
  return getTaskTags({ taskId });
}
