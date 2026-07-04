// ai-platform/runtime/runtimeProfiles.js
//
// Runtime Profiles abstract the ~10 raw sampling parameters into a handful of
// named intents an admin can reason about. "balanced" is defined to reproduce
// the legacy defaults from services/llm.js (temperature 0.4, top_k 20, top_p
// 0.9, maxTokens 900) so nothing changes when a capability has no explicit profile.
//
// Precedence at execution time (highest first):
//   explicit per-call override  >  workspace profile  >  capability profile  >  "balanced"
// Per-call maxTokens/temperature always win, which preserves each call site's
// current behavior when the platform is enabled.

export const SYSTEM_PROFILES = Object.freeze({
  balanced:      { temperature: 0.4, topP: 0.9, topK: 20, maxTokens: 900,  json: false, retries: 2 },
  creative:      { temperature: 0.9, topP: 0.95, topK: 40, maxTokens: 1200, json: false, retries: 2 },
  analytical:    { temperature: 0.2, topP: 0.85, topK: 20, maxTokens: 1200, json: false, retries: 2 },
  deterministic: { temperature: 0.0, topP: 0.1,  topK: 1,  maxTokens: 900,  json: false, retries: 2 },
  fast:          { temperature: 0.3, topP: 0.9,  topK: 20, maxTokens: 400,  json: false, retries: 1 },
  low_cost:      { temperature: 0.3, topP: 0.9,  topK: 20, maxTokens: 350,  json: false, retries: 1 },
  high_quality:  { temperature: 0.5, topP: 0.95, topK: 40, maxTokens: 2000, json: false, retries: 3 },
});

export const DEFAULT_PROFILE_KEY = "balanced";

export function listProfiles() {
  return Object.keys(SYSTEM_PROFILES);
}

/**
 * Resolve the effective option object.
 * @param {object} p
 * @param {string|null} p.profileKey        capability/workspace profile
 * @param {object|null} p.profileOverride   custom params (Advanced mode / DB profile row)
 * @param {object} p.callOverrides          explicit per-call { maxTokens, temperature, json, topP, topK, timeoutMs, numGpu }
 */
export function resolveRuntimeOptions({ profileKey = null, profileOverride = null, callOverrides = {} } = {}) {
  const base = SYSTEM_PROFILES[profileKey] || SYSTEM_PROFILES[DEFAULT_PROFILE_KEY];
  const merged = { ...base, ...(profileOverride || {}) };

  // Per-call explicit values win (undefined values do not clobber).
  for (const [k, v] of Object.entries(callOverrides || {})) {
    if (v !== undefined && v !== null) merged[k] = v;
  }
  return merged;
}
