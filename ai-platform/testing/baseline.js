// ai-platform/testing/baseline.js
//
// P0 test harness — latency/cost baseline capture + comparison.
// Records per-capability latency percentiles and cost, and checks a candidate
// run against a captured baseline within tolerance bands. This is the machinery
// behind the "no latency regressions / no cost regressions" gates (later phases
// populate real baselines; P0 ships + self-tests the math).
//
// Pure functions. No product code, no network.

function round(n, dp = 3) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Nearest-rank percentile over a numeric sample. */
export function percentile(samples, p) {
  const nums = samples.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const rank = Math.ceil((p / 100) * nums.length);
  return nums[Math.min(Math.max(rank, 1), nums.length) - 1];
}

export function mean(samples) {
  const nums = samples.map(Number).filter(Number.isFinite);
  if (nums.length === 0) return null;
  return round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

/** Summarize a set of latency (ms) and cost (usd) samples into a baseline. */
export function captureBaseline({ capability, latencyMs = [], costUsd = [] }) {
  return {
    capability,
    n: latencyMs.length,
    latency: { p50: percentile(latencyMs, 50), p95: percentile(latencyMs, 95), mean: mean(latencyMs) },
    cost: { mean: mean(costUsd), total: round(costUsd.reduce((a, b) => a + (Number(b) || 0), 0)) },
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Compare a current run to a baseline within tolerance bands.
 * @returns {{pass:boolean, latencyPass:boolean, costPass:boolean, details:object}}
 */
export function compareToBaseline(current, baseline, { latencyP95TolerancePct = 20, costTolerancePct = 15 } = {}) {
  const details = {};
  let latencyPass = true;
  let costPass = true;

  if (baseline?.latency?.p95 != null && current?.latency?.p95 != null) {
    const limit = baseline.latency.p95 * (1 + latencyP95TolerancePct / 100);
    latencyPass = current.latency.p95 <= limit;
    details.latency = { baselineP95: baseline.latency.p95, currentP95: current.latency.p95, limit: round(limit), pass: latencyPass };
  }

  if (baseline?.cost?.mean != null && current?.cost?.mean != null) {
    const limit = baseline.cost.mean * (1 + costTolerancePct / 100);
    costPass = current.cost.mean <= limit;
    details.cost = { baselineMean: baseline.cost.mean, currentMean: current.cost.mean, limit: round(limit), pass: costPass };
  }

  return { pass: latencyPass && costPass, latencyPass, costPass, details };
}
