import {
  getAllActiveIntegrations,
  markIntegrationSynced,
} from "../integration.repository.js";
import { integrationManager } from "../integration.manager.js";
import {
  getIntegrationState,
  saveIntegrationState,
} from "../integration.state.repository.js";

function asStateObject(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return {};
  }

  return state;
}

function hasProviderState(result) {
  return (
    result &&
    typeof result === "object" &&
    result.state &&
    typeof result.state === "object" &&
    !Array.isArray(result.state)
  );
}

/**
 * Executes one sync cycle for all integrations
 */
export async function runIntegrationSyncCycle() {
  try {
    const integrations = await getAllActiveIntegrations();

    for (const record of integrations) {
      try {
        const syncStartedAt = new Date();
        const previousState = asStateObject(
          await getIntegrationState(record.workspace_id, record.provider)
        );
        const provider =
          integrationManager.createProvider(record.provider);

        if (typeof provider.sync !== "function") continue;

        const result = await provider.sync({
          workspaceId: record.workspace_id,
          config: record.config || {},
          state: previousState,
          lastSyncedAt: record.last_synced_at || null,
          syncStartedAt: syncStartedAt.toISOString(),
        });

        if (hasProviderState(result)) {
          await saveIntegrationState(
            record.workspace_id,
            record.provider,
            {
              ...previousState,
              ...result.state,
              lastSuccessfulSyncAt: syncStartedAt.toISOString(),
              lastSyncStats: result.stats || null,
              lastSyncStatus: "success",
            }
          );
        }

        await markIntegrationSynced({
          workspaceId: record.workspace_id,
          provider: record.provider,
          syncedAt: syncStartedAt,
        });
      } catch (err) {
        console.error(
          `Sync failed for ${record.provider} in workspace ${record.workspace_id}:`,
          err.message
        );
      }
    }
  } catch (err) {
    console.error("Integration sync cycle failed:", err);
  }
}
