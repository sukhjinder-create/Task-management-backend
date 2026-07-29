// ei/prediction/members.js
//
// EI V2.1 Phase 5 — the deterministic ensemble members (§9). Wave A ships the two
// members that need NO learning and NO LLM: attribution-propagation (from the
// reasoning trace) and trend (from a numeric series). Each returns a uniform
// { probability, value, confidence, method } so the engine can fuse them
// transparently with fixed, declared weights. Learned members (leading indicators)
// and narration are later waves.

function clamp01(x) { return Math.min(1, Math.max(0, Math.round(x * 1e6) / 1e6)); }

/** Propagate the reasoning trace's confidence + strongest attribution into a probability. */
export function attributionMember(trace) {
  const overall = trace?.confidenceDecomposition?.overall ?? 0;
  const strongest = trace?.attributionChain?.[0];
  const strength = strongest?.associationStrength != null ? strongest.associationStrength : overall;
  return {
    method: "attribution_propagation",
    probability: clamp01(0.5 * overall + 0.5 * strength),
    value: "adverse",
    confidence: clamp01(overall),
  };
}

/** Deterministic trend member from a numeric series [{value}] — direction of the last window. */
export function trendMember(series = []) {
  const nums = series.map((s) => (typeof s === "number" ? s : Number(s?.value))).filter(Number.isFinite);
  if (nums.length < 2) return { method: "trend", probability: 0.5, value: "flat", confidence: 0 };
  const first = nums[0];
  const last = nums[nums.length - 1];
  const decline = (first - last) / (Math.abs(first) || 1); // positive = declining
  return {
    method: "trend",
    probability: clamp01(0.5 + decline * 0.5), // more decline → higher adverse probability
    value: decline > 0 ? "declining" : "improving",
    confidence: clamp01(Math.min(1, nums.length / 6)),
  };
}
