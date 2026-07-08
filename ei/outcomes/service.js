// ei/outcomes/service.js
//
// EI V2.1 Wave C — orchestration for the Outcomes Ledger. Deterministic, flag-gated,
// additive. Records observed outcomes for recommendations/predictions. Append-only:
// every call is idempotent and never mutates a prior record.

import { createOutcome, validateOutcome } from "./outcome.js";
import { appendOutcome } from "./store.js";
import { isEiOutcomesEnabled } from "../config/flags.js";

/**
 * @param {object} args
 * @param {string} args.workspaceId
 * @param {Array}  args.observations  [{ kind, status, refs, observedAt, actor?, impact? }]
 * @param {object} [deps] { appendOutcome }
 */
export async function recordOutcomes({ workspaceId, observations = [] } = {}, deps = {}) {
  if (!isEiOutcomesEnabled(workspaceId)) return { skipped: "flag_off" };
  const append = deps.appendOutcome || appendOutcome;

  const outcomes = [];
  const rejected = [];
  let written = 0;
  for (const obs of observations) {
    const o = createOutcome({ workspaceId, ...obs });
    if (!o || !validateOutcome(o).ok) { rejected.push(obs); continue; }
    outcomes.push(o);
    const id = await append(o);
    if (id) written += 1;
  }
  return { recorded: outcomes.length, written, rejected: rejected.length, outcomes };
}
