// ai-platform/gateway.js
//
// THE single choke point for all AI text generation. Every AI request in the
// platform flows through runCapability():
//
//   capability → policy resolution → workspace resolution → provider resolution
//   → model resolution → prompt resolution → runtime profile → budget check
//   → execution (adapter) → logging → response
//
// Nothing bypasses this once callers adopt it. During migration, services/llm.js
// delegates here when the feature flag is on; when off, the legacy path runs and
// this file is not touched (guaranteeing rollback safety).

import { randomUUID } from "node:crypto";
import { resolveEffectiveConfig } from "./config/resolver.js";
import { resolvePromptTemplate } from "./prompts/promptResolver.js";
import { resolveRuntimeOptions } from "./runtime/runtimeProfiles.js";
import { getAdapter } from "./providers/registry.js";
import { checkPolicies } from "./policy/policyEngine.js";
import { withTransientRetry } from "./shared/retry.js";
import { logAiRequest } from "./telemetry/requestLog.js";

/**
 * Execute an AI capability.
 *
 * @param {object} req
 * @param {string}  req.capability          capability key (e.g. "meeting_intelligence")
 * @param {string|null} req.workspaceId
 * @param {string}  [req.prompt]            caller-built prompt (used verbatim if no template)
 * @param {Array}   [req.messages]          OpenAI-style messages (optional)
 * @param {object}  [req.variables]         template variables for prompt rendering
 * @param {object}  [req.overrides]         explicit per-call { maxTokens, temperature, json, ... }
 * @param {AbortSignal} [req.signal]
 * @param {string}  [req.correlationId]
 * @returns {Promise<{ text: string, meta: object }>}
 */
export async function runCapability({
  capability,
  workspaceId = null,
  prompt,
  messages,
  variables = {},
  overrides = {},
  signal,
  correlationId,
} = {}) {
  const startedAt = Date.now();
  const corr = correlationId || randomUUID();
  let cfg = null;
  let opts = null;
  let retries = 0;

  try {
    // 1) Resolve provider/model/profile/prompt-key with inheritance + locking.
    cfg = await resolveEffectiveConfig({ capabilityKey: capability, workspaceId });

    // 2) Central policy/budget enforcement (fails open when unconfigured).
    const policy = await checkPolicies({
      workspaceId,
      providerKey: cfg.providerKey,
      capabilityKey: cfg.capabilityKey,
    });
    if (!policy.allowed) {
      const err = new Error(policy.reason || "Blocked by AI policy");
      err.code = "AI_POLICY_BLOCKED";
      throw err;
    }

    // 3) Prompt resolution (workspace → platform → code fallback → caller verbatim).
    const template = await resolvePromptTemplate({
      promptKey: cfg.promptKey,
      workspaceId,
      capabilityKey: cfg.capabilityKey,
      variables,
    });
    const finalPrompt = template?.body ?? prompt;

    // 4) Runtime options (profile + per-call overrides; call values win).
    opts = resolveRuntimeOptions({
      profileKey: cfg.profileKey,
      profileOverride: cfg.profileParams,
      callOverrides: overrides,
    });

    // 5) Execute through the resolved adapter, with transient retry.
    const adapter = getAdapter(cfg.adapterType);
    const result = await withTransientRetry(
      () =>
        adapter.generate({
          model: cfg.model,
          prompt: finalPrompt,
          messages,
          options: opts,
          providerConfig: cfg.providerConfig,
          signal,
        }),
      { attempts: opts.retries ?? 2 }
    );

    // 6) Telemetry (best-effort).
    await logAiRequest({
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
      estCostUsd: null, // cost estimation lands with the model cost table wiring (Phase 2)
      status: "success",
      retries,
      correlationId: corr,
    });

    return {
      text: result.text,
      meta: {
        capability: cfg.capabilityKey,
        provider: cfg.providerKey,
        model: cfg.model || cfg.providerConfig?.defaultModel || null,
        profile: cfg.profileKey,
        promptKey: template?.promptKey || null,
        promptVersion: template?.version || null,
        usage: result.usage || null,
        correlationId: corr,
        latencyMs: Date.now() - startedAt,
      },
    };
  } catch (err) {
    await logAiRequest({
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
    throw err;
  }
}

/**
 * Backward-compatible entrypoint used by services/llm.js when the platform flag
 * is ON. Signature and return type (a plain string) mirror the legacy
 * generateText() so callers are unaffected.
 */
export async function gatewayGenerateText({
  prompt,
  messages,
  maxTokens = 900,
  json = false,
  temperature = 0.4,
  signal,
  capability, // optional: callers may opt into a capability id
  workspaceId = null,
  variables,
} = {}) {
  const { text } = await runCapability({
    capability, // undefined => LEGACY_CAPABILITY_KEY inside resolver
    workspaceId,
    prompt,
    messages,
    variables,
    overrides: { maxTokens, temperature, json },
    signal,
  });
  return text;
}
