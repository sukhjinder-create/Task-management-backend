// tests/ai-platform-contract.test.js
//
// P1 self-test: verifies the Contract v2 foundational type layer. Hermetic —
// no DB, no network, no production execution path. Proves: versioning, the Part
// model + forward-compat unknown-kind handling, immutability, envelope
// validation, the legacy {prompt} round-trip, and that port interfaces are
// markers (no implementation).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AI_CONTRACT_VERSION,
  isSupportedContractVersion,
  PART_KINDS,
  textPart,
  jsonPart,
  partKind,
  isKnownPartKind,
  normalizePart,
  validatePart,
  validateParts,
  firstText,
  createUsage,
  mergeUsage,
  createErrorInfo,
  isErrorInfo,
  newTraceContext,
  childSpan,
  createAIRequest,
  validateAIRequest,
  fromLegacyGenerateText,
  createAIResponse,
  validateAIResponse,
  toLegacyText,
  ProviderPortBase,
  ToolPortBase,
  CostEngineBase,
  MemoryPortBase,
} from "../ai-platform/contract/index.js";

// ── Version ───────────────────────────────────────────────────────────────────
test("contract version is frozen at 2.x and additive-minor compatible", () => {
  assert.equal(AI_CONTRACT_VERSION, "2.0");
  assert.equal(isSupportedContractVersion("2.0"), true);
  assert.equal(isSupportedContractVersion("2.7"), true, "future minor is forward-compatible");
  assert.equal(isSupportedContractVersion("1.0"), false);
  assert.equal(isSupportedContractVersion("3.0"), false);
});

// ── Parts + forward compatibility ─────────────────────────────────────────────
test("part factories are immutable and discriminable; unknown kinds pass through, not error", () => {
  const t = textPart({ text: "hi", role: "user" });
  assert.equal(partKind(t), "text");
  assert.equal(t.text, "hi");
  assert.ok(Object.isFrozen(t), "parts are immutable");
  assert.ok(Object.isFrozen(PART_KINDS), "enums are frozen");

  // A future modality the current build has never heard of:
  const future = { kind: "hologram", frames: 3 };
  assert.equal(isKnownPartKind("hologram"), false);
  assert.deepEqual(normalizePart(future), future, "unknown kind preserved (forward-compat)");
  const v = validatePart(future);
  assert.equal(v.ok, true, "unknown kind is NOT an error");
  assert.ok(v.warnings.some((w) => w.startsWith("unknown_part_kind")));

  // Malformed parts ARE errors.
  assert.equal(validatePart({}).ok, false);
  assert.equal(validatePart("nope").ok, false);

  const j = jsonPart({ json: { a: 1 } });
  assert.equal(partKind(j), "json");
  assert.equal(validateParts([t, future, j]).ok, true);
});

// ── Usage / Error ─────────────────────────────────────────────────────────────
test("usage merges additively; error class falls back safely", () => {
  const u = mergeUsage(createUsage({ inputTokens: 5 }), createUsage({ inputTokens: 3, outputTokens: 2 }));
  assert.equal(u.inputTokens, 8);
  assert.equal(u.outputTokens, 2);

  const e = createErrorInfo({ code: "x", class: "not_a_real_class", message: "m" });
  assert.equal(e.class, "internal", "unknown class falls back to internal");
  assert.ok(isErrorInfo(e));
  assert.ok(Object.isFrozen(e));
});

// ── Tracing ───────────────────────────────────────────────────────────────────
test("trace contexts and child spans link correctly", () => {
  const root = newTraceContext();
  assert.ok(root.traceId && root.spanId);
  const child = childSpan(root);
  assert.equal(child.traceId, root.traceId);
  assert.equal(child.parentSpanId, root.spanId);
  assert.notEqual(child.spanId, root.spanId);
});

// ── AIRequest envelope ────────────────────────────────────────────────────────
test("AIRequest requires a capability, auto-fills version/id/tracing, and validates", () => {
  const req = createAIRequest({ capability: "meeting_intelligence", input: [textPart({ text: "q" })] });
  assert.equal(req.contractVersion, "2.0");
  assert.ok(req.requestId);
  assert.ok(req.tracing?.traceId, "tracing auto-filled (Contract §2 requires it)");
  assert.ok(Object.isFrozen(req));
  assert.equal(validateAIRequest(req).ok, true);

  const bad = validateAIRequest({ contractVersion: "9.9", input: [] });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.includes("unsupported_contract_version"));
  assert.ok(bad.errors.includes("missing_capability"));

  // Unknown input part kind → still ok, with a warning (additive evolution).
  const fwd = createAIRequest({ capability: "c", input: [{ kind: "sensor_stream" }] });
  const fv = validateAIRequest(fwd);
  assert.equal(fv.ok, true);
  assert.ok(fv.warnings.some((w) => w.includes("unknown_part_kind")));
});

// ── SUCCESS/EXIT: legacy {prompt} round-trips identically ─────────────────────
test("EXIT: envelope round-trips a legacy text request identical to today's {prompt}", () => {
  const req = fromLegacyGenerateText({ prompt: "Summarize the sprint", maxTokens: 200, workspaceId: "ws-1" });
  assert.equal(req.capability, "legacy.generate_text");
  assert.equal(req.input.length, 1);
  assert.equal(partKind(req.input[0]), "text");
  assert.equal(req.input[0].text, "Summarize the sprint", "prompt text preserved exactly");
  assert.equal(req.tenant.workspaceId, "ws-1");
  assert.equal(req.runtime.overrides.maxTokens, 200);

  // Response side: a text output round-trips back to the legacy string.
  const res = createAIResponse({ requestId: req.requestId, output: [textPart({ text: "done" })] });
  assert.equal(validateAIResponse(res).ok, true);
  assert.equal(toLegacyText(res), "done");
  assert.equal(firstText(req.input), "Summarize the sprint");
});

// ── Port interfaces are markers only (no implementation) ──────────────────────
test("port interfaces throw until implemented (they carry no logic)", async () => {
  assert.throws(() => new ProviderPortBase().describe(), /not implemented/);
  assert.throws(() => new CostEngineBase().estimate(), /not implemented/);
  await assert.rejects(() => new ToolPortBase().invoke(), /not implemented/);
  await assert.rejects(() => new MemoryPortBase().read(), /not implemented/);
});
