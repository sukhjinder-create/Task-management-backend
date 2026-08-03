import {
  getAllActiveIntegrations,
  markIntegrationSynced,
} from "../integration.repository.js";
import { integrationManager } from "../integration.manager.js";
import {
  getIntegrationState,
  saveIntegrationState,
} from "../integration.state.repository.js";
import {
  claimDueReconciliations,
  getSyncConfig,
  recordReconcileFailure,
  recordReconcileSuccess,
  isProjectInScope,
} from "./integration.syncConfig.repository.js";

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
 * Run one provider's sync.
 *
 * `scopedProjectIds` is passed through to the provider so it only enumerates the
 * projects an admin actually cares about; providers that ignore it keep their
 * previous whole-account behaviour, so this is safe for any provider that has
 * not been updated yet.
 */
async function syncOneIntegration(record, { reason = "reconcile", scopedProjectIds = [] } = {}) {
  const syncStartedAt = new Date();
  const previousState = asStateObject(
    await getIntegrationState(record.workspace_id, record.provider)
  );
  const provider = integrationManager.createProvider(record.provider);

  if (typeof provider.sync !== "function") return null;

  const result = await provider.sync({
    workspaceId: record.workspace_id,
    config: record.config || {},
    state: previousState,
    lastSyncedAt: record.last_synced_at || null,
    syncStartedAt: syncStartedAt.toISOString(),
    scopedProjectIds,
    reason,
  });

  if (hasProviderState(result)) {
    await saveIntegrationState(record.workspace_id, record.provider, {
      ...previousState,
      ...result.state,
      lastSuccessfulSyncAt: syncStartedAt.toISOString(),
      lastSyncStats: result.stats || null,
      lastSyncStatus: "success",
      lastSyncReason: reason,
    });
  }

  await markIntegrationSynced({
    workspaceId: record.workspace_id,
    provider: record.provider,
    syncedAt: syncStartedAt,
  });

  return result;
}

/**
 * Reconciliation sweep — the safety net behind webhooks.
 *
 * Webhook delivery is best-effort: providers have outages, deliveries fail, and
 * Asana silently deactivates webhooks after repeated failures. Without a sweep a
 * single missed event means permanently wrong data with nothing to correct it.
 * This only runs for integrations whose configured interval is actually due,
 * rather than polling every integration on a fixed global timer.
 */
export async function runReconciliationSweep({ limit = 5 } = {}) {
  const due = await claimDueReconciliations({ limit });
  if (!due.length) return { reconciled: 0, failed: 0, skipped: 0 };

  const summary = { reconciled: 0, failed: 0, skipped: 0 };

  for (const config of due) {
    try {
      const integrations = await getAllActiveIntegrations();
      const record = integrations.find(
        (item) =>
          item.workspace_id === config.workspace_id && item.provider === config.provider
      );

      // Integration was disconnected between scheduling and running.
      if (!record) {
        summary.skipped += 1;
        continue;
      }

      const scopedProjectIds = Array.isArray(config.scoped_project_ids)
        ? config.scoped_project_ids
        : [];

      await syncOneIntegration(record, { reason: "reconcile", scopedProjectIds });
      await recordReconcileSuccess({
        workspaceId: config.workspace_id,
        provider: config.provider,
      });
      summary.reconciled += 1;
    } catch (error) {
      // Backs off exponentially so a revoked token doesn't retry every cycle.
      await recordReconcileFailure({
        workspaceId: config.workspace_id,
        provider: config.provider,
        error: error.message,
      }).catch(() => {});
      console.error(
        `Reconciliation failed for ${config.provider} in workspace ${config.workspace_id}:`,
        error.message
      );
      summary.failed += 1;
    }
  }

  return summary;
}

/**
 * Sync a single integration immediately — used by the webhook path (a change
 * actually happened) and by an explicit "Sync now" from the UI.
 *
 * `externalProjectId` lets the webhook path skip work entirely when the change
 * came from a project the admin has scoped out.
 */
export async function syncIntegrationNow({
  workspaceId,
  provider,
  reason = "manual",
  externalProjectId = null,
}) {
  const integrations = await getAllActiveIntegrations();
  const record = integrations.find(
    (item) => item.workspace_id === workspaceId && item.provider === provider
  );
  if (!record) throw new Error(`No connected ${provider} integration for this workspace`);

  const config = await getSyncConfig(workspaceId, provider);
  if (config.sync_mode === "disabled") {
    return { skipped: true, reason: "sync_disabled" };
  }
  if (externalProjectId && !isProjectInScope(config, externalProjectId)) {
    return { skipped: true, reason: "project_out_of_scope" };
  }

  const scopedProjectIds = externalProjectId
    ? [String(externalProjectId)]
    : (Array.isArray(config.scoped_project_ids) ? config.scoped_project_ids : []);

  const result = await syncOneIntegration(record, { reason, scopedProjectIds });
  return { skipped: false, result };
}

/**
 * Legacy whole-fleet sync.
 *
 * Retained only for the explicit INTEGRATION_SYNC_LEGACY_POLL escape hatch and
 * for tests; the worker no longer calls this on a timer.
 */
export async function runIntegrationSyncCycle() {
  try {
    const integrations = await getAllActiveIntegrations();

    for (const record of integrations) {
      try {
        const config = await getSyncConfig(record.workspace_id, record.provider);
        if (["disabled", "manual"].includes(config.sync_mode)) continue;

        await syncOneIntegration(record, {
          reason: "legacy_poll",
          scopedProjectIds: Array.isArray(config.scoped_project_ids)
            ? config.scoped_project_ids
            : [],
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
