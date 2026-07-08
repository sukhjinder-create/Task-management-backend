// ei/narration/narrator.js
//
// EI V2.1 Phase 8 — the narrator. It picks the right deterministic template for a
// record and (optionally) lets an injected Contract-V2 invoke function rephrase the
// template text. Key guarantees:
//   • The deterministic template is ALWAYS computed first and is the source of truth.
//   • An LLM, if supplied, only REPHRASES that template — it is never given free rein
//     to introduce facts, and any failure/empty result falls back to the template.
//   • This module NEVER imports the AI gateway itself (no second gateway); the caller
//     injects the Contract-V2 `invoke` fn, keeping LLM usage isolated behind Contract V2.
// Structured source references are always attached so narration stays traceable.

import { narrateTrace, narratePrediction, narrateRecommendation, narrateExecutiveAnswer } from "./templates.js";

function templateFor(kind, record, context) {
  switch (kind) {
    case "trace": return narrateTrace(record);
    case "prediction": return narratePrediction(record, context?.trace || null);
    case "recommendation": return narrateRecommendation(record);
    case "executiveAnswer": return narrateExecutiveAnswer(record);
    default: return "";
  }
}

function sourceRefsFor(kind, record) {
  switch (kind) {
    case "trace": return { traceId: record?.traceId, evidenceIds: record?.referencedEvidence || [], attributionIds: record?.referencedAttribution || [] };
    case "prediction": return { predictionId: record?.predictionId, traceId: record?.supportingReasoningTraceId };
    case "recommendation": return { recommendationId: record?.recommendationId, ...(record?.rationaleRefs || {}) };
    case "executiveAnswer": return record?.references || {};
    default: return {};
  }
}

/**
 * @param {object} p
 * @param {string} p.kind    "trace" | "prediction" | "recommendation" | "executiveAnswer"
 * @param {object} p.record  the structured EI record to narrate
 * @param {object} [p.context] e.g. { trace } for a prediction
 * @param {object} [deps]    { llm } — optional async ({ template, record }) => string (Contract V2)
 * @returns {Promise<{text:string, mode:"deterministic"|"llm", kind:string, sourceRefs:object}>}
 */
export async function narrate({ kind, record, context } = {}, deps = {}) {
  const template = templateFor(kind, record, context);
  const sourceRefs = sourceRefsFor(kind, record);
  const base = { kind, sourceRefs, templateText: template };

  if (typeof deps.llm !== "function") return { ...base, text: template, mode: "deterministic" };

  try {
    const rephrased = await deps.llm({ template, record, kind });
    const text = typeof rephrased === "string" && rephrased.trim() ? rephrased.trim() : template;
    return { ...base, text, mode: text === template ? "deterministic" : "llm" };
  } catch {
    // Contract-V2 path unavailable/failed → deterministic templates must still work.
    return { ...base, text: template, mode: "deterministic" };
  }
}
