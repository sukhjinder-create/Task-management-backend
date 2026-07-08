// ei/experiments/experiment.js
//
// EI V2.1 Wave C — the Experiment Engine primitives. An experiment is an IMMUTABLE,
// versioned, fully-declared record (design + arms + allocations + references) — there
// is no hidden experimentation: every arm and allocation is auditable, and assignment
// is a DETERMINISTIC function of (subject, experiment) so it is replayable. Reuses
// deepFreeze. No LLM.

import { createHash } from "node:crypto";
import { deepFreeze } from "../../ai-platform/contract/common.js";

export const EXPERIMENT_SCHEMA_VERSION = 1;
export const DESIGNS = Object.freeze(["ab", "holdout", "randomized", "manual", "policy"]);

/** Deterministic uniform value in [0,1) from (subjectId, experimentId). */
export function bucketValue(subjectId, experimentId) {
  const h = createHash("sha256").update(`${experimentId}|${subjectId}`).digest("hex").slice(0, 8);
  return parseInt(h, 16) / 0x100000000;
}

export function createExperiment(f) {
  const { workspaceId, key, design, arms = [], references = {}, hypothesis = null, version = 1, provenance = {} } = f || {};
  const normArms = arms.map((a) => ({ key: String(a.key), allocation: Number(a.allocation) || 0, control: Boolean(a.control) }));
  return deepFreeze({
    experimentId: "exp_" + createHash("sha256").update(JSON.stringify([workspaceId, key, version])).digest("hex").slice(0, 40),
    eiVersion: "2.1",
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    workspaceId: String(workspaceId),
    key: String(key),
    version,
    design,
    arms: normArms,                        // fully declared — auditable
    hypothesis,
    references: {                          // every experiment references what it touches
      recommendationIds: references.recommendationIds || [],
      predictionIds: references.predictionIds || [],
      outcomeIds: references.outcomeIds || [],
    },
    status: "defined",
    provenance: { engineVersion: "ei-exp-1", ...provenance },
  });
}

export function validateExperiment(x) {
  const errors = [];
  if (!x || typeof x !== "object") return { ok: false, errors: ["experiment_must_be_object"] };
  if (!x.experimentId) errors.push("missing_experimentId");
  if (!DESIGNS.includes(x.design)) errors.push("invalid_design");
  if (!Array.isArray(x.arms) || x.arms.length === 0) errors.push("missing_arms");
  if (x.design !== "manual") {
    const sum = (x.arms || []).reduce((s, a) => s + (a.allocation || 0), 0);
    if (Math.abs(sum - 1) > 1e-6) errors.push("arm_allocations_must_sum_to_1");
  }
  if ((x.design === "holdout") && !(x.arms || []).some((a) => a.control)) errors.push("holdout_requires_control_arm");
  return { ok: errors.length === 0, errors };
}

/** Deterministic assignment of a subject to an arm (null for manual design). */
export function assign(subjectId, experiment) {
  if (!experiment || experiment.design === "manual") return { subjectId: String(subjectId), experimentId: experiment?.experimentId ?? null, arm: null, bucket: null, manual: true };
  const v = bucketValue(String(subjectId), experiment.experimentId);
  let acc = 0, chosen = experiment.arms[experiment.arms.length - 1]?.key ?? null;
  for (const a of experiment.arms) { acc += a.allocation; if (v < acc) { chosen = a.key; break; } }
  return { subjectId: String(subjectId), experimentId: experiment.experimentId, arm: chosen, bucket: Math.round(v * 1e6) / 1e6, manual: false };
}

export function assignmentId(experimentId, subjectId) {
  return "asg_" + createHash("sha256").update(`${experimentId}|${subjectId}`).digest("hex").slice(0, 40);
}
