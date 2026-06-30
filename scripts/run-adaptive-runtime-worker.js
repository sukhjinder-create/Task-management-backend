import "dotenv/config";
import { bootstrapAdaptivePlatform } from "../adaptive/bootstrap.js";
import { processAdaptiveWorkerBatch, stopAdaptiveRuntimeWorker } from "../adaptive/runtime/adaptiveWorker.service.js";

process.env.ADAPTIVE_RUNTIME_WORKER_ENABLED = "false";
bootstrapAdaptivePlatform();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await stopAdaptiveRuntimeWorker();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const intervalMs = Math.min(Math.max(Number(process.env.ADAPTIVE_RUNTIME_WORKER_INTERVAL_MS) || 5000, 1000), 60000);
while (!stopping) {
  await processAdaptiveWorkerBatch({ limit: Number(process.env.ADAPTIVE_RUNTIME_WORKER_BATCH_SIZE) || 10 });
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
