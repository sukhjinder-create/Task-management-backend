import {
  upsertIntegration,
  getWorkspaceIntegrations as repoList,
} from "../integrations/integration.repository.js";

import { integrationManager } from "../integrations/integration.manager.js";

/**
 * Connect integration for workspace
 */
export async function connectWorkspaceIntegration({
  workspaceId,
  provider,
}) {

  // 1️⃣ save integration record
  const record = await upsertIntegration({
    workspaceId,
    provider,
    config: {},
  });

  // 2️⃣ initialize provider safely
  const instance =
    integrationManager.createProvider(provider);

  await instance.connect({
    workspaceId,
  });

  return {
    success: true,
    provider,
  };
}

/**
 * List integrations
 */
export async function getWorkspaceIntegrations(workspaceId) {
  return repoList(workspaceId);
}

/**
 * Disconnect (soft for now)
 */
export async function removeWorkspaceIntegration(
  workspaceId,
  provider
) {
  // later we mark status=disconnected
  return true;
}
