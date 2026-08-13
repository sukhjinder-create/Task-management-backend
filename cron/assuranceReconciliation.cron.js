import cron from "node-cron";
import { reconcileAllAssuranceWorkspaces } from "../services/enterpriseAssurance.service.js";

let running = false;

export async function runAssuranceReconciliation() {
  if (running) return { skipped: true, reason: "already_running" };
  running = true;
  try {
    const result = await reconcileAllAssuranceWorkspaces();
    if (result.capturedEvidence || result.transitions || result.failures.length) {
      console.log("[assurance] reconciliation complete", result);
    }
    return result;
  } catch (error) {
    console.error("[assurance] reconciliation failed:", error.message);
    return { scanned: 0, reconciled: 0, capturedEvidence: 0, transitions: 0, failures: [{ error: error.message }] };
  } finally {
    running = false;
  }
}

export function startAssuranceReconciliationCron() {
  cron.schedule("*/5 * * * *", runAssuranceReconciliation);
  setTimeout(() => runAssuranceReconciliation(), 15_000).unref?.();
  console.log("[assurance] five-minute evidence and state reconciliation started");
}
