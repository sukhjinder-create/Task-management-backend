// ai-platform/contract/parts.js
//
// Contract v2 §2.1 — the Part model: the extensibility primitive. Input and
// output are ordered lists of typed Parts (a discriminated union with an OPEN
// variant). Adding a modality = adding a Part kind. Consumers switch on `kind`
// and ignore unknown kinds (forward compatibility).
//
// Pure factories + guards + validators. No execution logic.

import { deepFreeze, isPlainObject } from "./common.js";

/** Known part kinds (open set — unknown kinds are valid and pass through). */
export const PART_KINDS = Object.freeze([
  "text",
  "json",
  "image",
  "audio",
  "video",
  "document",
  "tool_call",
  "tool_result",
  "citation",
  "reasoning",
  "embedding",
  "binary",
]);

const PART_ROLES = Object.freeze(["system", "developer", "user", "assistant", "tool"]);

/**
 * @typedef {object} PartBase
 * @property {string} kind
 * @property {("system"|"developer"|"user"|"assistant"|"tool")} [role]
 * @property {string} [id]
 */

function base(kind, { role, id } = {}) {
  const p = { kind };
  if (role !== undefined) p.role = role;
  if (id !== undefined) p.id = id;
  return p;
}

// ── Factories (each returns a frozen, immutable Part) ─────────────────────────
export const textPart = ({ text, role, language, id } = {}) =>
  deepFreeze({ ...base("text", { role, id }), text: String(text ?? ""), ...(language ? { language } : {}) });

export const jsonPart = ({ json, schemaRef, role, id } = {}) =>
  deepFreeze({ ...base("json", { role, id }), json: json ?? null, ...(schemaRef ? { schemaRef } : {}) });

export const imagePart = ({ ref, detail, role, id } = {}) =>
  deepFreeze({ ...base("image", { role, id }), ref, ...(detail ? { detail } : {}) });

export const audioPart = ({ ref, durationMs, role, id } = {}) =>
  deepFreeze({ ...base("audio", { role, id }), ref, ...(durationMs != null ? { durationMs } : {}) });

export const videoPart = ({ ref, durationMs, role, id } = {}) =>
  deepFreeze({ ...base("video", { role, id }), ref, ...(durationMs != null ? { durationMs } : {}) });

export const documentPart = ({ ref, mime, pages, role, id } = {}) =>
  deepFreeze({ ...base("document", { role, id }), ref, mime, ...(pages != null ? { pages } : {}) });

export const toolCallPart = ({ toolCallId, name, args, role, id } = {}) =>
  deepFreeze({ ...base("tool_call", { role, id }), toolCallId, name, arguments: args ?? {} });

export const toolResultPart = ({ toolCallId, result, error, role, id } = {}) =>
  deepFreeze({ ...base("tool_result", { role, id }), toolCallId, result: result ?? null, ...(error ? { error } : {}) });

export const citationPart = ({ sourceId, span, score, role, id } = {}) =>
  deepFreeze({ ...base("citation", { role, id }), sourceId, ...(span ? { span } : {}), ...(score != null ? { score } : {}) });

export const reasoningPart = ({ text, redacted, role, id } = {}) =>
  deepFreeze({ ...base("reasoning", { role, id }), ...(text != null ? { text } : {}), ...(redacted != null ? { redacted } : {}) });

export const embeddingPart = ({ vector, dims, ref, role, id } = {}) =>
  deepFreeze({ ...base("embedding", { role, id }), ...(vector ? { vector } : {}), ...(dims != null ? { dims } : {}), ...(ref ? { ref } : {}) });

// ── Guards / discrimination ───────────────────────────────────────────────────
export const partKind = (part) => (isPlainObject(part) ? part.kind : undefined);
export const isKnownPartKind = (kind) => PART_KINDS.includes(kind);
export const isPart = (part) => isPlainObject(part) && typeof part.kind === "string" && part.kind.length > 0;

/**
 * Forward-compat normalizer: returns the part unchanged if it has a string kind
 * (known OR unknown), or null if it is not a valid part. Unknown kinds are NOT
 * an error — they are preserved so newer producers can round-trip through older
 * consumers (Contract §1.2/§2.1).
 */
export function normalizePart(part) {
  return isPart(part) ? part : null;
}

/**
 * Validate a single part. Unknown kinds → warning (ok:true). Missing/blank kind
 * or a non-object → error.
 * @returns {{ok:boolean, warnings:string[], errors:string[]}}
 */
export function validatePart(part) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(part)) errors.push("part_must_be_object");
  else if (typeof part.kind !== "string" || part.kind.length === 0) errors.push("part_missing_kind");
  else {
    if (!isKnownPartKind(part.kind)) warnings.push(`unknown_part_kind:${part.kind}`);
    if (part.role !== undefined && !PART_ROLES.includes(part.role)) warnings.push(`unknown_part_role:${part.role}`);
  }
  return { ok: errors.length === 0, warnings, errors };
}

/** Validate an ordered list of parts. */
export function validateParts(parts) {
  const warnings = [];
  const errors = [];
  if (!Array.isArray(parts)) return { ok: false, warnings, errors: ["parts_must_be_array"] };
  parts.forEach((p, i) => {
    const r = validatePart(p);
    r.warnings.forEach((w) => warnings.push(`[${i}] ${w}`));
    r.errors.forEach((e) => errors.push(`[${i}] ${e}`));
  });
  return { ok: errors.length === 0, warnings, errors };
}

/** Convenience: first text part's text, or "" (used for legacy text extraction). */
export function firstText(parts) {
  const p = Array.isArray(parts) ? parts.find((x) => partKind(x) === "text") : null;
  return p ? String(p.text ?? "") : "";
}
