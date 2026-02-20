import { getAllActiveIntegrations } from "./integration.repository.js";
import { integrationManager } from "./integration.manager.js";

/**
 * Reconnect integrations after server restart
 */
export async function rehydrateIntegrations() {
  try {
    const integrations = await getAllActiveIntegrations();

    console.log(
      `🔄 Rehydrating ${integrations.length} integrations`
    );

    for (const record of integrations) {
      try {
        const provider =
          integrationManager.createProvider(record.provider);

        await provider.connect({
          workspaceId: record.workspace_id,
          config: record.config || {},
          rehydrated: true,
        });

        console.log(
          `✅ Rehydrated ${record.provider} for workspace ${record.workspace_id}`
        );
      } catch (err) {
        console.error(
          `❌ Failed rehydrating ${record.provider}`,
          err.message
        );
      }
    }
  } catch (err) {
    console.error("Integration rehydration failed:", err);
  }
}
