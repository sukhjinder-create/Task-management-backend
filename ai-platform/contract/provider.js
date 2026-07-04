// ai-platform/contract/provider.js
//
// Contract v2 §5 — Provider contract (interface only).
// Type definitions + an abstract port marker. NO adapter, NO SDK, NO logic.
// Concrete adapters (a later concern) implement ProviderPortBase.

/**
 * @typedef {object} ProviderDescriptor
 * @property {string} displayName
 * @property {string} adapterProtocol   "openai_chat"|"anthropic_messages"|"gemini"|...
 * @property {{modalitiesIn:string[], modalitiesOut:string[], json:boolean, tools:boolean, streaming:boolean, embeddings:boolean, reasoning:boolean, vision:boolean, audio:boolean, batch:boolean}} supports
 * @property {("bearer"|"api_key_header"|"sigv4"|"oauth"|"none")} authStyle
 * @property {string[]} [regions]
 *
 * @typedef {object} ProviderHealth
 * @property {("available"|"limited"|"unavailable")} availability
 * @property {number} [successRate]
 * @property {number} [p95LatencyMs]
 *
 * @typedef {object} Negotiation
 * @property {boolean} ok
 * @property {string} [model]
 * @property {string[]} [gaps]
 */

/**
 * The Provider port. Every provider is reachable ONLY through an implementation
 * of this interface (Contract §1.1/§5). Documented here as the permanent shape.
 * @typedef {object} ProviderPort
 * @property {()=>ProviderDescriptor} describe
 * @property {()=>Promise<import("./model.js").ModelDescriptor[]>} listModels
 * @property {(req:object)=>Negotiation} negotiate
 * @property {(call:object)=>Promise<object>} invoke
 * @property {(call:object)=>AsyncIterable<object>} [stream]
 * @property {(call:object)=>object} estimateCost
 * @property {()=>Promise<ProviderHealth>} health
 * @property {()=>object} rateLimits
 */

/** Ordered list of methods a concrete provider adapter must implement. */
export const PROVIDER_PORT_METHODS = Object.freeze([
  "describe", "listModels", "negotiate", "invoke", "estimateCost", "health", "rateLimits",
]);

/** Abstract interface marker (no behavior). Implementations override methods. */
export class ProviderPortBase {
  describe() { throw new Error("ProviderPort.describe() not implemented"); }
  async listModels() { throw new Error("ProviderPort.listModels() not implemented"); }
  negotiate() { throw new Error("ProviderPort.negotiate() not implemented"); }
  async invoke() { throw new Error("ProviderPort.invoke() not implemented"); }
  estimateCost() { throw new Error("ProviderPort.estimateCost() not implemented"); }
  async health() { throw new Error("ProviderPort.health() not implemented"); }
  rateLimits() { throw new Error("ProviderPort.rateLimits() not implemented"); }
}
