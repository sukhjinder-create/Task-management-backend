import { emitWorkspaceEvent } from "../../events/emitWorkspaceEvent.js";
import { EVENT_TYPES } from "../../events/eventTypes.js";

export async function observeAsanaTask({
  workspaceId,
  task,
}) {
  try {
    await emitWorkspaceEvent({
      workspaceId,
      actorUserId: "integration:asana",

      eventType: EVENT_TYPES.INTEGRATION_ACTIVITY_OBSERVED,

      entityType: "task",
      entityId: task.gid,

      metadata: {
        provider: "asana",
        completed: task.completed,
        modifiedAt: task.modified_at,
        assignee: task.assignee?.gid || null,
      },
    });
  } catch (err) {
    console.error("Asana observer failed:", err.message);
  }
}