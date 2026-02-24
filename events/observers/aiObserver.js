/**
 * AI Observer
 *
 * Runs silently in background.
 * Responsibilities (CURRENT PHASE):
 * 1. Store raw workspace events
 * 2. Maintain short-term rolling context
 *
 * IMPORTANT:
 * - Must NEVER throw
 * - Must NEVER block main flow
 */

import { storeWorkspaceEvent } from "../store/eventStore.js";
import { updateShortTermContext } from "../context/shortTermContext.service.js";

export async function aiObserver(event) {
  // 🚫 Prevent integration feedback loops
if (event.origin === "integration") {
  return;
}
  try {
    // 1️⃣ Persist raw event (append-only)
    await storeWorkspaceEvent(event);

    // 2️⃣ Update rolling short-term context
    await updateShortTermContext(event);

  } catch (err) {
    // Observer must NEVER crash the app
    console.error("AI Observer error:", {
      error: err.message,
      eventType: event?.eventType,
      entityType: event?.entityType,
      entityId: event?.entityId,
      workspaceId: event?.workspaceId,
    });
  }
}
