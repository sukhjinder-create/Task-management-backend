// integrations/providers/jira.provider.js
console.log("🔥 JIRA PROVIDER FILE EXECUTED");

import BaseProvider from "./base.provider.js";
import { registerProvider } from "../integration.registry.js";
import { emitIntegrationEvent } from "../integration.events.js";
import { IntegrationEvents } from "../integration.event.types.js";
import {
  getIntegrationState,
  saveIntegrationState,
} from "../integration.state.repository.js";

class JiraProvider extends BaseProvider {

  constructor(config = {}) {
    super(config);
    this.name = "jira";
  }

 async connect() {
  console.log("Jira provider connected");

  await emitIntegrationEvent(
    IntegrationEvents.TASK_CREATED,
    {
      provider: "jira",
      externalId: "JIRA-101",
      title: "Sample Jira Issue",

      // ✅ REQUIRED
      entityType: "task",

      // use real workspace from your logs
      workspaceId: "886da598-6ae9-4c6a-950a-dca35d7a0b65"
    }
  );

  return true;
}

 async sync({ workspaceId }) {

  console.log(`🔄 Jira sync running for workspace ${workspaceId}`);

  // --- simulate external fetch ---
  const latestExternalState = {
    issue: "JIRA-101",
    status: "done", // pretend Jira changed status
  };

  // --- load previous state ---
  const previousState =
    await getIntegrationState(workspaceId, this.name);

  // --- detect change ---
  const hasChanged =
    JSON.stringify(previousState) !==
    JSON.stringify(latestExternalState);

  if (!hasChanged) {
    console.log("✅ Jira sync: no changes detected");
    return;
  }

  console.log("⚡ Jira change detected — emitting event");

  // emit ONLY when changed
  await emitIntegrationEvent(
    IntegrationEvents.TASK_UPDATED,
    {
      provider: "jira",
      externalId: "JIRA-101",
      entityType: "task",
      workspaceId,
      change: "status_updated",
    }
  );

  // save new snapshot
  await saveIntegrationState(
    workspaceId,
    this.name,
    latestExternalState
  );
}

  async validate() {
    return true;
  }

  async fetchProjects() {
    return [];
  }

  async fetchTasks() {
    return [];
  }

  async fetchUsers() {
    return [];
  }

  async fetchActivity() {
    return [];
  }
}

// ✅ SELF REGISTER (important)
registerProvider("jira", JiraProvider);

export default JiraProvider;
