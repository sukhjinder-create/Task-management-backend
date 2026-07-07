// tests/ei-event-pipeline.test.js
//
// EI V2.1 Phase 1 self-test: the immutable event pipeline. Hermetic — pure
// canonicalization + flag gating + observer wiring via DI (no DB, no bus mutation
// of production). The DB event store (append/read under advisory lock) is
// UNVERIFIED AT RUNTIME (needs a migrated database).

import { test } from "node:test";
import assert from "node:assert/strict";

import { isEiEnabled, isEiEventPipelineEnabled } from "../ei/config/flags.js";
import { fromDomainEvent, deriveIdempotencyKey, normalizeEntities, validateCanonicalEvent, EI_EVENT_VERSION } from "../ei/events/canonicalEvent.js";
import { eiIngestObserver } from "../ei/events/ingestObserver.js";
import { bootstrapEnterpriseIntelligence } from "../ei/bootstrap.js";

const domainEvent = {
  eventId: "evt-1",
  workspaceId: "ws-1",
  actorUserId: "u-9",
  eventType: "task.completed",
  entityType: "Task",
  entityId: "t-42",
  origin: "internal",
  schemaVersion: 1,
  correlationId: "corr-1",
  traceId: "trace-1",
  metadata: { points: 3, entities: [{ type: "Project", id: "p-7", role: "parent" }] },
  timestamp: "2026-07-07T10:00:00.000Z",
};

test("flags default OFF (no production behavior change)", () => {
  // (ambient env may or may not set these; the DEFAULT is OFF)
  assert.equal(typeof isEiEnabled(), "boolean");
  assert.equal(isEiEventPipelineEnabled("nope-workspace"), false);
});

test("fromDomainEvent normalizes into the canonical envelope", () => {
  const c = fromDomainEvent(domainEvent);
  assert.equal(c.eiVersion, EI_EVENT_VERSION);
  assert.equal(c.workspaceId, "ws-1");
  assert.equal(c.type, "task.completed");
  assert.equal(c.occurredAt, "2026-07-07T10:00:00.000Z"); // temporal truth preserved
  assert.equal(c.actor.type, "user");
  assert.equal(c.actor.id, "u-9");
  assert.deepEqual(c.entities[0], { type: "Task", id: "t-42", role: "primary" });
  assert.deepEqual(c.entities[1], { type: "Project", id: "p-7", role: "parent" });
  assert.equal(c.trace.traceId, "trace-1");
  assert.ok(c.idempotencyKey.startsWith("ei_"));
  assert.ok(Object.isFrozen(c));
  assert.equal(validateCanonicalEvent(c).ok, true);
});

test("idempotency key is deterministic (dedup) and discriminating", () => {
  assert.equal(deriveIdempotencyKey(domainEvent), deriveIdempotencyKey({ ...domainEvent }));
  assert.notEqual(deriveIdempotencyKey(domainEvent), deriveIdempotencyKey({ ...domainEvent, entityId: "t-99" }));
});

test("entity normalization + validation reject malformed events", () => {
  assert.deepEqual(normalizeEntities({ entityType: "User", entityId: "u-1" }), [{ type: "User", id: "u-1", role: "primary" }]);
  assert.equal(fromDomainEvent({ eventType: "x" }), null); // missing workspaceId
  assert.equal(fromDomainEvent({ workspaceId: "w" }), null); // missing type
  assert.equal(validateCanonicalEvent({ eiVersion: "2.1", workspaceId: "w" }).ok, false);
});

test("ingest observer is flag-gated and never touches the store when OFF", async () => {
  const prev = process.env.EI_EVENT_PIPELINE_ENABLED;
  try {
    let appended = null;
    const spy = { appendEvent: async (c) => { appended = c; return 7; } };

    // OFF → skipped, store NOT called
    delete process.env.EI_EVENT_PIPELINE_ENABLED;
    const off = await eiIngestObserver(domainEvent, spy);
    assert.equal(off.skipped, "flag_off");
    assert.equal(appended, null);

    // ON → ingests, canonical event handed to the store
    process.env.EI_EVENT_PIPELINE_ENABLED = "true";
    const on = await eiIngestObserver(domainEvent, spy);
    assert.equal(on.ingested, true);
    assert.equal(on.seq, 7);
    assert.equal(appended.type, "task.completed");

    // never throws on garbage
    const bad = await eiIngestObserver(null, spy);
    assert.equal(bad.skipped, "not_ingestible");
  } finally {
    if (prev === undefined) delete process.env.EI_EVENT_PIPELINE_ENABLED;
    else process.env.EI_EVENT_PIPELINE_ENABLED = prev;
  }
});

test("bootstrap registers the ingest observer idempotently", () => {
  const r1 = bootstrapEnterpriseIntelligence();
  assert.equal(r1.bootstrapped, true);
  assert.ok(r1.observers.some((o) => o.name === "ei-event-ingest"));
  const r2 = bootstrapEnterpriseIntelligence(); // idempotent
  assert.equal(r2.bootstrapped, true);
});
