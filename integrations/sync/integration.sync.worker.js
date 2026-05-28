import { runIntegrationSyncCycle } from "./integration.sync.manager.js";

const DEFAULT_SYNC_INTERVAL_MS = 60_000;
const MIN_SYNC_INTERVAL_MS = 15_000;

let intervalHandle = null;
let isRunning = false;

function getSyncIntervalMs() {
  const configured = Number.parseInt(
    process.env.INTEGRATION_SYNC_INTERVAL_MS || "",
    10
  );

  if (Number.isFinite(configured) && configured >= MIN_SYNC_INTERVAL_MS) {
    return configured;
  }

  return DEFAULT_SYNC_INTERVAL_MS;
}

/**
 * Starts background integration polling.
 */
export function startIntegrationSyncWorker() {
  if (intervalHandle) return;

  const intervalMs = getSyncIntervalMs();

  console.log(
    `Integration sync worker started (${Math.round(intervalMs / 1000)}s interval)`
  );

  intervalHandle = setInterval(async () => {
    if (isRunning) {
      console.warn("Integration sync skipped: previous cycle still running");
      return;
    }

    isRunning = true;
    try {
      process.env.INTEGRATION_SYNC_CONTEXT = "worker";
      await runIntegrationSyncCycle();
    } catch (err) {
      console.error("Integration sync worker error:", err.message);
    } finally {
      delete process.env.INTEGRATION_SYNC_CONTEXT;
      isRunning = false;
    }
  }, intervalMs);
}
