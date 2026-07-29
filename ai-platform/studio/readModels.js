// ai-platform/studio/readModels.js
//
// Epic C — Studio view-models. Serializes the Epic-A registries (providers,
// models, capabilities, runtime profiles) into UI-safe shapes. SECURITY: secret
// VALUES are never included — only a KeyRef reference (manager + name) and a
// boolean "configured". Pure. No DB, no I/O.

import { providerDescriptor, modelDescriptor, listProviderKeys } from "../providers/descriptors.js";
import { listCapabilities } from "../capabilities/registry.js";
import { SYSTEM_PROFILES } from "../runtime/runtimeProfiles.js";
import { resolveKeyOwnership } from "../keys/keyOwnership.js";

/** Never returns a secret value — only presence + reference. */
function keyStatus(providerKey) {
  const own = resolveKeyOwnership({ providerKey });
  const ref = own.keyRef; // { manager, ref } — reference name only
  const configured = ref?.manager === "env" ? Boolean(process.env[ref.ref]) : false;
  return { mode: own.mode, keyRef: ref, billingOwner: own.billingOwner, configured };
}

export function providerViewModel(providerKey) {
  const d = providerDescriptor(providerKey);
  if (!d) return null;
  return {
    key: providerKey,
    displayName: d.displayName,
    adapterProtocol: d.adapterProtocol,
    authStyle: d.authStyle,
    availability: d.availability,
    supports: d.supports,
    keyOwnership: keyStatus(providerKey), // { mode, keyRef, billingOwner, configured } — NO secret value
  };
}

export function listProviderViewModels() {
  return listProviderKeys().map(providerViewModel).filter(Boolean);
}

export function modelViewModel(providerKey, modelKey = null) {
  const m = modelDescriptor(providerKey, modelKey);
  if (!m) return null;
  return {
    providerKey: m.providerKey,
    key: m.key,
    aliasOf: m.aliasOf || null,
    contextWindowTokens: m.contextWindowTokens,
    modalitiesIn: m.modalitiesIn,
    modalitiesOut: m.modalitiesOut,
    supports: m.supports,
    latencyClass: m.latencyClass,
    costClass: m.costClass,
    lifecycle: m.lifecycle,
    availability: m.availability,
  };
}

export function listModelViewModels() {
  return listProviderKeys().map((p) => modelViewModel(p)).filter(Boolean);
}

export function capabilityViewModel(cap) {
  return {
    key: cap.key,
    name: cap.name,
    category: cap.category,
    description: cap.description,
    executionClass: cap.executionClass,
    requires: cap.requires,
    dependsOn: cap.dependsOn,
    businessCriticality: cap.businessCriticality,
    priorityClass: cap.priorityClass,
    expectedLatency: cap.expectedLatency,
    expectedCostClass: cap.expectedCostClass,
    dataSensitivity: cap.dataSensitivity,
    lifecycle: cap.lifecycle,
    contractVersion: cap.contractVersion,
    defaults: {
      provider: cap.defaultProvider,
      model: cap.defaultModel,
      profile: cap.defaultProfile,
      promptKey: cap.defaultPromptKey,
    },
    // Default lock — real per-object lock comes from ai_capability_config in the DB layer.
    lock: "workspace_customizable",
  };
}

export function listCapabilityViewModels() {
  return listCapabilities().map(capabilityViewModel);
}

export function listRuntimeProfileViewModels() {
  return Object.entries(SYSTEM_PROFILES).map(([key, params]) => ({ key, isSystem: true, params }));
}

/**
 * Guard used by tests + the API layer to assert no secret value leaks into any
 * serialized view-model. Returns the offending path or null.
 */
export function findLeakedSecret(viewModel, envSecretValues = []) {
  const secrets = envSecretValues.filter(Boolean);
  const seen = JSON.stringify(viewModel ?? null);
  for (const s of secrets) if (s && seen.includes(s)) return s;
  return null;
}
