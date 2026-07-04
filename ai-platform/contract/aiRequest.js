// ai-platform/contract/aiRequest.js
//
// Contract v2 §2 — the AIRequest envelope: the single, versioned entry object
// for ALL AI work. Modality-agnostic (Part[] input), additive-only, immutable.
//
// Pure factory + validator + a legacy-shape constructor. NOTHING here executes
// anything — it only assembles and validates data. No routing, no provider, no DB.

import { randomUUID } from "node:crypto";
import { deepFreeze } from "./common.js";
import { AI_CONTRACT_VERSION, isSupportedContractVersion } from "./version.js";
import { textPart, validateParts } from "./parts.js";
import { newTraceContext, isTraceContext } from "./tracing.js";

/**
 * @typedef {object} RequestIdentity
 * @property {string} [actorId]
 * @property {("user"|"service"|"system")} [actorType]
 *
 * @typedef {object} TenantContext
 * @property {("PLATFORM"|string)} [workspaceId]
 * @property {string} [residency]
 * @property {string} [plan]
 *
 * @typedef {object} AIRequest
 * @property {string} contractVersion
 * @property {string} requestId
 * @property {string} [idempotencyKey]
 * @property {RequestIdentity} [identity]
 * @property {TenantContext} [tenant]
 * @property {string} capability
 * @property {string} [capabilityVersion]
 * @property {import("./tracing.js").Trigger} [trigger]
 * @property {import("./tracing.js").ExecutionContext} [executionContext]
 * @property {Array<object>} input                       // Part[]
 * @property {object} [conversation]
 * @property {Array<object>} [attachments]
 * @property {Record<string,import("./common.js").JsonValue>} [variables]
 * @property {object} [memory]                            // MemoryDirective (§15)
 * @property {object} [retrieval]                         // RetrievalDirective (§16)
 * @property {object} [tools]                             // ToolDirective (§14)
 * @property {object} [runtime]                           // RuntimeDirective (§8)
 * @property {object} [routing]                           // governed hint (§2)
 * @property {object} [scheduling]                        // SchedulingDirective (§13)
 * @property {object} [streaming]                         // StreamingDirective (§2)
 * @property {object} [security]                          // SecurityDirective (§11)
 * @property {object} [compliance]                        // ComplianceDirective (§11)
 * @property {object} [cost]                              // CostDirective (§17)
 * @property {import("./tracing.js").TraceContext} tracing
 * @property {object} [cancellation]
 * @property {Record<string,import("./common.js").JsonValue>} [metadata]
 */

const OPTIONAL_PASSTHROUGH = [
  "idempotencyKey", "identity", "tenant", "capabilityVersion", "trigger",
  "executionContext", "conversation", "attachments", "variables", "memory",
  "retrieval", "tools", "runtime", "routing", "scheduling", "streaming",
  "security", "compliance", "cost", "cancellation", "metadata",
];

/**
 * Assemble an immutable AIRequest. `tracing` is auto-created if absent so the
 * §2 "tracing REQUIRED" invariant always holds without callers doing work.
 * @param {Partial<AIRequest>} req
 * @returns {AIRequest}
 */
export function createAIRequest(req = {}) {
  const envelope = {
    contractVersion: req.contractVersion || AI_CONTRACT_VERSION,
    requestId: req.requestId || randomUUID(),
    capability: req.capability,
    input: Array.isArray(req.input) ? req.input : [],
    tracing: isTraceContext(req.tracing) ? req.tracing : newTraceContext(),
  };
  for (const key of OPTIONAL_PASSTHROUGH) {
    if (req[key] !== undefined) envelope[key] = req[key];
  }
  return deepFreeze(envelope);
}

/**
 * Validate an AIRequest. Unknown part kinds / extra fields are NOT errors
 * (additive-only, forward-compatible). Missing capability/input/version are.
 * @returns {{ok:boolean, warnings:string[], errors:string[]}}
 */
export function validateAIRequest(req) {
  const warnings = [];
  const errors = [];
  if (!req || typeof req !== "object") return { ok: false, warnings, errors: ["request_must_be_object"] };
  if (!isSupportedContractVersion(req.contractVersion)) errors.push("unsupported_contract_version");
  if (typeof req.capability !== "string" || req.capability.length === 0) errors.push("missing_capability");
  const pv = validateParts(req.input);
  pv.warnings.forEach((w) => warnings.push(`input${w}`));
  pv.errors.forEach((e) => errors.push(`input${e}`));
  if (!isTraceContext(req.tracing)) warnings.push("missing_tracing");
  return { ok: errors.length === 0, warnings, errors };
}

/** OpenAI-style messages → text Parts (pure, preserves role). */
export function messagesToParts(messages = []) {
  return messages.map((m) => textPart({ text: m.content, role: m.role }));
}

/**
 * Build an AIRequest from the LEGACY generateText shape. This is a pure
 * constructor used to prove the envelope round-trips today's `{prompt}` — it
 * does NOT execute anything and is not wired into services/llm.js.
 * @param {{prompt?:string, messages?:Array, maxTokens?:number, temperature?:number, json?:boolean, capability?:string, workspaceId?:string}} opts
 * @returns {AIRequest}
 */
export function fromLegacyGenerateText(opts = {}) {
  const input =
    Array.isArray(opts.messages) && opts.messages.length
      ? messagesToParts(opts.messages)
      : [textPart({ text: opts.prompt ?? "" })];
  const overrides = {};
  if (opts.maxTokens != null) overrides.maxTokens = opts.maxTokens;
  if (opts.temperature != null) overrides.temperature = opts.temperature;
  if (opts.json != null) overrides.json = opts.json;
  return createAIRequest({
    capability: opts.capability || "legacy.generate_text",
    ...(opts.workspaceId ? { tenant: { workspaceId: opts.workspaceId } } : {}),
    input,
    ...(Object.keys(overrides).length ? { runtime: { overrides } } : {}),
  });
}
