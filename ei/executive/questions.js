// ei/executive/questions.js
//
// EI V2.1 Phase 7 — the catalog of executive question types. Each entry declares
// whether it can be answered from the current reasoning corpus (traces / predictions
// / recommendations / evidence) or whether it structurally REQUIRES outcome history
// (recommendation → execution → outcome) that the deterministic pipeline does not yet
// record. Questions that require outcome history return "insufficient_evidence" with a
// precise reason instead of a fabricated answer — the constitutional humility rule.

export const QUESTION = Object.freeze({
  DELIVERY_SLOWING: "delivery_slowing",                       // Why is delivery slowing?
  PROJECTS_HIGHEST_RISK: "projects_highest_risk",             // Which projects are at highest risk?
  DEPARTMENTS_NEEDING_ATTENTION: "departments_needing_attention", // Which departments need attention?
  RECOMMENDATIONS_WITH_IMPACT: "recommendations_with_impact", // Which recommendations created measurable improvement?
  STRATEGIES_OUTPERFORMING: "strategies_outperforming",       // Which strategies consistently outperform?
  BEHAVIOURS_CHANGING: "behaviours_changing",                 // Which organizational behaviours are changing?
});

/** Declarative metadata — drives which resolver runs and what evidence it needs. */
export const QUESTION_META = Object.freeze({
  [QUESTION.DELIVERY_SLOWING]: { requiresOutcomeHistory: false, requiresDepartmentDimension: false },
  [QUESTION.PROJECTS_HIGHEST_RISK]: { requiresOutcomeHistory: false, requiresDepartmentDimension: false },
  [QUESTION.DEPARTMENTS_NEEDING_ATTENTION]: { requiresOutcomeHistory: false, requiresDepartmentDimension: true },
  [QUESTION.RECOMMENDATIONS_WITH_IMPACT]: { requiresOutcomeHistory: true, requiresDepartmentDimension: false },
  [QUESTION.STRATEGIES_OUTPERFORMING]: { requiresOutcomeHistory: true, requiresDepartmentDimension: false },
  [QUESTION.BEHAVIOURS_CHANGING]: { requiresOutcomeHistory: false, requiresDepartmentDimension: false },
});

export const ALL_QUESTIONS = Object.freeze(Object.values(QUESTION));

/** Predicates that count as "delivery slowing" signals (declared, auditable). */
export const DELIVERY_PREDICATES = Object.freeze(["task.slipped", "delivery.slowed", "milestone.missed", "project.at_risk"]);
