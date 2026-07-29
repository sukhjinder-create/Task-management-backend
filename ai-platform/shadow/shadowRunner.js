// ai-platform/shadow/shadowRunner.js
//
// Runs a capability through BOTH the legacy and the Contract-v2 paths, compares
// them, and returns a ShadowReport. The v2 output is DISCARDED — shadow mode
// never returns v2 to the caller and is never exposed to users. Best-effort:
// a v2 failure is captured in the report, never propagated into the legacy path.
//
// Comparison dimensions: output parity, latency, cost, safety, negotiation.
// Pure orchestration over injected executors (no network/DB of its own).

import { firstText } from "../contract/parts.js";
import { scoreParity } from "../testing/parityRunner.js";

const now = () => Date.now();
const round = (n) => Math.round(n * 1000) / 1000;

/**
 * @param {object} p
 * @param {string} p.capability
 * @param {()=>Promise<string|{text:string}>} p.legacyExecute
 * @param {()=>Promise<object>} p.v2Execute          resolves to an AIResponse
 * @param {object} [p.golden]                          golden record (ground truth)
 * @param {number} [p.threshold=0.9]
 */
export async function runShadow({ capability, legacyExecute, v2Execute, golden = null, threshold = 0.9 }) {
  const t0 = now();
  const legacy = await legacyExecute();
  const legacyMs = now() - t0;

  let v2 = null;
  let v2Error = null;
  const t1 = now();
  try {
    v2 = await v2Execute();
  } catch (err) {
    v2Error = err?.message || String(err);
  }
  const v2Ms = now() - t1;

  const legacyText = typeof legacy === "string" ? legacy : String(legacy?.text ?? "");
  const v2Text = firstText(v2?.output);
  const ground = golden ? golden.output : legacyText;
  const parity = v2 ? scoreParity({ output: ground, outputType: "text" }, v2Text, { threshold }) : { score: 0, pass: false, scorer: "n/a" };

  return {
    capability,
    exposedToUser: false,
    v2Discarded: true,
    v2Error,
    parity: { score: parity.score, pass: parity.pass, scorer: parity.scorer, threshold },
    output: { legacyMatchesGolden: golden ? legacyText === golden.output : true },
    latency: { legacyMs: round(legacyMs), v2Ms: round(v2Ms), overheadMs: round(v2Ms - legacyMs) },
    cost: v2?.cost || null,
    safety: {
      inputVerdict: v2?.safety?.inputVerdict ?? null,
      outputVerdict: v2?.safety?.outputVerdict ?? null,
      findings: v2?.safety?.findings?.length ?? 0,
      enforced: v2?.safety?.enforced ?? false,
    },
    negotiation: v2?.execution?.negotiation ?? null,
    resolution: v2?.resolution ?? null,
  };
}
