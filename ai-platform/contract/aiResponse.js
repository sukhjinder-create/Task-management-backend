// ai-platform/contract/aiResponse.js
//
// Contract v2 §3 — the AIResponse envelope. Symmetric to AIRequest: output is
// the same Part[] union, so a text summary and a multimodal agent result share
// one shape. Streaming (§3.1) yields the same AIResponse at {type:"final"}.
//
// Pure factory + validator + legacy text extraction. No execution logic.

import { deepFreeze } from "./common.js";
import { AI_CONTRACT_VERSION } from "./version.js";
import { firstText, validateParts } from "./parts.js";

export const RESPONSE_STATUSES = Object.freeze([
  "succeeded", "failed", "partial", "blocked", "scheduled", "cancelled",
]);

/**
 * @typedef {object} AIResponse
 * @property {string} contractVersion
 * @property {string} requestId
 * @property {("succeeded"|"failed"|"partial"|"blocked"|"scheduled"|"cancelled")} status
 * @property {Array<object>} output                       // Part[]
 * @property {Array<object>} [artifacts]
 * @property {Array<object>} [toolCalls]
 * @property {import("./common.js").JsonValue} [structured]
 * @property {Array<object>} [events]
 * @property {Array<object>} [warnings]
 * @property {number} [confidence]
 * @property {object} [safety]
 * @property {import("./usage.js").Usage} [usage]
 * @property {object} [cost]
 * @property {object} [timing]
 * @property {object} [resolution]
 * @property {Record<string,import("./common.js").JsonValue>} [providerMetadata]
 * @property {object} [execution]
 * @property {import("./errors.js").ErrorInfo} [error]
 * @property {object} [stream]
 */

const OPTIONAL_PASSTHROUGH = [
  "artifacts", "toolCalls", "structured", "events", "warnings", "confidence",
  "safety", "usage", "cost", "timing", "resolution", "providerMetadata",
  "execution", "error", "stream",
];

/** @param {Partial<AIResponse>} res @returns {AIResponse} */
export function createAIResponse(res = {}) {
  const envelope = {
    contractVersion: res.contractVersion || AI_CONTRACT_VERSION,
    requestId: res.requestId,
    status: RESPONSE_STATUSES.includes(res.status) ? res.status : "succeeded",
    output: Array.isArray(res.output) ? res.output : [],
  };
  for (const key of OPTIONAL_PASSTHROUGH) if (res[key] !== undefined) envelope[key] = res[key];
  return deepFreeze(envelope);
}

/** @returns {{ok:boolean, warnings:string[], errors:string[]}} */
export function validateAIResponse(res) {
  const warnings = [];
  const errors = [];
  if (!res || typeof res !== "object") return { ok: false, warnings, errors: ["response_must_be_object"] };
  if (typeof res.requestId !== "string") warnings.push("missing_requestId");
  if (!RESPONSE_STATUSES.includes(res.status)) errors.push("invalid_status");
  const pv = validateParts(res.output);
  pv.warnings.forEach((w) => warnings.push(`output${w}`));
  pv.errors.forEach((e) => errors.push(`output${e}`));
  return { ok: errors.length === 0, warnings, errors };
}

/**
 * Extract the legacy text result (first text output part) — the inverse of
 * fromLegacyGenerateText, proving the round-trip. Pure.
 */
export function toLegacyText(res) {
  return firstText(res?.output);
}
