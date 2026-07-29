// ei/experiments/service.js
//
// EI V2.1 Wave C — orchestration for the experiment engine. Deterministic, flag-gated,
// additive. Defines experiments (append-only) and produces deterministic, replayable
// subject assignments. Nothing is hidden: every experiment and assignment is stored.

import { createExperiment, validateExperiment, assign, assignmentId } from "./experiment.js";
import { appendExperiment, appendAssignment } from "./store.js";
import { isEiExperimentsEnabled } from "../config/flags.js";

/** @param {object} args experiment definition fields; @param {object} [deps] */
export async function defineExperiment({ workspaceId, key, design, arms, references, hypothesis, version = 1 } = {}, deps = {}) {
  if (!isEiExperimentsEnabled(workspaceId)) return { skipped: "flag_off" };
  const append = deps.appendExperiment || appendExperiment;
  const experiment = createExperiment({ workspaceId, key, design, arms, references, hypothesis, version });
  const v = validateExperiment(experiment);
  if (!v.ok) return { defined: false, errors: v.errors };
  const id = await append(experiment);
  return { defined: true, written: Boolean(id), experiment };
}

/** Deterministically assign subjects to arms (idempotent append of each assignment). */
export async function assignSubjects({ workspaceId, experiment, subjectIds = [] } = {}, deps = {}) {
  if (!isEiExperimentsEnabled(workspaceId)) return { skipped: "flag_off" };
  const append = deps.appendAssignment || appendAssignment;
  const assignments = [];
  let written = 0;
  for (const subjectId of subjectIds) {
    const a = assign(subjectId, experiment);
    const rec = { ...a, assignmentId: assignmentId(experiment.experimentId, subjectId), workspaceId: String(workspaceId) };
    assignments.push(rec);
    const id = await append(rec);
    if (id) written += 1;
  }
  return { assigned: assignments.length, written, assignments };
}
