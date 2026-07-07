// ei/attribution/attribution.js
//
// EI V2.1 §5′ — the immutable Attribution structure + deterministic statistics.
// An attribution explains an OBSERVED effect by a contributing factor, at a stated
// TIER. It NEVER says "caused" unless Tier C (with an identification strategy).
// Pure: factory + validator + deterministic id + a deterministic association
// interval (Wilson score). No LLM, no learning, no calibration. Reuses deepFreeze.

import { createHash } from "node:crypto";
import { deepFreeze } from "../../ai-platform/contract/common.js";

export const ATTRIBUTION_SCHEMA_VERSION = 1;
export const TIERS = Object.freeze({ OBSERVED: "O", ASSOCIATED: "A", CAUSAL: "C" });

/** Tier → allowed language. "caused" is reserved for Tier C only. */
export function tierLanguage(tier) {
  if (tier === "C") return "caused";
  if (tier === "A") return "associated with";
  return "contributed to"; // Tier O
}
export function tierConfidenceSource(tier) {
  if (tier === "C") return "experiment";
  if (tier === "A") return "association";
  return "observation"; // Tier O
}

/**
 * Deterministic Wilson score interval for a proportion (successes/n). This is the
 * statistical interval OF THE ASSOCIATION ESTIMATE given the data — NOT calibrated
 * predictive confidence (that is a later phase). Deterministic, no learning.
 * @returns {{point:number|null, low:number, high:number, n:number}}
 */
export function wilsonInterval(successes, n, z = 1.96) {
  const s = Math.max(0, Number(successes) || 0);
  const total = Math.max(0, Number(n) || 0);
  if (total === 0) return { point: null, low: 0, high: 1, n: 0 };
  const p = s / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denom;
  const clamp = (x) => Math.min(1, Math.max(0, Math.round(x * 1e6) / 1e6));
  return { point: clamp(p), low: clamp(center - margin), high: clamp(center + margin), n: total };
}

/** Deterministic, replay-stable attribution id. */
export function deriveAttributionId({ workspaceId, ruleKey, effect, factor, tier, windowFrom }) {
  const salient = JSON.stringify([
    workspaceId, ruleKey, tier,
    effect?.entity?.type ?? null, effect?.entity?.id ?? null, effect?.type ?? null,
    factor?.descriptor ?? null, factor?.entity?.type ?? null, factor?.entity?.id ?? null,
    windowFrom ?? null,
  ]);
  return "attr_" + createHash("sha256").update(salient).digest("hex").slice(0, 40);
}

/**
 * Build an immutable attribution. Enforces the constitutional invariants:
 *  - Tier O: associationStrength = null, no "caused", no identification strategy.
 *  - Tier A: associationStrength + interval + recorded confounders; not "caused".
 *  - Tier C: identificationStrategy REQUIRED; only tier allowed to say "caused".
 */
export function createAttribution({
  workspaceId, ruleKey, effect, factor, tier,
  supportingEvidence = [], contradictingEvidence = [],
  associationStrength = null, confidenceInterval = null, recordedConfounders = [],
  identificationStrategy = null, temporalValidity, provenance,
}) {
  const t = [TIERS.OBSERVED, TIERS.ASSOCIATED, TIERS.CAUSAL].includes(tier) ? tier : TIERS.OBSERVED;
  const windowFrom = temporalValidity?.from ?? null;
  return deepFreeze({
    attributionId: deriveAttributionId({ workspaceId, ruleKey, effect, factor, tier: t, windowFrom }),
    eiVersion: "2.1",
    schemaVersion: ATTRIBUTION_SCHEMA_VERSION,
    workspaceId: String(workspaceId),
    ruleKey,
    effect,                                  // { entity, type, window }
    factor,                                  // { entity, descriptor }
    tier: t,
    language: tierLanguage(t),               // "contributed to" | "associated with" | "caused"
    associationStrength: t === TIERS.OBSERVED ? null : associationStrength,
    confidenceInterval: t === TIERS.OBSERVED ? null : confidenceInterval,
    confidenceSource: tierConfidenceSource(t),
    supportingEvidence,                      // [{ eventId, seq, type, occurredAt }]
    contradictingEvidence,
    recordedConfounders: t === TIERS.OBSERVED ? [] : recordedConfounders,
    identificationStrategy: t === TIERS.CAUSAL ? identificationStrategy : null,
    temporalValidity: temporalValidity || { from: null, to: null },
    provenance: provenance || {},            // { sourceEventIds, engineVersion, computedAt, inputHash }
  });
}

/** @returns {{ok:boolean, errors:string[]}} — enforces the "never caused unless Tier C" law. */
export function validateAttribution(a) {
  const errors = [];
  if (!a || typeof a !== "object") return { ok: false, errors: ["attribution_must_be_object"] };
  if (!a.workspaceId) errors.push("missing_workspaceId");
  if (![TIERS.OBSERVED, TIERS.ASSOCIATED, TIERS.CAUSAL].includes(a.tier)) errors.push("invalid_tier");
  if (a.language === "caused" && a.tier !== TIERS.CAUSAL) errors.push("caused_language_requires_tier_C");
  if (a.tier === TIERS.CAUSAL && !a.identificationStrategy) errors.push("tier_C_requires_identification_strategy");
  if (a.tier === TIERS.OBSERVED && a.associationStrength !== null) errors.push("tier_O_must_not_assert_association");
  if (!Array.isArray(a.supportingEvidence)) errors.push("supportingEvidence_must_be_array");
  return { ok: errors.length === 0, errors };
}
