// tests/ei-attribution.test.js
//
// EI V2.1 Phase 2 self-test: the deterministic Attribution Engine (§5′). Hermetic
// — pure computation over synthetic canonical events + service via DI (no DB).
// The DB attribution store is UNVERIFIED AT RUNTIME (needs a migrated database).

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeAttributions } from "../ei/attribution/engine.js";
import { wilsonInterval, validateAttribution, tierLanguage } from "../ei/attribution/attribution.js";
import { runAttributionForWorkspace } from "../ei/attribution/service.js";

const ev = (seq, type, entType, entId, occurredAt) => ({
  eventId: `e${seq}`, seq, workspaceId: "ws-1", type, occurredAt,
  entities: [{ type: entType, id: entId, role: "primary" }],
});

// 3 slips; unassigned shares Task t-1 (Tier O); a blocked dependency is in-window
// for the first two slips but not the third (Tier A: support 2/3, E3 contradicts).
const events = [
  ev(1, "task.unassigned", "Task", "t-1", "2026-06-12T00:00:00Z"),
  ev(2, "dependency.blocked", "Dependency", "d-1", "2026-06-12T00:00:00Z"),
  ev(3, "task.slipped", "Task", "t-1", "2026-06-20T00:00:00Z"),
  ev(4, "task.slipped", "Task", "t-2", "2026-06-25T00:00:00Z"),
  ev(5, "task.slipped", "Task", "t-3", "2026-06-28T00:00:00Z"),
];

test("Wilson interval is deterministic and bounded", () => {
  const w = wilsonInterval(2, 3);
  assert.ok(Math.abs(w.point - 0.666667) < 1e-3);
  assert.ok(w.low > 0.2 && w.low < w.point && w.high > w.point && w.high < 0.95);
  assert.deepEqual(wilsonInterval(0, 0), { point: null, low: 0, high: 1, n: 0 });
});

test("Tier O: observed same-entity co-occurrence — 'contributed to', no association", () => {
  const attrs = computeAttributions({ workspaceId: "ws-1", events });
  const tierO = attrs.filter((a) => a.tier === "O");
  assert.equal(tierO.length, 1);
  const a = tierO[0];
  assert.equal(a.language, "contributed to");
  assert.equal(a.associationStrength, null);
  assert.equal(a.confidenceSource, "observation");
  assert.deepEqual(a.factor.entity, { type: "Task", id: "t-1" });
  assert.ok(a.supportingEvidence.some((e) => e.type === "task.unassigned"));
  assert.equal(validateAttribution(a).ok, true);
});

test("Tier A: cross-entity association with confounders + Wilson CI + contradicting evidence", () => {
  const attrs = computeAttributions({ workspaceId: "ws-1", events });
  const tierA = attrs.filter((a) => a.tier === "A");
  assert.equal(tierA.length, 2); // the two slips with a blocked dependency in-window
  const a = tierA[0];
  assert.equal(a.language, "associated with");
  assert.ok(Math.abs(a.associationStrength - 0.666667) < 1e-3); // population support 2/3
  assert.ok(a.confidenceInterval.low < a.confidenceInterval.high);
  assert.equal(a.confidenceSource, "association");
  assert.deepEqual(a.recordedConfounders.map((c) => c.name).sort(), ["reassignment", "team_load"]);
  assert.ok(a.contradictingEvidence.some((e) => e.eventId === "e5")); // E3 (t-3) had no factor
  assert.equal(a.provenance.populationSupport, 2);
  assert.equal(a.provenance.populationN, 3);
});

test("NEVER emits 'caused' without Tier C; output is deterministic", () => {
  const first = computeAttributions({ workspaceId: "ws-1", events });
  assert.ok(first.every((a) => a.language !== "caused"));
  const second = computeAttributions({ workspaceId: "ws-1", events });
  assert.deepEqual(first, second); // deterministic (same ids, same order, same content)
});

test("Tier C is dormant until an identification strategy is supplied (experiments phase)", () => {
  const strat = {
    task_slip__dependency_block: {
      type: "natural_experiment",
      assumptions: ["as-if-random availability shock"],
      effectEstimate: 0.4, interval: { low: 0.2, high: 0.6 }, ref: "nexp-1",
    },
  };
  const attrs = computeAttributions({ workspaceId: "ws-1", events, identificationStrategies: strat });
  const tierC = attrs.filter((a) => a.tier === "C");
  assert.equal(tierC.length, 2);
  const c = tierC[0];
  assert.equal(c.language, "caused");
  assert.equal(c.confidenceSource, "experiment");
  assert.equal(c.identificationStrategy.type, "natural_experiment");
  assert.equal(c.associationStrength, 0.4);
  assert.equal(validateAttribution(c).ok, true);
  assert.equal(tierLanguage("C"), "caused");
});

test("service is flag-gated; when ON it computes + appends (DI, no DB)", async () => {
  const prev = process.env.EI_ATTRIBUTION_ENABLED;
  try {
    const written = [];
    const deps = {
      readEvents: async () => events,
      appendAttribution: async (a) => { written.push(a.attributionId); return a.attributionId; },
    };
    delete process.env.EI_ATTRIBUTION_ENABLED;
    assert.equal((await runAttributionForWorkspace({ workspaceId: "ws-1" }, deps)).skipped, "flag_off");

    process.env.EI_ATTRIBUTION_ENABLED = "true";
    const r = await runAttributionForWorkspace({ workspaceId: "ws-1" }, deps);
    assert.equal(r.computed, 3); // 1 Tier O + 2 Tier A
    assert.equal(r.written, 3);
    assert.equal(written.length, 3);
  } finally {
    if (prev === undefined) delete process.env.EI_ATTRIBUTION_ENABLED;
    else process.env.EI_ATTRIBUTION_ENABLED = prev;
  }
});
