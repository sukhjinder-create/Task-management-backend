// ei/memory/memory.js
//
// EI V2.1 Wave C — Organizational Memory. Long-term, VERSIONED organizational
// knowledge derived ONLY from validated records — NOT LLM memory. Each record is
// immutable; a change is a new version (supersession by revisionKey), so history is
// replayable. Kinds: validated patterns, repeated failures, successful interventions,
// seasonality, baselines, historical distributions. Deterministic, no LLM. Reuses
// deepFreeze.

import { createHash } from "node:crypto";
import { deepFreeze } from "../../ai-platform/contract/common.js";

export const MEMORY_SCHEMA_VERSION = 1;
export const MEMORY_KIND = Object.freeze(["validated_pattern", "repeated_failure", "successful_intervention", "seasonality", "baseline", "historical_distribution"]);

export function createMemory(f) {
  const { workspaceId, kind, key, value = {}, support = {}, validFrom = null, version = 1, provenance = {} } = f || {};
  if (!workspaceId || !MEMORY_KIND.includes(kind) || !key) return null;
  return deepFreeze({
    memoryId: "mem_" + createHash("sha256").update(JSON.stringify([workspaceId, kind, key, version])).digest("hex").slice(0, 40),
    eiVersion: "2.1",
    schemaVersion: MEMORY_SCHEMA_VERSION,
    workspaceId: String(workspaceId),
    kind,
    key: String(key),
    revisionKey: `${kind}::${key}`,          // latest version per revisionKey = current
    version,
    value,
    support: { sampleSize: support.sampleSize ?? 0, outcomeIds: support.outcomeIds || [] },
    validFrom,
    provenance: { engineVersion: "ei-mem-1", ...provenance },
  });
}

export function validateMemory(m) {
  const errors = [];
  if (!m || typeof m !== "object") return { ok: false, errors: ["memory_must_be_object"] };
  if (!m.memoryId) errors.push("missing_memoryId");
  if (!MEMORY_KIND.includes(m.kind)) errors.push("invalid_kind");
  if (!m.key) errors.push("missing_key");
  if (!(m.version >= 1)) errors.push("invalid_version");
  return { ok: errors.length === 0, errors };
}

/**
 * Derive candidate organizational memory deterministically from validated records.
 * @param {object} p { workspaceId, predictions, outcomes, validation, effectiveness, version? }
 * @returns {object[]} frozen memory records (deterministic order)
 */
export function deriveMemories({ workspaceId, predictions = [], outcomes = [], validation = null, effectiveness = null, version = 1 } = {}) {
  const out = [];
  const predById = Object.fromEntries(predictions.map((p) => [p.predictionId, p]));
  const predOutcomes = outcomes.filter((o) => o.kind === "prediction" || o.refs?.predictionId);

  // repeated_failure: prediction types refuted repeatedly.
  const refutedByType = new Map();
  const evalByType = new Map();
  for (const o of predOutcomes) {
    const pid = o.refs?.predictionId || o.predictionId || o.subjectId;
    const type = predById[pid]?.predictionType;
    if (!type) continue;
    evalByType.set(type, (evalByType.get(type) || 0) + 1);
    if (o.status === "refuted") { if (!refutedByType.has(type)) refutedByType.set(type, { count: 0, outcomeIds: [] }); const r = refutedByType.get(type); r.count += 1; r.outcomeIds.push(o.outcomeId); }
  }
  for (const [type, r] of [...refutedByType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (r.count >= 2) out.push(createMemory({ workspaceId, kind: "repeated_failure", key: type, value: { refuted: r.count, evaluated: evalByType.get(type) || r.count }, support: { sampleSize: evalByType.get(type) || r.count, outcomeIds: r.outcomeIds.sort() }, version }));
  }

  // baseline: validated prediction accuracy (only if evidence-backed).
  if (validation?.metrics?.accuracy?.evidenceSufficient) {
    out.push(createMemory({ workspaceId, kind: "baseline", key: "prediction_accuracy", value: { accuracy: validation.metrics.accuracy.value, brier: validation.metrics.brierScore?.value ?? null }, support: { sampleSize: validation.metrics.evaluated?.value ?? 0 }, version }));
  }

  // historical_distribution: prediction probability deciles.
  if (predictions.length) {
    const dist = Array.from({ length: 10 }, () => 0);
    for (const p of predictions) dist[Math.min(9, Math.floor((p.probability ?? 0) * 10))] += 1;
    out.push(createMemory({ workspaceId, kind: "historical_distribution", key: "prediction_probability_deciles", value: { deciles: dist, n: predictions.length }, support: { sampleSize: predictions.length }, version }));
  }

  // successful_intervention: recommendation groups whose actual impact beat expected.
  for (const g of effectiveness?.groups || []) {
    if (g.metrics?.effectiveness?.evidenceSufficient && g.metrics.effectiveness.value > 1) {
      out.push(createMemory({ workspaceId, kind: "successful_intervention", key: g.key, value: { effectiveness: g.metrics.effectiveness.value }, support: { sampleSize: g.count }, version }));
    }
  }

  return out.filter(Boolean).sort((a, b) => a.memoryId.localeCompare(b.memoryId));
}
