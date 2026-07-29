// ei/attribution/rules.js
//
// EI V2.1 §5′ — the DECLARED attribution rule catalog (curation as seed/prior,
// per the constitution). These are transparent, inspectable, code-owned mappings
// of "which factor events plausibly contribute to which effect events" — NOT
// hidden heuristics and NOT learned (learning is a later phase). The engine reads
// this catalog; it contains no logic of its own.
//
//   mode "observed"   → Tier O (same-entity, directly-evidenced co-occurrence)
//   mode "associated" → Tier A (cross-entity association over history + confounders)
// Tier C is never produced from a rule — only when an identification strategy is
// supplied to the engine (experiments phase).

export const ATTRIBUTION_RULES = Object.freeze([
  {
    key: "task_slip__unassigned",
    effectType: "task.slipped",
    factorTypes: ["task.unassigned"],
    windowDays: 14,
    mode: "observed",
    factorDescriptor: "task left unassigned during the slip window",
    confounders: [],
  },
  {
    key: "task_slip__dependency_block",
    effectType: "task.slipped",
    factorTypes: ["dependency.blocked"],
    windowDays: 14,
    mode: "associated",
    factorDescriptor: "an upstream dependency was blocked",
    confounders: ["team_load", "reassignment"],
  },
  {
    key: "sprint_fail__dependency_block",
    effectType: "sprint.failed",
    factorTypes: ["dependency.blocked"],
    windowDays: 21,
    mode: "associated",
    factorDescriptor: "a blocking dependency during the sprint",
    confounders: ["scope_change", "attendance"],
  },
]);

export function getRule(key) {
  return ATTRIBUTION_RULES.find((r) => r.key === key) || null;
}
