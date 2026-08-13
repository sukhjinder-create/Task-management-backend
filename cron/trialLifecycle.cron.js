import cron from "node-cron";
import { reconcileExpiredWorkspaceTrials } from "../services/trialLifecycle.service.js";

let running = false;

export async function runTrialLifecycleReconciliation() {
  if (running) return { skipped: true, reason: "already_running" };
  running = true;
  try {
    const result = await reconcileExpiredWorkspaceTrials();
    if (result.downgraded || result.failures.length) {
      console.log("[trial-lifecycle] reconciliation complete", result);
    }
    return result;
  } catch (err) {
    console.error("[trial-lifecycle] reconciliation failed:", err.message);
    return { scanned: 0, downgraded: 0, failures: [{ error: err.message }] };
  } finally {
    running = false;
  }
}

export function startTrialLifecycleCron() {
  // Request-time reconciliation makes the boundary exact for active users;
  // this hourly pass keeps dormant workspaces and reporting state consistent.
  cron.schedule("7 * * * *", runTrialLifecycleReconciliation);
  setImmediate(() => runTrialLifecycleReconciliation());
  console.log("[trial-lifecycle] hourly reconciliation started");
}
