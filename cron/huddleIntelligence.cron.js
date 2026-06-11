import { runHuddleIntelligenceWorkerCycle } from "../services/huddleIntelligenceWorker.service.js";

function boolEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function intEnv(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function startHuddleIntelligenceCron(env = process.env) {
  const enabled = boolEnv(env.HUDDLE_INTELLIGENCE_WORKER_ENABLED, false);
  if (!enabled) {
    console.log("[huddle:intelligence:worker] disabled");
    return { enabled: false, stop: () => {} };
  }

  const intervalMs = intEnv(env.HUDDLE_INTELLIGENCE_WORKER_INTERVAL_MS, 5000, 1000, 60000);
  const batchSize = intEnv(env.HUDDLE_INTELLIGENCE_WORKER_BATCH_SIZE, 10, 1, 50);
  const workerId = [
    "huddle-intelligence",
    env.K_REVISION || env.HOSTNAME || "local",
    process.pid,
  ].join(":");
  let stopped = false;
  let timer = null;
  let running = false;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(run, intervalMs);
    timer.unref?.();
  };

  const run = async () => {
    if (stopped || running) {
      schedule();
      return;
    }
    running = true;
    try {
      const result = await runHuddleIntelligenceWorkerCycle({
        workerId,
        batchSize,
      });
      if (!result.ok) {
        console.warn("[huddle:intelligence:worker] cycle completed with failures", {
          claimedCount: result.claimedCount,
          processedCount: result.processedCount,
        });
      }
    } catch (error) {
      console.error("[huddle:intelligence:worker] cycle failed", error.message);
    } finally {
      running = false;
      schedule();
    }
  };

  console.log("[huddle:intelligence:worker] enabled", {
    workerId,
    intervalMs,
    batchSize,
  });
  timer = setTimeout(run, Math.min(intervalMs, 1000));
  timer.unref?.();

  return {
    enabled: true,
    workerId,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export default startHuddleIntelligenceCron;
