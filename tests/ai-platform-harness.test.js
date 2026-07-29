// tests/ai-platform-harness.test.js
//
// P0 self-test: the AI Platform migration test harness IS the P0 deliverable,
// so this suite verifies the harness itself on fixtures. Fully hermetic — no
// database, no network, no provider keys, no production code paths.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MockAdapter,
  saveGolden,
  loadGolden,
  listGoldenCases,
  listGoldenCapabilities,
  captureGolden,
  stableStringify,
  textParityScore,
  jsonParityScore,
  scoreParity,
  runParity,
  formatParityReport,
  percentile,
  captureBaseline,
  compareToBaseline,
  withFlags,
  resetAiFlags,
  isAiPlatformEnabled,
} from "../ai-platform/testing/index.js";

// ── Provider mock/fixtures ────────────────────────────────────────────────────
test("MockAdapter is deterministic, echoes by default, and honors the adapter contract", async () => {
  const adapter = new MockAdapter();
  const r1 = await adapter.generate({ prompt: "hello world", options: {} });
  const r2 = await adapter.generate({ prompt: "hello world", options: {} });
  assert.equal(r1.text, "hello world");
  assert.equal(r1.text, r2.text); // deterministic
  assert.ok(r1.usage && typeof r1.usage.inputTokens === "number");
  assert.ok(r1.raw && r1.raw.mock === true);
  assert.equal(adapter.calls.length, 2);

  const scripted = new MockAdapter({ table: { ping: "pong" } });
  assert.equal((await scripted.generate({ prompt: "ping" })).text, "pong");

  const jsonAdapter = new MockAdapter({ script: () => ({ a: 1 }) });
  assert.equal((await jsonAdapter.generate({ prompt: "x", options: { json: true } })).text, '{"a":1}');
});

// ── Golden-output corpus infra ────────────────────────────────────────────────
test("golden fixtures load and stableStringify is deterministic", () => {
  const basic = loadGolden("sample_echo", "case-basic");
  const json = loadGolden("sample_echo", "case-json");
  assert.equal(basic.outputType, "text");
  assert.equal(json.outputType, "json");
  assert.deepEqual(listGoldenCases("sample_echo"), ["case-basic", "case-json"]);
  assert.ok(listGoldenCapabilities().includes("sample_echo"));

  const a = stableStringify({ b: 1, a: { d: 2, c: 3 } });
  const b = stableStringify({ a: { c: 3, d: 2 }, b: 1 });
  assert.equal(a, b); // key order independent
});

test("golden round-trips through save/load in an isolated temp dir", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-golden-"));
  try {
    saveGolden(
      { capability: "tmp_cap", caseId: "c1", input: { prompt: "p" }, output: "o" },
      { baseDir }
    );
    const loaded = loadGolden("tmp_cap", "c1", { baseDir });
    assert.equal(loaded.output, "o");
    assert.equal(loaded.outputType, "text");
    assert.deepEqual(listGoldenCases("tmp_cap", { baseDir }), ["c1"]);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

// ── Parity-diff runner ────────────────────────────────────────────────────────
test("text/JSON parity scoring behaves as specified", () => {
  assert.equal(textParityScore("on track", "on track"), 1);
  assert.ok(textParityScore("the review went well", "totally different sentence") < 0.9);

  const same = jsonParityScore({ a: 1, b: 2 }, { a: 1, b: 2 });
  assert.equal(same.score, 1);
  const diff = jsonParityScore({ a: 1, b: 2 }, { a: 1, b: 9 });
  assert.equal(diff.score, 0.5);
  assert.equal(diff.diffs[0].path, "b");
});

test("scoreParity selects scorer by outputType and honors a pluggable custom scorer", () => {
  const textGolden = { output: "hello", outputType: "text" };
  assert.equal(scoreParity(textGolden, "hello").scorer, "text-jaccard");
  const jsonGolden = { output: { x: 1 }, outputType: "json" };
  assert.equal(scoreParity(jsonGolden, { x: 1 }).scorer, "json-structural");

  const custom = scoreParity(textGolden, "anything", { scorer: () => ({ score: 1, diffs: [] }) });
  assert.equal(custom.scorer, "custom");
  assert.equal(custom.pass, true);
});

test("runParity over the sample capability: identical candidate passes, perturbed fails; report is deterministic", async () => {
  const cases = ["case-basic", "case-json"].map((caseId) => ({
    capability: "sample_echo",
    caseId,
    golden: loadGolden("sample_echo", caseId),
  }));

  // Candidate = exact golden output → all PASS
  const passResults = await runParity(cases, (g) => g.output);
  assert.ok(passResults.every((r) => r.pass), "identical candidate must pass parity");

  // Determinism: same inputs → identical report string, twice
  const report1 = formatParityReport(await runParity(cases, (g) => g.output));
  const report2 = formatParityReport(await runParity(cases, (g) => g.output));
  assert.equal(report1, report2);
  assert.match(report1, /2\/2 passed/);

  // Perturbed candidate → at least one FAIL
  const failResults = await runParity(cases, (g) =>
    g.outputType === "json" ? { ...g.output, status: "changed" } : "completely unrelated output text"
  );
  assert.ok(failResults.some((r) => !r.pass), "perturbed candidate must fail parity");
});

// ── Latency/cost baseline capture ─────────────────────────────────────────────
test("baseline percentile math and tolerance comparison", () => {
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);

  const baseline = captureBaseline({ capability: "x", latencyMs: [100, 110, 120, 130], costUsd: [0.01, 0.01] });
  const within = compareToBaseline(
    { latency: { p95: baseline.latency.p95 }, cost: { mean: baseline.cost.mean } },
    baseline
  );
  assert.equal(within.pass, true);

  const regressed = compareToBaseline(
    { latency: { p95: baseline.latency.p95 * 2 }, cost: { mean: baseline.cost.mean * 2 } },
    baseline
  );
  assert.equal(regressed.pass, false);
  assert.equal(regressed.latencyPass, false);
  assert.equal(regressed.costPass, false);
});

// ── Flag plumbing ─────────────────────────────────────────────────────────────
test("flag control toggles the real platform flag reader and restores state", async () => {
  resetAiFlags();
  assert.equal(isAiPlatformEnabled(), false, "default OFF");

  const inside = await withFlags({ AI_PLATFORM_ENABLED: "true" }, () => isAiPlatformEnabled());
  assert.equal(inside, true, "flag ON inside scope");
  assert.equal(isAiPlatformEnabled(), false, "restored to OFF after scope");

  const canary = await withFlags({ AI_PLATFORM_ENABLED_WORKSPACES: "ws-123" }, () =>
    isAiPlatformEnabled("ws-123")
  );
  assert.equal(canary, true, "canary workspace enabled");
  resetAiFlags();
});

// ── Exit-criterion demonstration ──────────────────────────────────────────────
test("EXIT: harness can capture 'legacy' output for ANY capability and diff a candidate", async () => {
  // `produce` stands in for the legacy path (generateText) in later phases.
  const legacy = new MockAdapter({ fixedText: "legacy answer v1" });
  const record = await captureGolden({
    capability: "any_future_capability",
    caseId: "smoke",
    input: { prompt: "q" },
    produce: async (input) => (await legacy.generate({ prompt: input.prompt })).text,
    meta: { provider: "mock" },
  });
  assert.equal(record.output, "legacy answer v1");
  assert.ok(record.meta.latencyMs >= 0);

  // Diff a matching candidate (PASS) and a divergent one (FAIL).
  const matching = scoreParity({ output: record.output, outputType: "text" }, "legacy answer v1");
  assert.equal(matching.pass, true);
  const divergent = scoreParity({ output: record.output, outputType: "text" }, "brand new different answer");
  assert.equal(divergent.pass, false);
});
