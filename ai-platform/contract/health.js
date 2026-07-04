// ai-platform/contract/health.js
//
// Contract v2 §18 — Health contract (interface only). Type definitions + a
// HealthContract port marker. No metrics collection or rollup logic.

/**
 * @typedef {object} ProviderHealth
 * @property {number} [successRate]
 * @property {number} [p50LatencyMs]
 * @property {number} [p95LatencyMs]
 * @property {Record<string,number>} [errorTaxonomy]
 * @property {number} [rateLimitHits]
 * @property {("available"|"limited"|"unavailable")} availability
 *
 * @typedef {object} CapabilityHealth
 * @property {number} volume
 * @property {number} failureRate
 * @property {number} [budgetBurn]
 * @property {number} [sloAttainment]
 *
 * @typedef {object} PlatformHealth
 * @property {object} slos
 * @property {number} [queueDepth]
 * @property {number} [dlqSize]
 * @property {object[]} [alerts]
 *
 * HealthContract port (interface). Implementations arrive in a later phase.
 * @typedef {object} HealthContract
 * @property {(key:string)=>ProviderHealth} provider
 * @property {(providerKey:string, key:string)=>object} model
 * @property {(key:string)=>CapabilityHealth} capability
 * @property {(key:string, version:number)=>object} prompt
 * @property {(scope:object)=>object} cost
 * @property {()=>PlatformHealth} platform
 */

export const HEALTH_CONTRACT_METHODS = Object.freeze([
  "provider", "model", "capability", "prompt", "cost", "platform",
]);

export class HealthContractBase {
  provider() { throw new Error("HealthContract.provider() not implemented"); }
  model() { throw new Error("HealthContract.model() not implemented"); }
  capability() { throw new Error("HealthContract.capability() not implemented"); }
  prompt() { throw new Error("HealthContract.prompt() not implemented"); }
  cost() { throw new Error("HealthContract.cost() not implemented"); }
  platform() { throw new Error("HealthContract.platform() not implemented"); }
}
