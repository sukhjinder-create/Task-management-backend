// ai-platform/config/compatibilityResolver.js
//
// P3 — CompatibilityResolver (the second half of the resolver split; the first
// is resolveEffectiveConfig = ConfigResolver). Given a resolved provider/model
// and a capability's ProviderRequirement, it PROVES compatibility via P2
// negotiation. In P3 this is ADVISORY (permissive): capability `requires` is not
// populated until P4, so `checked` is false and nothing is blocked — no behavior
// change. Pure; imports only the pure negotiation module (no DB).

import { negotiate } from "../providers/negotiation.js";

/**
 * @param {{providerKey:string, modelKey?:string|null, requires?:object|null}} args
 * @returns {{ok:boolean, gaps:string[], model?:string, checked:boolean}}
 */
export function resolveCompatibility({ providerKey, modelKey = null, requires = null } = {}) {
  if (!requires || Object.keys(requires).length === 0) {
    return { ok: true, gaps: [], checked: false }; // nothing to prove yet (permissive)
  }
  return { ...negotiate(providerKey, modelKey, requires), checked: true };
}
