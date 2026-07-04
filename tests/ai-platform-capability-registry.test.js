// tests/ai-platform-capability-registry.test.js
//
// P4 self-test: the capability CONTRACT registry (code-owned) after the
// readiness-audit reconciliation. Hermetic — pure in-memory registry, no DB.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getCapability,
  listCapabilities,
  LEGACY_CAPABILITY_KEY,
} from "../ai-platform/capabilities/registry.js";

test("readiness-audit reconciliation: orphans registered, speculative removed", () => {
  // Registered (were unregistered orphans in the audit)
  assert.ok(getCapability("enterprise_intelligence"), "enterprise_intelligence registered");
  assert.equal(getCapability("enterprise_intelligence").requires.json, true);
  assert.ok(getCapability("browser_agent"), "browser_agent registered");

  // Removed (speculative, no backing code)
  for (const k of ["dashboard_summary", "task_suggestions", "risk_analysis"]) {
    assert.equal(getCapability(k), null, `${k} must NOT be registered`);
  }
});

test("every capability carries full Contract v2 §4 metadata and is immutable", () => {
  for (const cap of listCapabilities()) {
    assert.equal(cap.contractVersion, "2.0");
    assert.ok(Array.isArray(cap.inputModalities) && cap.inputModalities.length >= 1);
    assert.ok(["sync", "async", "streaming", "batch"].includes(cap.executionClass));
    assert.ok(["experimental", "standard", "important", "critical"].includes(cap.businessCriticality));
    assert.equal(typeof cap.requires, "object");
    assert.ok(Object.isFrozen(cap), `${cap.key} contract must be immutable`);
    // Backward-compat fields the resolver/runner read must still exist:
    assert.ok("defaultProvider" in cap && "defaultProfile" in cap && "fallbackPrompt" in cap);
  }
});

test("meeting_intelligence declares its sub-capability dependencies + json requirement", () => {
  const mi = getCapability("meeting_intelligence");
  assert.equal(mi.executionClass, "async");
  assert.equal(mi.requires.json, true);
  assert.ok(mi.requires.minContextTokens >= 32000);
  assert.deepEqual(mi.dependsOn, [
    "huddle_topic_segmentation",
    "huddle_risk_blocker_extraction",
    "huddle_language_normalization",
  ]);
});

test("legacy capability exists with empty requirements (no behavior change)", () => {
  const legacy = getCapability(LEGACY_CAPABILITY_KEY);
  assert.ok(legacy);
  assert.deepEqual(legacy.requires, {});
});
