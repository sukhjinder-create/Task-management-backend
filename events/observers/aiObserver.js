import { storeWorkspaceEvent } from "../store/eventStore.js";
import { updateShortTermContext } from "../context/shortTermContext.service.js";

/** Persist every internal and integration event, then maintain rolling context. */
export async function aiObserver(event) {
  try {
    const stored = await storeWorkspaceEvent(event);
    if (stored) await updateShortTermContext(event);
  } catch (error) {
    console.error("Event store observer failed:", {
      error: error?.message,
      eventType: event?.eventType,
      entityType: event?.entityType,
      entityId: event?.entityId,
      workspaceId: event?.workspaceId,
    });
    throw error;
  }
}
