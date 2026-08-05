// ai-platform/safety/enforcement.js
//
// Decides whether a safety finding actually STOPS a request, as opposed to
// merely being recorded.
//
// The pipeline has always detected prompt injection and PII and then done
// nothing with the result: "computes verdicts and findings (tagging), but the
// gateway NEVER blocks". For a platform whose inputs are chat messages and
// meeting transcripts written by other people, detection without enforcement is
// a log of attacks that succeeded.
//
// Two deliberate design decisions, because getting these wrong would be worse
// than not enforcing at all:
//
// 1. PII NEVER BLOCKS. A meeting transcript containing an email address or a
//    phone number is normal, expected content — that is what the product is
//    for. Blocking on PII would disable Meeting Intelligence entirely. PII stays
//    a tag (and a redaction candidate later); it is not an attack signal.
//
// 2. VARIABLE INJECTION IS THE HIGH-CONFIDENCE SIGNAL. A template variable is
//    untrusted content crossing a trust boundary into a trusted prompt — that is
//    precisely the injection threat model. Injection-shaped text in the overall
//    prompt is much weaker evidence: a user can legitimately ask "what does
//    'ignore previous instructions' mean?", and a transcript can legitimately
//    quote an attack. So the default enforcing mode blocks only on variables,
//    and blocking on any injection is opt-in beyond that.
//
// Modes (AI_SAFETY_ENFORCEMENT):
//   off        (default) detect and record only — byte-identical to before
//   variables  block when an untrusted VARIABLE carries injection
//   strict     block on any input-side injection finding
//
// Rollout mirrors the platform's other gates: a workspace allow-list lets a
// single tenant be canaried before anything global changes.

const MODES = Object.freeze(["off", "variables", "strict"]);

/** Finding types that may ever justify a block. PII is deliberately absent. */
const BLOCKABLE_BY_MODE = Object.freeze({
  off: [],
  variables: ["variable_injection"],
  strict: ["variable_injection", "prompt_injection"],
});

function csv(value) {
  return String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Resolve the enforcement mode for a workspace.
 * Unknown or malformed values fall back to "off" — a misconfigured safety flag
 * must never block traffic by accident.
 * @returns {"off"|"variables"|"strict"}
 */
export function safetyEnforcementMode(workspaceId = null) {
  const canary = csv(process.env.AI_SAFETY_ENFORCEMENT_WORKSPACES);
  if (workspaceId && canary.includes(String(workspaceId))) {
    const canaryMode = String(process.env.AI_SAFETY_ENFORCEMENT_CANARY_MODE || "variables").toLowerCase();
    return MODES.includes(canaryMode) ? canaryMode : "variables";
  }
  const mode = String(process.env.AI_SAFETY_ENFORCEMENT || "off").toLowerCase();
  return MODES.includes(mode) ? mode : "off";
}

/**
 * Should this set of input findings stop the request?
 * @param {Array} findings
 * @param {string} mode
 * @returns {{blocked: boolean, reason?: string, types?: string[]}}
 */
export function evaluateBlock(findings = [], mode = "off") {
  const blockable = BLOCKABLE_BY_MODE[mode] || [];
  if (!blockable.length) return { blocked: false };

  const hits = (findings || []).filter(
    (f) => f && f.stage === "input" && blockable.includes(f.type)
  );
  if (!hits.length) return { blocked: false };

  const types = [...new Set(hits.map((f) => f.type))];
  return {
    blocked: true,
    types,
    reason:
      types.includes("variable_injection")
        ? "Untrusted input contained prompt-injection instructions."
        : "Input contained prompt-injection instructions.",
  };
}

export const SAFETY_MODES = MODES;
