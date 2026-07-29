// execution/lib.js
//
// EWIP V3 — shared primitives for the execution substrate. Reuses the AI Platform's
// deepFreeze (immutability) and schema-tolerant q (DB) — NO duplicate infra. Provides
// a deterministic id helper and a small validation helper so every engine derives
// stable ids the same way. Pure.

import { createHash } from "node:crypto";
export { deepFreeze } from "../ai-platform/contract/common.js";
export { q } from "../ai-platform/studio/db.js";

/** Deterministic, replay-stable id: prefix + sha256(salient parts). */
export function deterministicId(prefix, parts) {
  return `${prefix}_` + createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 40);
}

/** Validate a value against a tiny inline schema { field: {required, type} }. Pure. */
export function validateShape(value, schema) {
  const errors = [];
  const v = value || {};
  for (const [field, spec] of Object.entries(schema || {})) {
    const present = v[field] !== undefined && v[field] !== null && v[field] !== "";
    if (spec.required && !present) { errors.push(`missing_${field}`); continue; }
    if (present && spec.type && typeof v[field] !== spec.type) errors.push(`type_${field}`);
  }
  return { ok: errors.length === 0, errors };
}

export function nowIso(now) { return new Date(now ?? Date.now()).toISOString(); }
