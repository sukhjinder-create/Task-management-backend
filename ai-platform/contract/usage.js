// ai-platform/contract/usage.js
//
// Contract v2 — Usage (per-modality consumption; Appendix A / §3).
// Pure factory + additive merge. No metering logic (that is the Cost engine,
// a later phase); this is only the data shape.

import { deepFreeze } from "./common.js";

/**
 * @typedef {object} Usage
 * @property {number} [inputTokens]
 * @property {number} [outputTokens]
 * @property {number} [audioSeconds]
 * @property {number} [images]
 * @property {number} [toolCalls]
 */

export function createUsage(u = {}) {
  const out = {};
  for (const k of ["inputTokens", "outputTokens", "audioSeconds", "images", "toolCalls"]) {
    if (u[k] != null) out[k] = u[k];
  }
  return deepFreeze(out);
}

export const emptyUsage = () => createUsage({});

/** Additive merge of two Usage records (pure). */
export function mergeUsage(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const out = {};
  for (const k of keys) out[k] = (Number(a?.[k]) || 0) + (Number(b?.[k]) || 0);
  return deepFreeze(out);
}
