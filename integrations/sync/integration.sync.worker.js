import { runReconciliationSweep, runIntegrationSyncCycle } from "./integration.sync.manager.js";

// How often we *check whether anything is due* — not how often integrations are
// synced. Each integration's own reconcile_interval_minutes decides that, so a
// short tick here is cheap (one indexed query that usually returns nothing).
const DEFAULT_TICK_MS = 60_000;
const MIN_TICK_MS = 15_000;

let intervalHandle = null;
let isRunning = false;

function getTickMs() {
  const configured = Number.parseInt(process.env.INTEGRATION_SYNC_INTERVAL_MS || "", 10);
  if (Number.isFinite(configured) && configured >= MIN_TICK_MS) return configured;
  return DEFAULT_TICK_MS;
}

// Escape hatch: restores the old "poll every connected integration in full on
// every tick" behaviour. Off by default — it exists only so the previous
// behaviour can be restored without a redeploy if reconciliation misbehaves.
function legacyPollEnabled() {
  return String(process.env.INTEGRATION_SYNC_LEGACY_POLL || "").toLowerCase() === "true";
}

/**
 * Starts the background sync scheduler.
 *
 * This used to poll every connected integration's entire external account every
 * 60 seconds, for every workspace. Providers now stay current via webhooks, and
 * this tick only performs the reconciliation sweep for integrations whose own
 * configured interval has come due — so steady-state traffic drops from
 * ~1,440 full scans per integration per day to roughly one, while still
 * self-healing anything a missed webhook left stale.
 */
export function startIntegrationSyncWorker() {
  if (intervalHandle) return;

  const tickMs = getTickMs();
  const legacy = legacyPollEnabled();

  console.log(
    legacy
      ? `Integration sync worker started in LEGACY POLL mode (${Math.round(tickMs / 1000)}s full scans)`
      : `Integration sync worker started (event-driven; checking for due reconciliations every ${Math.round(tickMs / 1000)}s)`
  );

  intervalHandle = setInterval(async () => {
    if (isRunning) {
      console.warn("Integration sync skipped: previous cycle still running");
      return;
    }

    isRunning = true;
    try {
      process.env.INTEGRATION_SYNC_CONTEXT = "worker";
      if (legacy) {
        await runIntegrationSyncCycle();
      } else {
        const summary = await runReconciliationSweep({ limit: 5 });
        // Silent when nothing was due, which is the common case.
        if (summary.reconciled || summary.failed) {
          console.log(
            `[integration-sync] reconciled=${summary.reconciled} failed=${summary.failed} skipped=${summary.skipped}`
          );
        }
      }
    } catch (err) {
      console.error("Integration sync worker error:", err.message);
    } finally {
      delete process.env.INTEGRATION_SYNC_CONTEXT;
      isRunning = false;
    }
  }, tickMs);

  intervalHandle.unref?.();
}

export function stopIntegrationSyncWorker() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
  isRunning = false;
}
