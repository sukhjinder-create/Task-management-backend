import pool from "../../db.js";
import taskRepository from "../../repositories/task.repository.js";
import { fetchYouTrackProjectTasks } from "./youtrack.viewer.service.js";
import youtrackAdapter from "./youtrack.adapter.js";
import { emitWorkspaceEvent } from "../../events/emitWorkspaceEvent.js";
import { EVENT_TYPES } from "../../events/eventTypes.js";
import { getSystemActorId } from "../../events/systemActor.service.js";

async function mapYouTrackAssignee(workspaceId, assigneeText) {
  const value = String(assigneeText || "").trim();
  if (!value || value === "-") return null;

  const res = await pool.query(
    `
    SELECT id
    FROM users
    WHERE workspace_id = $1
      AND (
        LOWER(username) = LOWER($2)
        OR LOWER(email) = LOWER($2)
        OR LOWER(split_part(email, '@', 1)) = LOWER($2)
      )
    LIMIT 1
    `,
    [workspaceId, value]
  );

  return res.rows[0]?.id || null;
}

async function resolveYouTrackProject(workspaceId, projectId) {
  const projects = await youtrackAdapter.listProjects(workspaceId);
  const match = projects.find(
    (p) => p.id === projectId || p.key === projectId || p.name === projectId
  );

  if (match) {
    return {
      key: match.key,
      label: match.name || match.key || projectId,
    };
  }

  return { key: projectId, label: projectId };
}

function normalizeDate(value) {
  if (!value) return null;
  if (typeof value === "number") {
    const dt = new Date(value);
    if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  }
  if (typeof value === "string") {
    const dt = new Date(value);
    if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  }
  return null;
}

export async function migrateYouTrackProject({
  workspaceId,
  projectId,
  triggeredBy,
}) {
  const { key: projectKey, label } = await resolveYouTrackProject(
    workspaceId,
    projectId
  );

  const result = await fetchYouTrackProjectTasks(workspaceId, projectKey);
  const sourceTasks = Array.isArray(result) ? result : [];

  if (!sourceTasks.length) {
    throw new Error("No tasks found in YouTrack project");
  }

  const { rows: projectRows } = await pool.query(
    `
    INSERT INTO projects (name, workspace_id, added_by)
    VALUES ($1, $2, $3)
    RETURNING id
    `,
    [`[Imported] ${label}`, workspaceId, triggeredBy]
  );

  const newProjectId = projectRows[0].id;
  const systemActorId = await getSystemActorId(workspaceId);

  let importedCount = 0;

  for (const task of sourceTasks) {
    const externalTaskId = String(task.externalId || task.id || "").trim();
    if (!externalTaskId) continue;

    const existing = await pool.query(
      `
      SELECT 1
      FROM integration_task_mappings
      WHERE workspace_id = $1
        AND provider = 'youtrack'
        AND external_task_id = $2
      LIMIT 1
      `,
      [workspaceId, externalTaskId]
    );

    if (existing.rows.length) continue;

    const assignedUserId = await mapYouTrackAssignee(workspaceId, task.assignee);

    const createdTask = await taskRepository.createTask({
      task: task.title || task.name || "Untitled Task",
      project_id: newProjectId,
      status: task.completed ? "completed" : "pending",
      priority: "medium",
      added_by: systemActorId,
      assigned_to: assignedUserId,
      due_date: normalizeDate(task.dueDate),
      description: String(task.description || "").trim() || null,
      workspaceId,
    });

    await pool.query(
      `
      INSERT INTO integration_task_mappings
      (workspace_id, provider, external_task_id, internal_task_id)
      VALUES ($1, 'youtrack', $2, $3)
      ON CONFLICT DO NOTHING
      `,
      [workspaceId, externalTaskId, createdTask.id]
    );

    await emitWorkspaceEvent({
      workspaceId,
      actorUserId: systemActorId,
      eventType: EVENT_TYPES.TASK_CREATED,
      entityType: "task",
      entityId: createdTask.id,
      metadata: {
        origin: "migration",
        provider: "youtrack",
        external_entity_id: externalTaskId,
      },
    });

    importedCount++;
  }

  return {
    success: true,
    importedTasks: importedCount,
    projectId: newProjectId,
  };
}
