import pool from "../db.js";

/* -------------------------------------------------------
   HELPERS
------------------------------------------------------- */

async function assertSprintInWorkspace(sprintId, workspaceId) {
  const { rows } = await pool.query(
    `SELECT id, project_id, status FROM sprints WHERE id = $1 AND workspace_id = $2`,
    [sprintId, workspaceId]
  );
  if (!rows[0]) throw new Error("Sprint not found in this workspace");
  return rows[0];
}

/* -------------------------------------------------------
   LIST sprints for a project
------------------------------------------------------- */
export async function listSprints({ projectId, workspaceId }) {
  const { rows } = await pool.query(
    `
    SELECT
      s.*,
      COUNT(t.id)::int                                                AS total_tasks,
      COUNT(t.id) FILTER (WHERE t.status = 'completed')::int          AS completed_tasks,
      COUNT(t.id) FILTER (WHERE t.status != 'completed'
                            AND t.due_date < NOW())::int               AS overdue_tasks,
      COALESCE(SUM(t.story_points), 0)::int                           AS total_points,
      COALESCE(SUM(t.story_points) FILTER (WHERE t.status = 'completed'), 0)::int AS completed_points,
      COUNT(t.id) FILTER (WHERE t.is_blocked = true)::int             AS blocked_tasks,
      COUNT(t.id) FILTER (WHERE t.task_type = 'bug')::int             AS bug_count
    FROM sprints s
    LEFT JOIN tasks t ON t.sprint_id = s.id AND t.workspace_id = $2
    WHERE s.project_id = $1
      AND s.workspace_id = $2
    GROUP BY s.id
    ORDER BY
      CASE s.status WHEN 'active' THEN 0 WHEN 'planning' THEN 1 ELSE 2 END,
      s.created_at DESC
    `,
    [projectId, workspaceId]
  );
  return rows;
}

/* -------------------------------------------------------
   CREATE sprint
------------------------------------------------------- */
export async function createSprint({ projectId, workspaceId, name, goal, startDate, endDate, createdBy }) {
  if (!name?.trim()) throw new Error("Sprint name is required");

  const { rows } = await pool.query(
    `
    INSERT INTO sprints (project_id, workspace_id, name, goal, start_date, end_date, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
    `,
    [projectId, workspaceId, name.trim(), goal || null, startDate || null, endDate || null, createdBy]
  );
  return rows[0];
}

/* -------------------------------------------------------
   UPDATE sprint (name / goal / dates)
------------------------------------------------------- */
export async function updateSprint({ id, workspaceId, name, goal, startDate, endDate }) {
  const sprint = await assertSprintInWorkspace(id, workspaceId);

  if (sprint.status === "completed") {
    throw new Error("Cannot edit a completed sprint");
  }

  const { rows } = await pool.query(
    `
    UPDATE sprints
    SET name       = COALESCE($1, name),
        goal       = COALESCE($2, goal),
        start_date = COALESCE($3, start_date),
        end_date   = COALESCE($4, end_date),
        updated_at = NOW()
    WHERE id = $5 AND workspace_id = $6
    RETURNING *
    `,
    [name?.trim() || null, goal || null, startDate || null, endDate || null, id, workspaceId]
  );
  return rows[0];
}

/* -------------------------------------------------------
   DELETE sprint — moves tasks back to backlog
------------------------------------------------------- */
export async function deleteSprint({ id, workspaceId }) {
  await assertSprintInWorkspace(id, workspaceId);

  // Move all tasks back to backlog
  await pool.query(
    `UPDATE tasks SET sprint_id = NULL WHERE sprint_id = $1`,
    [id]
  );

  await pool.query(
    `DELETE FROM sprints WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId]
  );

  return { deleted: true };
}

/* -------------------------------------------------------
   START sprint — only one active sprint per project allowed
------------------------------------------------------- */
export async function startSprint({ id, workspaceId }) {
  const sprint = await assertSprintInWorkspace(id, workspaceId);

  if (sprint.status === "active") throw new Error("Sprint is already active");
  if (sprint.status === "completed") throw new Error("Cannot restart a completed sprint");

  // Check no other active sprint for this project
  const { rows: active } = await pool.query(
    `SELECT id FROM sprints WHERE project_id = $1 AND workspace_id = $2 AND status = 'active' AND id != $3`,
    [sprint.project_id, workspaceId, id]
  );
  if (active.length > 0) {
    throw new Error("Another sprint is already active for this project. Complete it before starting a new one.");
  }

  const { rows } = await pool.query(
    `
    UPDATE sprints
    SET status     = 'active',
        start_date = COALESCE(start_date, CURRENT_DATE),
        updated_at = NOW()
    WHERE id = $1 AND workspace_id = $2
    RETURNING *
    `,
    [id, workspaceId]
  );
  return rows[0];
}

/* -------------------------------------------------------
   COMPLETE sprint — incomplete tasks go back to backlog
------------------------------------------------------- */
export async function completeSprint({ id, workspaceId }) {
  const sprint = await assertSprintInWorkspace(id, workspaceId);

  if (sprint.status !== "active") {
    throw new Error("Only an active sprint can be completed");
  }

  // Count incomplete tasks that will be moved to backlog
  const { rows: incomplete } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM tasks WHERE sprint_id = $1 AND status != 'completed'`,
    [id]
  );

  // Move incomplete tasks to backlog
  await pool.query(
    `UPDATE tasks SET sprint_id = NULL WHERE sprint_id = $1 AND status != 'completed'`,
    [id]
  );

  const { rows } = await pool.query(
    `
    UPDATE sprints
    SET status   = 'completed',
        end_date = COALESCE(end_date, CURRENT_DATE),
        updated_at = NOW()
    WHERE id = $1 AND workspace_id = $2
    RETURNING *
    `,
    [id, workspaceId]
  );

  return {
    sprint: rows[0],
    movedToBacklog: incomplete[0].count,
  };
}

/* -------------------------------------------------------
   ASSIGN task to sprint (or backlog if sprintId is null)
------------------------------------------------------- */
export async function assignTaskToSprint({ taskId, sprintId, workspaceId }) {
  if (sprintId) {
    const sprint = await assertSprintInWorkspace(sprintId, workspaceId);
    if (sprint.status === "completed") {
      throw new Error("Cannot add tasks to a completed sprint");
    }
  }

  const { rows } = await pool.query(
    `UPDATE tasks SET sprint_id = $1, updated_at = NOW() WHERE id = $2 AND workspace_id = $3 RETURNING id, sprint_id`,
    [sprintId || null, taskId, workspaceId]
  );

  if (!rows[0]) throw new Error("Task not found in this workspace");
  return rows[0];
}

/* -------------------------------------------------------
   GET sprint tasks (grouped by status)
------------------------------------------------------- */
export async function getSprintTasks({ sprintId, workspaceId }) {
  if (sprintId) {
    await assertSprintInWorkspace(sprintId, workspaceId);
  }

  const filter = sprintId ? `t.sprint_id = $1` : `t.sprint_id IS NULL AND t.workspace_id = $1`;
  const param  = sprintId || workspaceId;

  const { rows } = await pool.query(
    `
    SELECT t.*,
      CONCAT(p.project_code, '-', t.ticket_number) AS display_id
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE ${filter}
    ORDER BY t.created_at DESC
    `,
    [param]
  );
  return rows;
}
