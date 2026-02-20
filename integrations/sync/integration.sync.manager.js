import { getAllActiveIntegrations } from "../integration.repository.js";
import { integrationManager } from "../integration.manager.js";

/**
 * Executes one sync cycle for all integrations
 */
export async function runIntegrationSyncCycle() {
  try {
    const integrations = await getAllActiveIntegrations();

    for (const record of integrations) {
      try {
        const provider =
          integrationManager.createProvider(record.provider);

        if (typeof provider.sync !== "function") continue;

        await provider.sync({
          workspaceId: record.workspace_id,
          config: record.config || {},
        });

      } catch (err) {
        console.error(
          `Sync failed for ${record.provider}:`,
          err.message
        );
      }
    }
  } catch (err) {
    console.error("Integration sync cycle failed:", err);
  }
}
