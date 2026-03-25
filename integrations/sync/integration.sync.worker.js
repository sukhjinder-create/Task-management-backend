import { runIntegrationSyncCycle } from "./integration.sync.manager.js";

let intervalHandle = null;
let isRunning = false; // guard against overlapping cycles

/**
 * Starts background integration polling
 */
export function startIntegrationSyncWorker() {
  if (intervalHandle) return; // already started

  console.log("🔄 Integration sync worker started");

  intervalHandle = setInterval(async () => {
    // Skip if previous cycle is still running
    if (isRunning) {
      console.warn("⏭️  Integration sync: previous cycle still running, skipping");
      return;
    }

    isRunning = true;
    try {
      process.env.INTEGRATION_SYNC_CONTEXT = "worker";
      await runIntegrationSyncCycle();
    } catch (err) {
      // Log but never crash the worker
      console.error("⚠️  Integration sync worker error:", err.message);
    } finally {
      delete process.env.INTEGRATION_SYNC_CONTEXT;
      isRunning = false;
    }
  }, 60000);
}
