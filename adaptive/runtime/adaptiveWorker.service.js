import os from "node:os";
import crypto from "node:crypto";
import { claimAdaptiveEvents, completeAdaptiveEvent, failAdaptiveEvent, loadQueuedEvent } from "../events/eventQueue.repository.js";
import { getRuntimeSettings } from "../config/runtimeSettings.service.js";
import { evaluateDueOutcomePredictions } from "../evaluation/evaluationEngine.service.js";
import { processAdaptiveEvent } from "./adaptiveRuntime.service.js";
import { resumeDueWorkflowRuns } from "../workflows/workflowEngine.service.js";
import pool from "../../db.js";

const workerId = `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
let timer = null;
let active = false;
let stopping = false;
const diagnostics = {
  workerId, cycles: 0, processed: 0, failed: 0, recoveredLeases: 0,
  lastCycleAt: null, lastSuccessAt: null, lastError: null, lastErrorAt: null, cycleDurationMs: null,
};

async function persistHeartbeat(status = "healthy") {
  try {
    await pool.query(
      `INSERT INTO adaptive_worker_heartbeats
        (worker_id, status, cycles, processed, failed, diagnostics)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (worker_id) DO UPDATE SET
         heartbeat_at = NOW(), status = EXCLUDED.status, cycles = EXCLUDED.cycles,
         processed = EXCLUDED.processed, failed = EXCLUDED.failed,
         diagnostics = EXCLUDED.diagnostics`,
      [workerId, status, diagnostics.cycles, diagnostics.processed, diagnostics.failed, JSON.stringify(diagnostics)]
    );
  } catch (error) {
    if (error?.code !== "42P01") diagnostics.lastError = error?.message || String(error);
  }
}

export async function processAdaptiveWorkerBatch({ limit = 10 } = {}) {
  const batchStartedAt = Date.now();
  diagnostics.lastError = null;
  const items = await claimAdaptiveEvents({ workerId, limit });
  diagnostics.recoveredLeases += items.filter((item) => Number(item.attempts) > 1).length;
  const concurrency = Math.min(
    Math.max(Number(process.env.ADAPTIVE_RUNTIME_WORKER_CONCURRENCY) || 4, 1),
    10
  );
  const results = new Array(items.length);
  let cursor = 0;
  async function consume() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
    try {
      const event = await loadQueuedEvent(item);
      if (!event) throw new Error("Queued event no longer exists");
      const result = await processAdaptiveEvent({ event, queueItem: item });
      await completeAdaptiveEvent(item.id);
      diagnostics.processed += 1;
        diagnostics.lastSuccessAt = new Date().toISOString();
        results[index] = { queueId: item.id, status: "completed", runId: result.run?.id };
    } catch (error) {
      await failAdaptiveEvent(item, error);
      diagnostics.failed += 1;
      diagnostics.lastError = error?.message || String(error);
      diagnostics.lastErrorAt = new Date().toISOString();
        results[index] = { queueId: item.id, status: "failed", error: error?.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));

  const workflowResults = await resumeDueWorkflowRuns({ limit, settingsLoader: getRuntimeSettings }).catch((error) => {
    diagnostics.lastError = error?.message || String(error);
    diagnostics.lastErrorAt = new Date().toISOString();
    return [];
  });
  const evaluatedPredictions = await evaluateDueOutcomePredictions({ limit }).catch((error) => {
    diagnostics.lastError = error?.message || String(error);
    diagnostics.lastErrorAt = new Date().toISOString();
    return [];
  });
  diagnostics.cycles += 1;
  diagnostics.lastCycleAt = new Date().toISOString();
  diagnostics.cycleDurationMs = Date.now() - batchStartedAt;
  await persistHeartbeat(diagnostics.lastError ? "degraded" : "healthy");
  return { events: results, workflows: workflowResults, evaluatedPredictions };
}

async function cycle() {
  if (active || stopping) return;
  active = true;
  try {
    await processAdaptiveWorkerBatch({ limit: Number(process.env.ADAPTIVE_RUNTIME_WORKER_BATCH_SIZE) || 10 });
  } catch (error) {
    diagnostics.lastError = error?.message || String(error);
    diagnostics.lastErrorAt = new Date().toISOString();
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
  await persistHeartbeat("stopping");
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
