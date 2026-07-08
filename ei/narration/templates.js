// ei/narration/templates.js
//
// EI V2.1 Phase 8 — deterministic business-narration templates. Narration is
// PRESENTATION ONLY: it translates already-computed structured reasoning into business
// language and NEVER introduces a fact that is not present in the structured record.
// Reasoning stays deterministic upstream; these templates are pure string builders
// over the record's own fields. No LLM. If an LLM is later layered on top, these
// templates remain the guaranteed fallback.

const NARRATION_VERSION = 1;

function bandOf(overall = 0) { return overall >= 0.66 ? "high" : overall >= 0.33 ? "moderate" : "low"; }

/** Confidence, in words — built only from the record's own confidence figure. */
export function confidencePhrase(overall = 0) {
  const b = bandOf(overall);
  if (b === "high") return "We are highly confident";
  if (b === "moderate") return "We are moderately confident";
  return "We have limited confidence";
}

/** Tier → careful business verb. Never upgrades an association into a cause. */
export function tierPhrase(tier) {
  if (tier === "C") return "has been shown to drive";
  if (tier === "A") return "is statistically associated with";
  return "tends to accompany"; // Tier O
}

function entityPhrase(entity) {
  if (!entity || entity.id == null) return "this item";
  const type = entity.type ? String(entity.type).toLowerCase() : "item";
  return `${type} ${entity.id}`;
}

const INSUFFICIENT = "There is currently not enough evidence to draw a reliable conclusion.";

/** Narrate a reasoning trace (Phase 4) in business language — facts only from the trace. */
export function narrateTrace(trace) {
  if (!trace || !trace.claim) return INSUFFICIENT;
  const { claim } = trace;
  if (claim.status !== "attributed") return `${INSUFFICIENT} We are surfacing ${entityPhrase(claim.entity)} for a human to review.`;
  const overall = trace.confidenceDecomposition?.overall ?? 0;
  const topFactor = (trace.reasoningChain && trace.reasoningChain[0]?.from?.descriptor) || "observed activity";
  const conf = confidencePhrase(overall);
  return `${capitalize(entityPhrase(claim.entity))} shows "${claim.predicate}". This pattern ${tierPhrase(claim.tier)} ${topFactor}. ${conf}, based on the observed signals. Unobserved factors may also contribute, so this is not a certainty.`;
}

/** Narrate a prediction (Phase 5) — probability band, horizon, and an explicit humility clause. */
export function narratePrediction(prediction, trace = null) {
  if (!prediction) return INSUFFICIENT;
  const overall = trace?.confidenceDecomposition?.overall ?? 0;
  const dir = prediction.predictionValue === "unlikely" ? "unlikely" : "likely";
  const days = prediction.predictionHorizon?.days ?? null;
  const horizon = days != null ? ` within about ${days} days` : "";
  const conf = confidencePhrase(overall).toLowerCase().replace("we are ", "").replace("we have ", "");
  return `Based on the reasoning above, ${entityPhrase(prediction.entity)} appears ${dir} to continue on this path${horizon} (${conf}). This is a probabilistic outlook, not a certainty — the outcome may differ.`;
}

/** Narrate a recommendation (Phase 6) — action, approval, and honest basis. */
export function narrateRecommendation(rec) {
  if (!rec) return INSUFFICIENT;
  if (rec.status === "insufficient_basis") return `${INSUFFICIENT} No action is recommended for ${entityPhrase(rec.entity)} yet.`;
  if (rec.status === "manual_review" || !rec.action) return `We suggest a person reviews ${entityPhrase(rec.entity)}. There is enough signal to warrant attention, but no automatic step is proposed.`;
  const verb = String(rec.action.verb || "act").replace(/_/g, " ");
  const approval = rec.requiresApproval ? " This would require approval before anything changes." : "";
  const band = rec.uncertainty?.band ? ` Our confidence is ${rec.uncertainty.band}.` : "";
  return `We recommend that you ${verb} for ${entityPhrase(rec.entity)}.${approval}${band} Alternatives were considered and are available for review.`;
}

/** Narrate an executive answer (Phase 7) — summarize findings or state the evidence gap plainly. */
export function narrateExecutiveAnswer(answer) {
  if (!answer) return INSUFFICIENT;
  if (answer.status !== "answered") return `We do not yet have enough evidence to answer this: ${answer.reason || "insufficient evidence"}.`;
  const n = answer.findings?.length || 0;
  const first = answer.findings?.[0];
  const lead = first?.factor
    ? `The most frequent contributing factor is "${first.factor}".`
    : first?.entity
      ? `The highest-priority item is ${entityPhrase(first.entity)}.`
      : "";
  return `We found ${n} relevant finding${n === 1 ? "" : "s"} supported by the reasoning records. ${lead}`.trim();
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

export const NARRATION_TEMPLATE_VERSION = NARRATION_VERSION;
export { INSUFFICIENT as INSUFFICIENT_EVIDENCE_PHRASE };
