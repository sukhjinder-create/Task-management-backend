// ei/orchestrator/worker.js
//
// Background worker that runs the Enterprise Intelligence pipeline automatically. It is
// intentionally CANARY-SCOPED: it only processes the workspaces explicitly listed in
// EI_ENABLED_WORKSPACES (never "all workspaces"), so it is bounded and safe. With no
// canary list it is a no-op — zero production impact by default. Deterministic; each
// run is idempotent (stores converge). Uses a plain unref'd interval (does not block
// shutdown) — no new scheduling dependency.

import { orchestrateWorkspace } from "./service.js";
import { recordRun } from "./metrics.js";
import { enabledWorkspacesFor } from "../../config/platformFeatures.js";

function canaryWorkspaces() {
  const env = String(process.env.EI_ENABLED_WORKSPACES || "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...env, ...enabledWorkspacesFor("intelligence")])]; // env canary + UI toggle
}

let timer = null;

/** Start the orchestrator loop. Safe/no-op unless canary workspaces are configured. */
export function startEnterpriseIntelligenceOrchestratorWorker({ intervalMs = 5 * 60 * 1000, runImmediately = false } = {}) {
  if (timer) return { started: true, already: true };

  const tick = async () => {
    const workspaces = canaryWorkspaces(); // bounded: only explicitly-enabled workspaces
    if (workspaces.length === 0) return;
    for (const workspaceId of workspaces) {
      const t0 = Date.now();
      try {
        const r = await orchestrateWorkspace({ workspaceId });
        if (!r.skipped) {
          console.log(`[ei-orchestrator] ws=${workspaceId} events=${r.events} attr=${r.attributions} traces=${r.traces} pred=${r.predictions} rec=${r.recommendations}`);
          recordRun({ workspaceId, durationMs: Date.now() - t0, ok: true, counts: { events: r.events, attributions: r.attributions, traces: r.traces, predictions: r.predictions, recommendations: r.recommendations } });
        }
      } catch (err) {
        console.warn(`[ei-orchestrator] ws=${workspaceId} error: ${err.message}`);
        recordRun({ workspaceId, durationMs: Date.now() - t0, ok: false, error: err.message });
      }
    }
  };

  if (runImmediately) tick();
  timer = setInterval(tick, Math.max(30_000, intervalMs));
  if (typeof timer.unref === "function") timer.unref();
  return { started: true, intervalMs, canary: canaryWorkspaces().length };
}

export function stopEnterpriseIntelligenceOrchestratorWorker() {
  if (timer) { clearInterval(timer); timer = null; }
}
