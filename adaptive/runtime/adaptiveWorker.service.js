import os from "node:os";
import crypto from "node:crypto";
import { claimAdaptiveEvents, completeAdaptiveEvent, failAdaptiveEvent, loadQueuedEvent } from "../events/eventQueue.repository.js";
import { getRuntimeSettings } from "../config/runtimeSettings.service.js";
import { processAdaptiveEvent } from "./adaptiveRuntime.service.js";
import { resumeDueWorkflowRuns } from "../workflows/workflowEngine.service.js";

const workerId = `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
let timer = null;
let active = false;
let stopping = false;
const diagnostics = { workerId, cycles: 0, processed: 0, failed: 0, lastCycleAt: null, lastError: null };

export async function processAdaptiveWorkerBatch({ limit = 10 } = {}) {
  const items = await claimAdaptiveEvents({ workerId, limit });
  const results = [];
  for (const item of items) {
    try {
      const event = await loadQueuedEvent(item);
      if (!event) throw new Error("Queued event no longer exists");
      const result = await processAdaptiveEvent({ event, queueItem: item });
      await completeAdaptiveEvent(item.id);
      diagnostics.processed += 1;
      results.push({ queueId: item.id, status: "completed", runId: result.run?.id });
    } catch (error) {
      await failAdaptiveEvent(item, error);
      diagnostics.failed += 1;
      diagnostics.lastError = error?.message || String(error);
      results.push({ queueId: item.id, status: "failed", error: error?.message });
    }
  }

  const workflowResults = await resumeDueWorkflowRuns({ limit, settingsLoader: getRuntimeSettings }).catch((error) => {
    diagnostics.lastError = error?.message || String(error);
    return [];
  });
  diagnostics.cycles += 1;
  diagnostics.lastCycleAt = new Date().toISOString();
  return { events: results, workflows: workflowResults };
}

async function cycle() {
  if (active || stopping) return;
  active = true;
  try {
    await processAdaptiveWorkerBatch({ limit: Number(process.env.ADAPTIVE_RUNTIME_WORKER_BATCH_SIZE) || 10 });
  } catch (error) {
    diagnostics.lastError = error?.message || String(error);
    console.error("[adaptive-worker] Cycle failed:", error?.message || error);
  } finally {
    active = false;
  }
}

export function startAdaptiveRuntimeWorker() {
  if (timer || process.env.ADAPTIVE_RUNTIME_WORKER_ENABLED !== "true") return false;
  const intervalMs = Math.min(Math.max(Number(process.env.ADAPTIVE_RUNTIME_WORKER_INTERVAL_MS) || 5000, 1000), 60000);
  stopping = false;
  timer = setInterval(cycle, intervalMs);
  timer.unref?.();
  setImmediate(cycle);
  console.log(`[adaptive-worker] Started ${workerId} at ${intervalMs}ms`);
  return true;
}

export async function stopAdaptiveRuntimeWorker() {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
  const deadline = Date.now() + 10000;
  while (active && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function getAdaptiveWorkerDiagnostics() {
  return { ...diagnostics, active, enabled: Boolean(timer), stopping };
}
