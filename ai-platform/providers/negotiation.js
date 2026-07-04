// ai-platform/providers/negotiation.js
//
// P2 — Capability negotiation (Contract v2 §5). Pure function that PROVES a
// provider/model can satisfy a capability's ProviderRequirement, returning the
// exact gaps when it cannot. This is the antidote to silent mis-routing
// (gate Critical #2). No network, no DB, no side effects.

import { providerDescriptor, modelDescriptor } from "./descriptors.js";

/**
 * @param {string} providerKey
 * @param {string|null} modelKey
 * @param {import("../contract/capability.js").ProviderRequirement} requirement
 * @returns {import("../contract/provider.js").Negotiation}  { ok, model?, gaps? }
 */
export function negotiate(providerKey, modelKey, requirement = {}) {
  const desc = providerDescriptor(providerKey);
  if (!desc) return { ok: false, gaps: ["unknown_provider"] };
  // Provider-level availability (e.g. an adapter not yet implemented) fails first.
  if (desc.availability === "unavailable") return { ok: false, gaps: ["provider_unavailable"] };
  const model = modelDescriptor(providerKey, modelKey);
  if (!model) return { ok: false, gaps: ["unknown_model"] };
  if (model.availability === "unavailable") return { ok: false, model: model.key, gaps: ["provider_unavailable"] };

  const gaps = [];
  const need = requirement || {};
  const s = model.supports;

  if (need.json && !s.json) gaps.push("json");
  if (need.tools && !s.tools) gaps.push("tools");
  if (need.vision && !s.vision) gaps.push("vision");
  if (need.audio && !s.audio) gaps.push("audio");
  if (need.streaming && !s.streaming) gaps.push("streaming");
  if (need.reasoning && !s.reasoning) gaps.push("reasoning");
  if (need.minContextTokens != null && Number(model.contextWindowTokens) < Number(need.minContextTokens)) {
    gaps.push("context_window");
  }

  return { ok: gaps.length === 0, model: model.key, gaps };
}

/**
 * Given an ordered list of {provider, model} candidates, return the first that
 * satisfies the requirement (used by failover resolution later). Pure.
 * @returns {{provider:string, model:string}|null}
 */
export function firstCompatible(candidates, requirement) {
  for (const c of candidates || []) {
    const r = negotiate(c.provider, c.model, requirement);
    if (r.ok) return { provider: c.provider, model: r.model };
  }
  return null;
}
