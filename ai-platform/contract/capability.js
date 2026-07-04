// ai-platform/contract/capability.js
//
// Contract v2 §4 — Capability contract. The immutable, code-owned CONTRACT is
// separate from the mutable, DB-owned CONFIGURATION (this separation is the fix
// for the "split-brain" gate finding; it is fixed here as TYPES only).
//
// `defineCapabilityContract` is a pure freezer — no registration, no resolution.

import { deepFreeze } from "./common.js";

export const EXECUTION_CLASSES = Object.freeze(["sync", "async", "streaming", "batch"]);
export const CRITICALITY = Object.freeze(["experimental", "standard", "important", "critical"]);
export const PRIORITY_CLASSES = Object.freeze(["low", "normal", "high", "realtime"]);
export const CAPABILITY_LIFECYCLES = Object.freeze(["experimental", "ga", "deprecated", "retired"]);
export const DATA_SENSITIVITY = Object.freeze(["public", "internal", "confidential", "restricted"]);

/**
 * @typedef {object} ProviderRequirement
 * @property {boolean} [json]
 * @property {boolean} [tools]
 * @property {boolean} [vision]
 * @property {boolean} [audio]
 * @property {boolean} [streaming]
 * @property {number}  [minContextTokens]
 * @property {boolean} [reasoning]
 *
 * @typedef {object} CapabilityContract   // IMMUTABLE, code-owned
 * @property {string} key
 * @property {string} version
 * @property {string} name
 * @property {string} description
 * @property {string} category
 * @property {string} businessOwner
 * @property {import("./common.js").SchemaRef} inputSchema
 * @property {import("./common.js").SchemaRef} [outputSchema]
 * @property {string[]} inputModalities
 * @property {(string)} outputModality
 * @property {("sync"|"async"|"streaming"|"batch")} executionClass
 * @property {ProviderRequirement} requires
 * @property {string[]} [dependsOn]
 * @property {("experimental"|"standard"|"important"|"critical")} businessCriticality
 * @property {("low"|"normal"|"high"|"realtime")} priorityClass
 * @property {string} expectedLatency
 * @property {("trivial"|"low"|"medium"|"high")} expectedCostClass
 * @property {object} defaultRetryPolicy
 * @property {("public"|"internal"|"confidential"|"restricted")} dataSensitivity
 * @property {("experimental"|"ga"|"deprecated"|"retired")} lifecycle
 * @property {object} requiredPermissions
 *
 * @typedef {object} CapabilityConfiguration   // MUTABLE, DB-owned, governed
 * @property {string} capabilityKey
 * @property {("PLATFORM"|string)} scope
 * @property {boolean} enabled
 * @property {string} [provider]
 * @property {string} [model]
 * @property {string} [promptKey]
 * @property {string} [runtimeProfile]
 * @property {object} [policySet]
 * @property {object} [keyOwnership]
 * @property {object} [failover]
 * @property {("global_locked"|"workspace_customizable"|"workspace_locked")} lock
 */

/** Freeze a capability CONTRACT definition (pure — no side effects). */
export function defineCapabilityContract(def) {
  return deepFreeze({ ...def });
}
