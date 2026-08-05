// ai-platform/api/invokeService.js
//
// The single external door into the AI Platform. External processes (the ai-task
// service, and any future service) call this via the internal HTTP endpoint; it
// runs the FULL Contract-v2 pipeline (negotiation → safety → prompt → runtime →
// provider → telemetry → cost) via invoke() and returns a legacy-friendly
// { text, response }. There is exactly ONE execution path — this reuses it.

import { invoke } from "../gateway.js";
import { createAIRequest, textPart, toLegacyText } from "../contract/index.js";

/**
 * @param {object} p
 * @param {string} p.capability
 * @param {string} [p.prompt]
 * @param {Array}  [p.messages]
 * @param {string|null} [p.workspaceId]
 * @param {object} [p.overrides]
 * @param {object} [p.trigger]
 * @param {string} [p.sourceModule]
 * @param {object} [p.tools]  Contract §14 ToolDirective ({definitions, mode, allow, deny})
 * @param {object} [p.variables]  prompt-template variables — UNTRUSTED content
 * @param {object} [deps]  gateway deps (tests only)
 */
export async function externalInvoke(
  { capability, prompt, messages, workspaceId = null, overrides = {}, trigger = null, sourceModule = "external", tools = null, variables = null } = {},
  deps = undefined
) {
  const input =
    Array.isArray(messages) && messages.length
      ? messages.map((m) => textPart({ text: m.content, role: m.role }))
      : [textPart({ text: prompt ?? "" })];

  const request = createAIRequest({
    capability: capability || "legacy.generate_text",
    ...(workspaceId ? { tenant: { workspaceId } } : {}),
    input,
    ...(overrides && Object.keys(overrides).length ? { runtime: { overrides } } : {}),
    ...(trigger ? { trigger } : {}),
    ...(tools ? { tools } : {}),
    // Variables were previously dropped here, so an external caller could not
    // use a prompt template AND the safety layer never saw the untrusted values
    // separately from the assembled prompt — which is exactly the trust boundary
    // variable-injection detection exists to police.
    ...(variables && Object.keys(variables).length ? { variables } : {}),
    executionContext: { sourceModule },
  });

  const res = await invoke(request, deps || {});
  return {
    text: toLegacyText(res),
    toolCalls: res.toolCalls || [],
    response: {
      status: res.status,
      resolution: res.resolution,
      usage: res.usage,
      cost: res.cost,
      safety: res.safety,
      negotiation: res.execution?.negotiation,
      correlationId: res.execution?.correlationId,
    },
  };
}
