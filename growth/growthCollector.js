import { normalizeGrowthEvent } from "./growthEvent.js";
import { insertGrowthEvents } from "./growthStore.js";

const MAX_QUEUE_SIZE = 5000;
const BATCH_SIZE = 100;
const queue = [];
let flushing = false;
let lastFailureLogAt = 0;

export function enqueueGrowthEvent(event) {
  if (queue.length >= MAX_QUEUE_SIZE) {
    const now = Date.now();
    if (now - lastFailureLogAt > 60_000) {
      console.warn("[growth] telemetry queue full; dropping new events");
      lastFailureLogAt = now;
    }
    return false;
  }
  queue.push(event);
  if (queue.length >= BATCH_SIZE) void flushGrowthEvents();
  return true;
}

export function captureGrowthEvent(input) {
  try {
    return enqueueGrowthEvent(normalizeGrowthEvent(input));
  } catch (error) {
    console.warn("[growth] event rejected:", error.message);
    return false;
  }
}

export async function flushGrowthEvents() {
  if (flushing || !queue.length) return 0;
  flushing = true;
  const batch = queue.splice(0, BATCH_SIZE);
  try {
    return await insertGrowthEvents(batch);
  } catch (error) {
    const now = Date.now();
    if (now - lastFailureLogAt > 60_000) {
      console.error("[growth] asynchronous batch write failed:", error.message);
      lastFailureLogAt = now;
    }
    return 0;
  } finally {
    flushing = false;
    if (queue.length) setImmediate(() => void flushGrowthEvents());
  }
}

const flushTimer = setInterval(() => void flushGrowthEvents(), 1000);
flushTimer.unref?.();

export function getGrowthQueueDepth() {
  return queue.length;
}

