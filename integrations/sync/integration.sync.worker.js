import { runIntegrationSyncCycle } from "./integration.sync.manager.js";

let intervalHandle = null;

/**
 * Starts background integration polling
 */
export function startIntegrationSyncWorker() {

  if (intervalHandle) return;

  console.log("🔄 Integration sync worker started");

  // every 30 seconds (safe starting interval)
  intervalHandle = setInterval(async () => {
    await runIntegrationSyncCycle();
  }, 30000);
}
