// ai-platform/safety/pipeline.js
//
// P7 — the safety pipeline (Contract v2 §11). PERMISSIVE in Epic A: it computes
// verdicts and findings (tagging), but the gateway NEVER blocks or transforms
// the prompt/output on these results in Epic A — enforcement is E2. This
// guarantees zero behavior change while making the safety signal trustworthy.
//
// Pure functions. No network, no DB.

import { scanInjection } from "./injection.js";
import { detectPii } from "./pii.js";
import { evaluateBlock } from "./enforcement.js";

/** Verdict is advisory in Epic A: "flag" when findings exist, else "allow". Never "block". */
function verdictFor(findings) {
  return findings.length > 0 ? "flag" : "allow";
}

/**
 * Input-side safety: scans the (trusted) final prompt for injection and PII, and
 * inspects each (untrusted) template variable for injection. Detection only.
 * @returns {{inputVerdict:string, findings:Array}}
 */
export function runInputSafety({ prompt, messages, variables = {} } = {}) {
  const findings = [];
  const text = [prompt, ...(Array.isArray(messages) ? messages.map((m) => m?.content) : [])]
    .filter(Boolean)
    .join("\n");

  const inj = scanInjection(text);
  if (inj.flagged) findings.push({ stage: "input", type: "prompt_injection", detail: inj.matches });

  const pii = detectPii(text);
  if (pii.found) findings.push({ stage: "input", type: "pii", detail: pii.types });

  // Untrusted variables are inspected separately (trust-boundary awareness).
  for (const [name, value] of Object.entries(variables || {})) {
    if (typeof value !== "string") continue;
    const vinj = scanInjection(value);
    if (vinj.flagged) findings.push({ stage: "input", type: "variable_injection", detail: { variable: name, matches: vinj.matches } });
  }

  return { inputVerdict: verdictFor(findings), findings };
}

/**
 * Output-side safety: output-schema validation hook (no-op until a schema is
 * registered) + PII tagging of the model output. Detection only.
 * @returns {{outputVerdict:string, findings:Array, schemaChecked:boolean}}
 */
export function runOutputSafety({ text, outputSchemaRef = null } = {}) {
  const findings = [];
  const schemaChecked = false; // schema registry arrives in a later phase; permissive no-op

  const pii = detectPii(text);
  if (pii.found) findings.push({ stage: "output", type: "pii", detail: pii.types });

  return { outputVerdict: verdictFor(findings), findings, schemaChecked };
}

/**
 * Merge input + output safety into a Contract §11 SafetyReport.
 *
 * Advisory by default: with enforcement off (the default) this returns exactly
 * what it always did — verdicts of "allow"/"flag", enforced: false, and nothing
 * blocked. Enforcement is opt-in per deployment or per workspace; see
 * ./enforcement.js for why PII never blocks and variable injection does.
 *
 * @param {object} [options]
 * @param {string} [options.mode]  resolved enforcement mode ("off" when omitted)
 */
export function mergeSafety(input, output, { mode = "off" } = {}) {
  const findings = [...(input?.findings || []), ...(output?.findings || [])];
  const decision = evaluateBlock(input?.findings || [], mode);

  return {
    inputVerdict: decision.blocked ? "block" : input?.inputVerdict || "allow",
    outputVerdict: output?.outputVerdict || "allow",
    findings,
    redactions: [], // detection only; redaction is a later phase
    enforced: mode !== "off",
    mode,
    ...(decision.blocked
      ? { blocked: { stage: "input", reason: decision.reason, types: decision.types } }
      : {}),
  };
}
