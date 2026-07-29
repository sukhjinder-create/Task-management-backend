// execution/verification.js
//
// EWIP V3 — Verification Engine. Deterministically answers, for a completed execution:
// did it happen? was it successful? with evidence, references, and a failure reason +
// retry hint when not. A dry-run (simulated) execution verifies as "simulated" (not a
// real effect). Pure.

import { deepFreeze } from "./lib.js";

/**
 * @param {object} execution   an execution record from capability.js
 * @param {object} [expected]  { entityType? } optional expectation
 * @returns {object} frozen verification record
 */
export function verifyExecution(execution, expected = {}) {
  if (!execution) return deepFreeze({ verified: false, mode: "none", failureReason: "no_execution", references: {} });
  const references = { executionId: execution.executionId, capabilityKey: execution.capabilityKey };

  if (execution.status === "simulated") {
    return deepFreeze({ verified: true, mode: "dry_run", evidence: { simulated: true }, references, retryable: false });
  }
  if (execution.status === "failed" || execution.ok === false) {
    return deepFreeze({ verified: false, mode: "live", failureReason: execution.failureReason || "execution_failed", errors: execution.errors || null, references, retryable: true });
  }
  // Live success — require the produced entity id as evidence when the capability yields one.
  const entity = execution.entity || execution.output?.entity || null;
  const hasEntity = Boolean(entity && entity.id != null);
  const typeOk = !expected.entityType || (entity && entity.type === expected.entityType);
  const verified = hasEntity ? typeOk : true; // notify-style caps have no entity id
  return deepFreeze({
    verified,
    mode: "live",
    evidence: { entity, output: execution.output ?? null },
    references,
    retryable: !verified,
    ...(verified ? {} : { failureReason: hasEntity ? "entity_type_mismatch" : "no_effect_evidence" }),
  });
}
