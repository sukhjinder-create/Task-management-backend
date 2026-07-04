// ai-platform/gateway.js
//
// THE single choke point for all AI generation. The real execution path is now
// invoke(AIRequest) -> AIResponse (Contract v2 §2/§3). runCapability() and
// gatewayGenerateText() are BACKWARD-COMPATIBLE SHIMS over invoke():
//
//   capability → policy → workspace → provider → model → prompt → runtime
//   → (advisory) compatibility negotiation → execution (adapter) → logging → AIResponse
//
// Nothing bypasses this once callers adopt it. services/llm.js delegates to
// gatewayGenerateText when the platform flag is ON; when OFF the legacy path runs
// and none of this executes (rollback safety). The shims preserve their exact
// prior signatures/return types, and invoke() rethrows the ORIGINAL provider
// error on failure — so flag-ON behavior matches legacy byte-for-byte.

import { randomUUID } from "node:crypto";
import { resolveEffectiveConfig } from "./config/resolver.js";
import { resolveCompatibility } from "./config/compatibilityResolver.js";
import { resolvePromptTemplate } from "./prompts/promptResolver.js";
import { resolveRuntimeOptions } from "./runtime/runtimeProfiles.js";
import { getAdapter } from "./providers/registry.js";
import { checkPolicies } from "./policy/policyEngine.js";
import { withTransientRetry } from "./shared/retry.js";
import { logAiRequest } from "./telemetry/requestLog.js";
import { createAIRequest } from "./contract/aiRequest.js";
import { createAIResponse, toLegacyText } from "./contract/aiResponse.js";
import { textPart } from "./contract/parts.js";
import { createUsage } from "./contract/usage.js";

/**
 * Reconstruct the provider call ({prompt} XOR {messages}) from Part[] input,
 * preserving exactly what the legacy caller passed:
 *  - a single text part with no role  → { prompt }
 *  - multiple text parts or any role   → { messages }
 * Non-text parts (future modalities) are ignored on the text path (forward-compat).
 */
function partsToProviderCall(input) {
  const parts = Array.isArray(input) ? input.filter((p) => p && p.kind === "text") : [];
  const hasRole = parts.some((p) => p.role);
  if (parts.length > 1 || hasRole) {
    return { messages: parts.map((p) => ({ role: p.role || "user", content: String(p.text ?? "") })) };
  }
  return { prompt: parts.length ? String(parts[0].text ?? "") : "" };
}

/**
 * Execute one AIRequest. The uniform Contract v2 execution entrypoint.
 * @param {import("./contract/aiRequest.js").AIRequest} request
 * @param {object} [ctx]  execution context + injectable deps (deps are for tests)
 * @returns {Promise<import("./contract/aiResponse.js").AIResponse>}
 */
export async function invoke(request, ctx = {}) {
  const resolve = ctx.resolve || resolveEffectiveConfig;
  const getAdapterFor = ctx.getAdapterFor || getAdapter;
  const checkPoliciesFn = ctx.checkPolicies || checkPolicies;
  const resolvePrompt = ctx.resolvePromptTemplate || resolvePromptTemplate;
  const logRequestFn = ctx.logAiRequest || logAiRequest;
  const compat = ctx.resolveCompatibility || resolveCompatibility;
  const { signal, correlationId } = ctx;

  const startedAt = Date.now();
  const corr = correlationId || request?.tracing?.traceId || randomUUID();
  const capability = request?.capability;
  const workspaceId = request?.tenant?.workspaceId ?? null;
  const variables = request?.variables || {};
  const callOverrides = request?.runtime?.overrides || {};
  let cfg = null;
  let opts = null;
  const retries = 0;

  try {
    // 1) ConfigResolver: provider/model/profile/prompt-key with inheritance + locking.
    cfg = await resolve({ capabilityKey: capability, workspaceId });

    // 2) Central policy/budget (fails open when unconfigured).
    const policy = await checkPoliciesFn({ workspaceId, providerKey: cfg.providerKey, capabilityKey: cfg.capabilityKey });
    if (!policy.allowed) {
      const err = new Error(policy.reason || "Blocked by AI policy");
      err.code = "AI_POLICY_BLOCKED";
      throw err;
    }

    // 3) Prompt resolution (workspace → platform → code fallback → caller verbatim).
    const template = await resolvePrompt({ promptKey: cfg.promptKey, workspaceId, capabilityKey: cfg.capabilityKey, variables });
    const call = partsToProviderCall(request?.input);
    const finalPrompt = template?.body ?? call.prompt;

    // 4) Runtime options (profile + per-call overrides; call values win).
    opts = resolveRuntimeOptions({ profileKey: cfg.profileKey, profileOverride: cfg.profileParams, callOverrides });

    // 5) CompatibilityResolver (advisory in P3; enforced once `requires` exists).
    const negotiation = compat({ providerKey: cfg.providerKey, modelKey: cfg.model, requires: cfg.requires });

    // 6) Execute through the resolved adapter, with transient retry.
    const adapter = getAdapterFor(cfg.adapterType);
    const result = await withTransientRetry(
      () =>
        adapter.generate({
          model: cfg.model,
          prompt: finalPrompt,
          messages: call.messages,
          options: opts,
          providerConfig: cfg.providerConfig,
          signal,
        }),
      { attempts: opts.retries ?? 2 }
    );

    // 7) Telemetry (best-effort; never throws).
    await logRequestFn({
      workspaceId,
      capabilityKey: cfg.capabilityKey,
      providerKey: cfg.providerKey,
      modelKey: cfg.model || cfg.providerConfig?.defaultModel || null,
      promptKey: template?.promptKey || cfg.promptKey || null,
      promptVersion: template?.version || null,
      profileKey: cfg.profileKey,
      latencyMs: Date.now() - startedAt,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      estCostUsd: null,
      status: "success",
      retries,
      correlationId: corr,
    });

    // 8) Build the Contract v2 AIResponse (symmetric Part[] output).
    return createAIResponse({
      requestId: request?.requestId,
      status: "succeeded",
      output: [textPart({ text: result.text })],
      usage: createUsage(result.usage || {}),
      timing: { latencyMs: Date.now() - startedAt },
      resolution: {
        capability: cfg.capabilityKey,
        provider: cfg.providerKey,
        model: cfg.model || cfg.providerConfig?.defaultModel || null,
        profile: cfg.profileKey,
        promptKey: template?.promptKey || null,
        promptVersion: template?.version || null,
      },
      execution: { retries, correlationId: corr, negotiation },
    });
  } catch (err) {
    await logRequestFn({
      workspaceId,
      capabilityKey: cfg?.capabilityKey || capability || null,
      providerKey: cfg?.providerKey || null,
      modelKey: cfg?.model || null,
      profileKey: cfg?.profileKey || null,
      latencyMs: Date.now() - startedAt,
      status: "failure",
      failureReason: err?.message,
      retries,
      correlationId: corr,
    });
    throw err; // preserve the ORIGINAL error object (parity with legacy generateText)
  }
}

/**
 * Backward-compatible shim: same {text, meta} return as before. Delegates to
 * invoke(). `deps` (2nd arg) is optional and used only by tests; production
 * callers pass one arg, so behavior is unchanged.
 */
export async function runCapability(
  { capability, workspaceId = null, prompt, messages, variables = {}, overrides = {}, signal, correlationId } = {},
  deps = {}
) {
  const input =
    Array.isArray(messages) && messages.length
      ? messages.map((m) => textPart({ text: m.content, role: m.role }))
      : [textPart({ text: prompt ?? "" })];
  const request = createAIRequest({
    capability,
    ...(workspaceId ? { tenant: { workspaceId } } : {}),
    input,
    ...(variables && Object.keys(variables).length ? { variables } : {}),
    ...(overrides && Object.keys(overrides).length ? { runtime: { overrides } } : {}),
  });
  const res = await invoke(request, { signal, correlationId, ...deps });
  return {
    text: toLegacyText(res),
    meta: {
      capability: res.resolution?.capability,
      provider: res.resolution?.provider,
      model: res.resolution?.model,
      profile: res.resolution?.profile,
      promptKey: res.resolution?.promptKey || null,
      promptVersion: res.resolution?.promptVersion || null,
      usage: res.usage || null,
      correlationId: res.execution?.correlationId,
      latencyMs: res.timing?.latencyMs,
    },
  };
}

/**
 * Backward-compatible entrypoint used by services/llm.js when the flag is ON.
 * Returns a plain string, exactly like legacy generateText(). `deps` (2nd arg)
 * is test-only; production passes one arg.
 */
export async function gatewayGenerateText(
  { prompt, messages, maxTokens = 900, json = false, temperature = 0.4, signal, capability, workspaceId = null, variables } = {},
  deps = {}
) {
  const input =
    Array.isArray(messages) && messages.length
      ? messages.map((m) => textPart({ text: m.content, role: m.role }))
      : [textPart({ text: prompt ?? "" })];
  const overrides = { maxTokens, temperature, json };
  const request = createAIRequest({
    capability: capability ?? "legacy.generate_text",
    ...(workspaceId ? { tenant: { workspaceId } } : {}),
    input,
    ...(variables ? { variables } : {}),
    runtime: { overrides },
  });
  const res = await invoke(request, { signal, ...deps });
  return toLegacyText(res);
}
