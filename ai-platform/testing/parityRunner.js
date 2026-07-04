// ai-platform/testing/parityRunner.js
//
// P0 test harness — parity-diff runner.
// Compares a candidate output against a golden record and produces a
// deterministic pass/fail report. The scorer is PLUGGABLE: P0 ships a
// deterministic default (text token-overlap + JSON structural diff); a
// semantic scorer can be injected in a later phase WITHOUT changing this API.
//
// Pure functions. No product code, no network.

function round(n) {
  return Math.round(n * 1000) / 1000;
}

function normalizeText(s) {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function tokenize(s) {
  return normalizeText(s).split(" ").filter(Boolean);
}

function jaccard(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

/** Deterministic text similarity in [0,1]. Identical strings → 1. */
export function textParityScore(golden, candidate) {
  const g = normalizeText(golden);
  const c = normalizeText(candidate);
  if (g === c) return 1;
  const gt = tokenize(g);
  const ct = tokenize(c);
  const j = jaccard(gt, ct);
  const lenRatio = Math.min(gt.length, ct.length) / Math.max(gt.length, ct.length || 1);
  return round(j * 0.7 + lenRatio * 0.3);
}

function flatten(obj, prefix = "", out = {}) {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const k of Object.keys(obj)) flatten(obj[k], prefix ? `${prefix}.${k}` : k, out);
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  } else {
    out[prefix] = obj;
  }
  return out;
}

/** Deterministic JSON structural comparison → { score, diffs }. */
export function jsonParityScore(golden, candidate) {
  const fg = flatten(golden);
  const fc = flatten(candidate);
  const keys = new Set([...Object.keys(fg), ...Object.keys(fc)]);
  if (keys.size === 0) return { score: 1, diffs: [] };
  let match = 0;
  const diffs = [];
  for (const k of [...keys].sort()) {
    if (fg[k] === fc[k]) match += 1;
    else diffs.push({ path: k, golden: fg[k] ?? null, candidate: fc[k] ?? null });
  }
  return { score: round(match / keys.size), diffs };
}

/**
 * Score one candidate against one golden record.
 * @param {object} golden      golden record ({ output, outputType })
 * @param {string|object} candidate
 * @param {object} [opts] { threshold=0.9, scorer } — scorer(golden, candidate)→{score,diffs}
 */
export function scoreParity(golden, candidate, { threshold = 0.9, scorer = null } = {}) {
  if (typeof scorer === "function") {
    const r = scorer(golden, candidate);
    return { score: r.score, pass: r.score >= threshold, diffs: r.diffs || [], scorer: "custom", threshold };
  }
  const type = golden.outputType || (typeof golden.output === "object" ? "json" : "text");
  if (type === "json") {
    const r = jsonParityScore(golden.output, candidate);
    return { score: r.score, pass: r.score >= threshold, diffs: r.diffs, scorer: "json-structural", threshold };
  }
  const score = textParityScore(golden.output, candidate);
  return { score, pass: score >= threshold, diffs: score === 1 ? [] : [{ path: "text", golden: golden.output, candidate }], scorer: "text-jaccard", threshold };
}

/**
 * Run parity over a set of cases.
 * @param {Array<{capability,caseId,golden}>} cases
 * @param {(golden:object)=>Promise<string|object>} produce  candidate producer
 * @param {object} [opts] { threshold, scorer }
 * @returns {Promise<Array>} sorted deterministic results
 */
export async function runParity(cases, produce, opts = {}) {
  const results = [];
  for (const c of cases) {
    const candidate = await produce(c.golden);
    const scored = scoreParity(c.golden, candidate, opts);
    results.push({ capability: c.capability, caseId: c.caseId, ...scored });
  }
  return results.sort((a, b) =>
    a.capability === b.capability ? a.caseId.localeCompare(b.caseId) : a.capability.localeCompare(b.capability)
  );
}

/** Deterministic markdown report. */
export function formatParityReport(results) {
  const lines = [
    "| Capability | Case | Scorer | Score | Threshold | Result |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    lines.push(`| ${r.capability} | ${r.caseId} | ${r.scorer} | ${r.score} | ${r.threshold} | ${r.pass ? "PASS" : "FAIL"} |`);
  }
  const passed = results.filter((r) => r.pass).length;
  lines.push("", `**${passed}/${results.length} passed**`);
  return lines.join("\n");
}
