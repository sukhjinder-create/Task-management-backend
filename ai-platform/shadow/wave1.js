// ai-platform/shadow/wave1.js
//
// Epic B — Wave 1 definitions: the internal read-only intelligence capabilities.
// Provides the v2 request binding that MIRRORS the gateway shim's mapping exactly,
// so the shadow v2 request equals what production v2 would build. Note: `options`
// (num_predict/temperature) is intentionally ignored here, EXACTLY as both legacy
// generateText and the gateway shim ignore it — preserving parity.
//
// Wave 1 is shadow-only: NO production call site is cut over. Pure module.

import { createAIRequest, textPart } from "../contract/index.js";

export const WAVE1_CAPABILITIES = Object.freeze([
  "enterprise_intelligence",
  "forecast_reasoning",
  "executive_summary",
  "llm_explanation",
]);

// Legacy transport per capability (documented; drives real shadow wiring in staging).
export const WAVE1_LEGACY_TRANSPORT = Object.freeze({
  enterprise_intelligence: "generateText",
  forecast_reasoning: "generateText",
  executive_summary: "generateText",
  // llm_explanation routes via generateNarrative -> ai-service; its production
  // cutover requires the events->gateway re-path (Epic B'). Shadow compares the
  // gateway output against the captured ai-service output.
  llm_explanation: "generateNarrative->ai-service",
});

/**
 * Build the v2 AIRequest from the SAME arguments the legacy call site passes.
 * Mirrors gatewayGenerateText's mapping (prompt/messages -> Part[]; maxTokens/
 * temperature/json -> runtime.overrides; `options` ignored).
 */
export function buildV2Request(capability, args = {}, { workspaceId = null } = {}) {
  const input =
    Array.isArray(args.messages) && args.messages.length
      ? args.messages.map((m) => textPart({ text: m.content, role: m.role }))
      : [textPart({ text: args.prompt ?? "" })];
  const overrides = {
    maxTokens: args.maxTokens ?? 900,
    temperature: args.temperature ?? 0.4,
    json: args.json ?? false,
  };
  return createAIRequest({
    capability,
    ...(workspaceId ? { tenant: { workspaceId } } : {}),
    input,
    runtime: { overrides },
  });
}
