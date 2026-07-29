// ai-platform/studio/aiStudioService.js
//
// Epic C — the AI Studio API service layer (the "control plane" logic the UI and
// routes call). Reuses Epic A/B registries + governance + read-models. The tested
// core is PURE (no DB); DB-backed override/audit reads are a documented extension.

import {
  listProviderViewModels,
  listModelViewModels,
  listCapabilityViewModels,
  listRuntimeProfileViewModels,
  capabilityViewModel,
} from "./readModels.js";
import { getCapability } from "../capabilities/registry.js";
import { resolveLockedValue, describeLock } from "../governance/locks.js";
import { permittedVerbs, can } from "../governance/permissions.js";
import { isAiPlatformEnabled, isAiTelemetryEnabled } from "../config/featureFlag.js";

/** Superadmin AI Overview snapshot. */
export function getOverview() {
  const providers = listProviderViewModels();
  const models = listModelViewModels();
  const capabilities = listCapabilityViewModels();
  const profiles = listRuntimeProfileViewModels();
  return {
    platform: {
      enabled: isAiPlatformEnabled(),
      telemetry: isAiTelemetryEnabled(),
      contractVersion: "2.0",
    },
    counts: {
      providers: providers.length,
      models: models.length,
      capabilities: capabilities.length,
      profiles: profiles.length,
      providersConfigured: providers.filter((p) => p.keyOwnership?.configured).length,
    },
  };
}

/**
 * Effective configuration for a capability in a workspace, honoring the lock
 * model. Pure — pass the platform defaults (from the capability contract), any
 * workspace override, and the object's lock level.
 * @param {{capabilityKey:string, workspaceOverride?:object, lockLevel?:string}} p
 */
export function computeEffectiveConfig({ capabilityKey, workspaceOverride = {}, lockLevel = "workspace_customizable" }) {
  const cap = getCapability(capabilityKey);
  if (!cap) return null;
  const platform = {
    provider: cap.defaultProvider,
    model: cap.defaultModel,
    profile: cap.defaultProfile,
    promptKey: cap.defaultPromptKey,
  };
  const fields = ["provider", "model", "profile", "promptKey"];
  const effective = {};
  for (const f of fields) {
    effective[f] = resolveLockedValue(lockLevel, platform[f], workspaceOverride?.[f]);
  }
  return { capabilityKey, lockLevel, platform, workspaceOverride, effective };
}

/**
 * Workspace Studio controls: for each editable field, what value is effective and
 * whether this admin may change it (drives the UI's show/hide/enable + help text).
 * @param {{role:string, capabilityKey:string, workspaceOverride?:object, lockLevel?:string}} p
 */
export function getWorkspaceControls({ role = "workspace_admin", capabilityKey, workspaceOverride = {}, lockLevel = "workspace_customizable" }) {
  const cfg = computeEffectiveConfig({ capabilityKey, workspaceOverride, lockLevel });
  if (!cfg) return null;
  const lockInfo = describeLock(lockLevel);
  const canOverride = can({ role, verb: "override", objectType: "capability_config", scope: { workspaceId: "*" }, lockLevel }).allowed;
  const controls = {};
  for (const f of Object.keys(cfg.effective)) {
    controls[f] = {
      value: cfg.effective[f],
      platformDefault: cfg.platform[f],
      editable: canOverride && lockInfo.editable,
      badge: lockInfo.badge,
      help: lockInfo.help,
    };
  }
  return {
    capability: capabilityViewModel(getCapability(capabilityKey)),
    lockLevel,
    permittedVerbs: permittedVerbs({ role, objectType: "capability_config", scope: { workspaceId: "*" }, lockLevel }),
    controls,
  };
}

// Re-export the read-model listers so routes have a single import surface.
export {
  listProviderViewModels,
  listModelViewModels,
  listCapabilityViewModels,
  listRuntimeProfileViewModels,
};
