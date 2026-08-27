import pool from "../db.js";
import {
  queueImpactedIntelligenceRecalculation,
  queueTaskImpact,
} from "../intelligence/realtime/recalculation.service.js";

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

async function getSprintAssignees(sprintId, workspaceId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT assigned_to
     FROM tasks
     WHERE sprint_id = $1
       AND workspace_id = $2
       AND assigned_to IS NOT NULL`,
    [sprintId, workspaceId]
  ).catch(() => ({ rows: [] }));

  return rows.map((row) => row.assigned_to).filter(Boolean);
}

function queueSprintProjectIntelligence({ workspaceId, projectId, reason, userIds = [], sourceId = null, metadata = {} }) {
  queueImpactedIntelligenceRecalculation({
    workspaceId,
    reason,
    userIds,
    projectIds: [projectId],
    sourceType: "sprint",
    sourceId,
    metadata,
  });
}

/* -------------------------------------------------------
   Recalculate a goal's progress from its linked sprints.
   Called automatically whenever a linked sprint is completed.
   Progress = (# completed linked sprints / # total linked sprints) * 100
------------------------------------------------------- */
export async function recalcGoalFromSprints(objectiveId) {
  const { rows: links } = await pool.query(
    `SELECT sl.sprint_id, s.status
     FROM okr_sprint_links sl
     JOIN sprints s ON s.id = sl.sprint_id
     WHERE sl.objective_id = $1`,
    [objectiveId]
  );

  if (links.length === 0) return; // no linked sprints — nothing to recalc

  const completed = links.filter(l => l.status === "completed").length;
  const progress  = Math.round((completed / links.length) * 100);

  // Derive status from progress
  let status = "on_track";
  if (progress === 100)      status = "done";
  else if (progress >= 60)   status = "on_track";
  else if (progress >= 30)   status = "at_risk";
  else                       status = "off_track";

  await pool.query(
    `UPDATE okr_objectives SET
       progress = $1,
       status = CASE
         WHEN success_measure IS NOT NULL AND target_date IS NOT NULL THEN status
         ELSE $2
       END,
       updated_at = NOW()
     WHERE id = $3`,
    [progress, status, objectiveId]
  );
}

/* -------------------------------------------------------
   LIST sprints for a project
   - Non-admin / non-superadmin roles never see hidden sprints
------------------------------------------------------- */
export async function listSprints({ projectId, workspaceId, userRole }) {
  const hiddenFilter =
    userRole === "admin" || userRole === "superadmin"
      ? ""
      : "AND s.is_hidden = FALSE";

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
      COUNT(t.id) FILTER (WHERE t.task_type = 'bug')::int             AS bug_count,
      -- Goals linked to this sprint (visible to all; clickable for admin/manager on the UI)
      (SELECT json_agg(
                json_build_object(
                  'goal_id',       oo.id,
                  'goal_title',    oo.title,
                  'goal_status',   oo.status,
                  'goal_progress', oo.progress,
                  'time_period',   oo.time_period
                ) ORDER BY oo.created_at
              )
       FROM okr_sprint_links osl
       JOIN okr_objectives oo ON oo.id = osl.objective_id
       WHERE osl.sprint_id = s.id
      ) AS linked_goals
    FROM sprints s
    LEFT JOIN tasks t ON t.sprint_id = s.id AND t.workspace_id = $2
    WHERE s.project_id = $1
      AND s.workspace_id = $2
      ${hiddenFilter}
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
export async function createSprint({ projectId, workspaceId, name, goal, startDate, endDate, createdBy, isHidden = false }) {
  if (!name?.trim()) throw new Error("Sprint name is required");

  const { rows } = await pool.query(
    `
    INSERT INTO sprints (project_id, workspace_id, name, goal, start_date, end_date, created_by, is_hidden)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
    `,
    [projectId, workspaceId, name.trim(), goal || null, startDate || null, endDate || null, createdBy, isHidden]
  );
  queueSprintProjectIntelligence({
    workspaceId,
    projectId,
    reason: "sprint_created",
    userIds: [createdBy],
    sourceId: rows[0].id,
    metadata: { sprintName: rows[0].name },
  });
  return rows[0];
}

/* -------------------------------------------------------
   UPDATE sprint (name / goal / dates / is_hidden)
------------------------------------------------------- */
export async function updateSprint({ id, workspaceId, name, goal, startDate, endDate, isHidden }) {
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
        is_hidden  = COALESCE($5, is_hidden),
        updated_at = NOW()
    WHERE id = $6 AND workspace_id = $7
    RETURNING *
    `,
    [name?.trim() || null, goal || null, startDate || null, endDate || null,
     isHidden !== undefined ? isHidden : null, id, workspaceId]
  );
  queueSprintProjectIntelligence({
    workspaceId,
    projectId: sprint.project_id,
    reason: "sprint_updated",
    sourceId: id,
    metadata: { sprintName: rows[0]?.name },
  });
  return rows[0];
}

/* -------------------------------------------------------
   DELETE sprint — moves tasks back to backlog
------------------------------------------------------- */
export async function deleteSprint({ id, workspaceId }) {
  const sprint = await assertSprintInWorkspace(id, workspaceId);
  const affectedUsers = await getSprintAssignees(id, workspaceId);

  // Move all tasks back to backlog
  await pool.query(
    `UPDATE tasks SET sprint_id = NULL WHERE sprint_id = $1`,
    [id]
  );

  await pool.query(
    `DELETE FROM sprints WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId]
  );

  queueSprintProjectIntelligence({
    workspaceId,
    projectId: sprint.project_id,
    reason: "sprint_deleted",
    userIds: affectedUsers,
    sourceId: id,
  });

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
  queueSprintProjectIntelligence({
    workspaceId,
    projectId: sprint.project_id,
    reason: "sprint_started",
    sourceId: id,
    metadata: { sprintName: rows[0]?.name },
  });
  return rows[0];
}

/* -------------------------------------------------------
   COMPLETE sprint — incomplete tasks go back to backlog
   Automatically recalculates any linked OKR objectives.
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
  const affectedUsers = await getSprintAssignees(id, workspaceId);

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

  // ─── Auto-sync linked Goals ────────────────────────────────────────────────
  const { rows: linkedGoals } = await pool.query(
    `SELECT DISTINCT objective_id FROM okr_sprint_links WHERE sprint_id = $1`,
    [id]
  );
  for (const { objective_id } of linkedGoals) {
    await recalcGoalFromSprints(objective_id);
  }
  // ───────────────────────────────────────────────────────────────────────────

  queueSprintProjectIntelligence({
    workspaceId,
    projectId: sprint.project_id,
    reason: "milestone_completed",
    userIds: affectedUsers,
    sourceId: id,
    metadata: {
      sprintName: rows[0]?.name,
      movedToBacklog: incomplete[0].count,
      goalsUpdated: linkedGoals.length,
    },
  });

  return {
    sprint:        rows[0],
    movedToBacklog: incomplete[0].count,
    goalsUpdated:  linkedGoals.length,
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
  queueTaskImpact({
    workspaceId,
    taskId,
    reason: "sprint_assignment_changed",
    metadata: { sprintId: sprintId || null },
  }).catch(() => {});
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
