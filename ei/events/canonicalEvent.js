// ei/events/canonicalEvent.js
//
// EI V2.1 §7 — the canonical, immutable event envelope. Pure: it NORMALIZES the
// existing emitWorkspaceEvent domain event into the EI canonical shape (adds
// entity refs array + a deterministic idempotency key; sequencing is assigned by
// the store). No new event bus, no business logic — reuses the domain event that
// already carries workspaceId / eventType / entity / correlation / timestamp.
//
// Reuses the AI Platform contract's deepFreeze (shared util, no duplication).

import { randomUUID, createHash } from "node:crypto";
import { deepFreeze } from "../../ai-platform/contract/common.js";

export const EI_EVENT_VERSION = "2.1";

/** Stable, sorted-key stringify for a deterministic idempotency hash. */
function stableStringify(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
  }
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return JSON.stringify(v ?? null);
}

/** Deterministic dedup key: identical domain events map to the same key. */
export function deriveIdempotencyKey(domainEvent) {
  const salient = {
    w: domainEvent.workspaceId,
    t: domainEvent.eventType,
    et: domainEvent.entityType ?? null,
    ei: domainEvent.entityId ?? null,
    ts: domainEvent.timestamp ?? null,
    sv: domainEvent.schemaVersion ?? 1,
  };
  return "ei_" + createHash("sha256").update(stableStringify(salient)).digest("hex").slice(0, 40);
}

/** Normalize to typed entity refs: the primary entity + any related refs in metadata.entities. */
export function normalizeEntities(domainEvent) {
  const out = [];
  if (domainEvent.entityType) out.push({ type: domainEvent.entityType, id: domainEvent.entityId ?? null, role: "primary" });
  const related = Array.isArray(domainEvent.metadata?.entities) ? domainEvent.metadata.entities : [];
  for (const e of related) if (e && e.type) out.push({ type: e.type, id: e.id ?? null, role: e.role || "related" });
  return out;
}

/**
 * Build a canonical EI event from an emitWorkspaceEvent domain event.
 * @returns {object|null} frozen canonical event, or null if not ingestible.
 */
export function fromDomainEvent(domainEvent) {
  if (!domainEvent || !domainEvent.workspaceId || !domainEvent.eventType) return null;
  return deepFreeze({
    eiVersion: EI_EVENT_VERSION,
    eventId: domainEvent.eventId || randomUUID(),
    workspaceId: String(domainEvent.workspaceId),
    type: String(domainEvent.eventType),
    schemaVersion: Math.max(1, Number(domainEvent.schemaVersion) || 1),
    occurredAt: domainEvent.timestamp || new Date().toISOString(),
    recordedAt: new Date().toISOString(),
    actor: { type: domainEvent.actorUserId ? "user" : "system", id: domainEvent.actorUserId ?? null },
    entities: normalizeEntities(domainEvent),
    trace: {
      traceId: domainEvent.traceId ?? null,
      correlationId: domainEvent.correlationId ?? null,
      causationId: domainEvent.causationId ?? null,
    },
    origin: domainEvent.origin || "internal",
    source: `eventBus:${domainEvent.eventType}`,
    idempotencyKey: deriveIdempotencyKey(domainEvent),
    payload: domainEvent.metadata || {},
  });
}

/** @returns {{ok:boolean, errors:string[]}} */
export function validateCanonicalEvent(e) {
  const errors = [];
  if (!e || typeof e !== "object") return { ok: false, errors: ["event_must_be_object"] };
  if (e.eiVersion !== EI_EVENT_VERSION) errors.push("unsupported_ei_version");
  if (!e.workspaceId) errors.push("missing_workspaceId");
  if (!e.type) errors.push("missing_type");
  if (!e.occurredAt) errors.push("missing_occurredAt");
  if (!Array.isArray(e.entities)) errors.push("entities_must_be_array");
  if (!e.idempotencyKey) errors.push("missing_idempotencyKey");
  return { ok: errors.length === 0, errors };
}
