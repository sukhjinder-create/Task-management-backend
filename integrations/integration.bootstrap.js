console.log("🔥 BOOTSTRAP START");

import "./integration.manager.js";
import { integrationManager } from "./integration.manager.js";
import { listProviders } from "./integration.registry.js";
import { rehydrateIntegrations } from "./integration.rehydration.js";
import { startIntegrationSyncWorker } from "./sync/integration.sync.worker.js";
import "./providers/asana.provider.js";

import { registerObserver } from "../events/eventBus.js";
import { executionSignalObserver } from "../events/observers/executionSignal.observer.js";
import { executionIntelligenceObserver }
  from "../events/observers/executionIntelligence.observer.js";

registerObserver(executionSignalObserver);
registerObserver(executionIntelligenceObserver);

// delay log one tick so all providers finish registering
setTimeout(() => {
  console.log("✅ Registered providers:", listProviders());
}, 0);

setTimeout(async () => {
  const jira = integrationManager.createProvider("jira");
  await jira.connect();
}, 2000);

// 🔄 Restore integrations after boot
setTimeout(() => {
  rehydrateIntegrations();
}, 3000);

setTimeout(() => {
  startIntegrationSyncWorker();
}, 5000);