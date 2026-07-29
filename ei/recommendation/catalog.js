// ei/recommendation/catalog.js
//
// EI V2.1 Phase 6 — the DECLARED recommendation catalog. Contract-in-code (like the
// attribution rule catalog): a transparent, versioned map from a prediction type to
// a structured action + its approval/manual policy + the minimum probability below
// which the signal is treated as insufficient basis. NOT learned, NO LLM. Editing
// this catalog is the only way to change what the engine proposes — fully auditable.

export const RECOMMENDATION_CATALOG_VERSION = 1;

/**
 * Keyed by predictionType (e.g. "risk:task.slipped"). Each policy:
 *   recommendationType : stable business type
 *   action             : structured { verb, target, params } proposed when actionable (never NL)
 *   requiresApproval   : whether execution needs an approval (default true)
 *   manualOnly         : the action is advisory only; never auto-executed
 *   minProbability     : below this, downgrade to insufficient_basis (weak signal)
 */
export const RECOMMENDATION_CATALOG = Object.freeze({
  "risk:task.slipped": Object.freeze({
    recommendationType: "delivery_risk_mitigation",
    action: Object.freeze({ verb: "rebalance_workload", target: "entity", params: Object.freeze({ scope: "assignee_and_dependencies" }) }),
    requiresApproval: true,
    manualOnly: false,
    minProbability: 0.5,
  }),
  "risk:dependency.blocked": Object.freeze({
    recommendationType: "dependency_unblock",
    action: Object.freeze({ verb: "escalate_blocker", target: "entity", params: Object.freeze({ notify: "owner_and_lead" }) }),
    requiresApproval: true,
    manualOnly: false,
    minProbability: 0.5,
  }),
  "risk:project.at_risk": Object.freeze({
    recommendationType: "project_risk_review",
    action: Object.freeze({ verb: "schedule_risk_review", target: "project", params: Object.freeze({ horizon: "next_cycle" }) }),
    requiresApproval: true,
    manualOnly: true,     // high-impact → advisory only, human decides
    minProbability: 0.55,
  }),
});

/** Look up a policy; unknown types get a safe manual-review policy (no automated action). */
export function policyFor(predictionType) {
  const p = RECOMMENDATION_CATALOG[predictionType];
  if (p) return { catalogKey: predictionType, ...p };
  return { catalogKey: null, recommendationType: "manual_review", action: null, requiresApproval: true, manualOnly: true, minProbability: 0 };
}
