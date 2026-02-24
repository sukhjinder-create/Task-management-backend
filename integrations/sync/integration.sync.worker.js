import { runIntegrationSyncCycle } from "./integration.sync.manager.js";

let intervalHandle = null;

/**
 * Starts background integration polling
 */
export function startIntegrationSyncWorker() {

  if (intervalHandle) return;

  console.log("🔄 Integration sync worker started");

  // every 30 seconds (safe starting interval)
  setInterval(async () => {
  try {
    // ✅ Tell system this execution comes from SYNC WORKER
    process.env.INTEGRATION_SYNC_CONTEXT = "worker";

    await runIntegrationSyncCycle();

  } finally {
    // ✅ VERY IMPORTANT — reset context
    delete process.env.INTEGRATION_SYNC_CONTEXT;
  }
}, 60000);
}
