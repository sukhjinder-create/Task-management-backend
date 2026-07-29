// ai-platform/contract/common.js
//
// Contract v2 — shared primitives (Appendix A of the contract).
// Type definitions (JSDoc) + enums + tiny pure helpers ONLY. No execution logic,
// no I/O, no product imports. Nothing here is wired into any runtime path.

/**
 * @typedef {null|boolean|number|string|JsonValue[]|{[k:string]:JsonValue}} JsonValue
 */

/** Open modality set — new modalities are additive (Contract §1.4). */
export const MODALITIES = Object.freeze([
  "text",
  "image",
  "audio",
  "video",
  "document",
  "embedding",
]);

/** Data-residency / PII handling modes (Contract §11). */
export const PII_MODES = Object.freeze(["off", "tag", "redact", "block"]);

/** Enterprise inheritance lock levels (Contract §9/§12). */
export const LOCK_LEVELS = Object.freeze([
  "global_locked",
  "workspace_customizable",
  "workspace_locked",
]);

/**
 * @typedef {"PLATFORM"|{workspaceId:string}} Scope
 * @typedef {{ref:string, version?:string}} SchemaRef  points to a registered JSON-Schema
 * @typedef {{amount:number, currency:string}} Money
 * @typedef {{store:"inline"|"blob"|"s3"|"r2"|"url", ref:string, mime?:string, bytes?:number}} MediaRef
 * @typedef {{type:string, id:string}} EntityRef
 */

/** Deep-freeze a plain data object so contract instances are immutable. */
export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Merge a warnings/errors validation result set (pure). */
export function mergeValidation(...results) {
  const warnings = [];
  const errors = [];
  for (const r of results) {
    if (!r) continue;
    if (Array.isArray(r.warnings)) warnings.push(...r.warnings);
    if (Array.isArray(r.errors)) errors.push(...r.errors);
  }
  return { ok: errors.length === 0, warnings, errors };
}
