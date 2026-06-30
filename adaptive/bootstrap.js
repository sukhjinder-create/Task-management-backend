import { registerObserver, listObservers } from "../events/eventBus.js";
import { aiObserver } from "../events/observers/aiObserver.js";
import { executionSignalObserver } from "../events/observers/executionSignal.observer.js";
import { executionIntelligenceObserver } from "../events/observers/executionIntelligence.observer.js";
import { registerDefaultCapabilities } from "./capabilities/defaultCapabilities.js";
import { registerDefaultContextProviders } from "./context/defaultContextProviders.js";
import { adaptiveEventQueueObserver } from "./events/adaptiveEventQueue.observer.js";
import { startAdaptiveRuntimeWorker } from "./runtime/adaptiveWorker.service.js";

let bootstrapped = false;

export function bootstrapAdaptivePlatform() {
  if (bootstrapped) return { bootstrapped, observers: listObservers() };
  registerDefaultCapabilities();
  registerDefaultContextProviders();
  registerObserver(aiObserver, { name: "immutable-event-store", priority: 100 });
  registerObserver(executionSignalObserver, { name: "integration-execution-signal", priority: 60 });
  registerObserver(executionIntelligenceObserver, { name: "enterprise-intelligence-recalculation", priority: 50 });
  registerObserver(adaptiveEventQueueObserver, { name: "adaptive-event-queue", priority: 10 });
  startAdaptiveRuntimeWorker();
  bootstrapped = true;
  return { bootstrapped, observers: listObservers() };
}
