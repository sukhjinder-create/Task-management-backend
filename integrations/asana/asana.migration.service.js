import pool from "../../db.js";
import taskRepository from "../../repositories/task.repository.js";
import { fetchAsanaProjectTasks } from "./asana.viewer.service.js";
import { emitWorkspaceEvent } from "../../events/emitWorkspaceEvent.js";
import { EVENT_TYPES } from "../../events/eventTypes.js";
import { getSystemActorId } from "../../events/systemActor.service.js";

/**
 * ONE-CLICK ASANA PROJECT MIGRATION
 */
export async function migrateAsanaProject({
  workspaceId,
  projectId,
  triggeredBy
}) {

  console.log("🚀 Starting Asana migration:", projectId);

  // --------------------------------------------------
  // 1️⃣ Fetch ALL Asana tasks (no pagination slicing)
  // --------------------------------------------------
  const result = await fetchAsanaProjectTasks(
    workspaceId,
    projectId,
    { page: 1, limit: 100000, search: "" }
  );

  const tasks = result.data || [];

  if (!tasks.length) {
    throw new Error("No tasks found in Asana project");
  }

  // --------------------------------------------------
  // 2️⃣ Create native Aidrian project
  // --------------------------------------------------
  const projectInsert = await pool.query(
    `
    INSERT INTO projects (
      name,
      workspace_id,
      added_by
    )
    VALUES ($1,$2,$3)
    RETURNING id
    `,
    [`[Imported] ${projectId}`, workspaceId, triggeredBy]
  );

  const newProjectId = projectInsert.rows[0].id;

  const systemActorId = await getSystemActorId(workspaceId);

  // --------------------------------------------------
  // 3️⃣ Import tasks
  // --------------------------------------------------
  for (const asanaTask of tasks) {

    const status =
      asanaTask.completed ? "completed" : "pending";

    const createdTask = await taskRepository.createTask({
      task: asanaTask.name || "Untitled Task",
      project_id: newProjectId,
      status,
      priority: "medium",
      added_by: systemActorId,
      assigned_to: null, // user mapping later phase
      due_date: null,
      description: `Imported from Asana\nExternal ID: ${asanaTask.gid}`,
      workspaceId
    });

    // --------------------------------------------------
    // 4️⃣ Emit NORMAL task event
    // (this triggers intelligence automatically)
    // --------------------------------------------------
    await emitWorkspaceEvent({
      workspaceId,
      actorUserId: systemActorId,
      eventType: EVENT_TYPES.TASK_CREATED,
      entityType: "task",
      entityId: createdTask.id,
      metadata: {
        origin: "migration",
        provider: "asana",
        external_entity_id: asanaTask.gid
      }
    });
  }

  console.log("✅ Migration completed");

  return {
    success: true,
    importedTasks: tasks.length,
    projectId: newProjectId
  };
}