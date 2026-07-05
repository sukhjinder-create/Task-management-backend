// ai-platform/studio/playground.service.js
//
// Epic C — Playground: run a capability once through the real gateway and return
// the full AIResponse (output, resolution, usage, cost, safety, execution) for
// inspection. Sandbox: the result is returned, not persisted as a capability
// action. Testable via DI; a real run hits a provider → UNVERIFIED AT RUNTIME.

import { invoke } from "../gateway.js";
import { createAIRequest, textPart, toLegacyText } from "../contract/index.js";

/**
 * @param {object} p
 * @param {string} p.capability
 * @param {string} p.prompt
 * @param {string|null} [p.workspaceId]
 * @param {object} [p.overrides]  { maxTokens, temperature, json }
 * @param {object} [deps]         injected gateway deps (tests only)
 */
export async function runPlayground({ capability, prompt, workspaceId = null, overrides = {} }, deps = undefined) {
  const request = createAIRequest({
    capability: capability || "legacy.generate_text",
    ...(workspaceId ? { tenant: { workspaceId } } : {}),
    input: [textPart({ text: prompt ?? "" })],
    ...(overrides && Object.keys(overrides).length ? { runtime: { overrides } } : {}),
    trigger: { eventType: "playground.run" },
    executionContext: { sourceModule: "ai_studio_playground" },
  });

  const started = Date.now();
  try {
    const res = await invoke(request, deps || {});
    return {
      ok: true,
      text: toLegacyText(res),
      response: {
        status: res.status,
        resolution: res.resolution,
        usage: res.usage,
        cost: res.cost,
        safety: res.safety,
        negotiation: res.execution?.negotiation,
        latencyMs: res.timing?.latencyMs ?? Date.now() - started,
      },
    };
  } catch (err) {
    return { ok: false, error: { message: err?.message, code: err?.code || null }, latencyMs: Date.now() - started };
  }
}
