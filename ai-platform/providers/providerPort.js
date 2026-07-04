// ai-platform/providers/providerPort.js
//
// P2 — realizes the Contract v2 §5 ProviderPort by COMPOSITION, without changing
// any adapter's generate() (zero regression). getProviderPort(key) combines the
// static descriptor/negotiation (this phase) with the existing adapter's invoke.
// estimateCost/health are permissive placeholders here; the real cost engine is
// P6 and real health probing is a later ops phase.

import { getAdapter, adapterTypeForProviderKey } from "./registry.js";
import { providerDescriptor, modelDescriptor } from "./descriptors.js";
import { negotiate } from "./negotiation.js";

function permissiveCostEstimate() {
  // Permissive: a typed CostEstimate placeholder. Real pricing arrives in P6.
  return { amount: { amount: 0, currency: "USD" }, pricingSource: "unpriced" };
}

/**
 * @param {string} providerKey
 * @param {{adapter?:object}} [opts]  inject an adapter (e.g. MockAdapter) for tests
 * @returns {import("../contract/provider.js").ProviderPort}
 */
export function getProviderPort(providerKey, { adapter = null } = {}) {
  const key = String(providerKey || "").toLowerCase();
  const adapterType = adapterTypeForProviderKey(key);
  const impl = adapter || (adapterType ? getAdapter(adapterType) : null);

  return {
    key,
    describe: () => providerDescriptor(key),
    listModels: async () => {
      const m = modelDescriptor(key);
      return m ? [m] : [];
    },
    negotiate: (requirement, modelKey = null) => negotiate(key, modelKey, requirement),
    invoke: (call) => {
      if (!impl) throw new Error(`No adapter registered for provider "${key}"`);
      return impl.generate(call); // unchanged adapter behavior
    },
    estimateCost: () => permissiveCostEstimate(),
    health: async () => ({ availability: modelDescriptor(key)?.availability || "unknown" }),
    rateLimits: () => ({}),
  };
}
