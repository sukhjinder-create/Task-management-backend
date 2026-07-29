// execution/analytics.js
//
// EWIP V3 — Execution Analytics. A PURE, deterministic projection over executions,
// approvals, and the action log. Reports what the evidence supports (success/failure,
// latency, approval time, automation share) and marks anything requiring data the
// substrate does not yet carry (measured ROI, retry counts, adoption denominators) as
// insufficient — never fabricated. No new store.

function round(x, dp = 4) { return x == null || Number.isNaN(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp; }
function ok(key, label, value, basis) { return { key, label, value, evidenceSufficient: true, basis }; }
function gap(key, label, reason) { return { key, label, value: null, evidenceSufficient: false, reason }; }
const ms = (iso) => (iso ? new Date(iso).getTime() : null);

/**
 * @param {object} c { executions, approvals:[{request,state}], actions, automations }
 * @returns {object[]} metrics (deterministic order)
 */
export function computeExecutionAnalytics(c = {}) {
  const executions = c.executions || [], approvals = c.approvals || [], actions = c.actions || [];
  const live = executions.filter((e) => e.status === "executed" || e.status === "failed");
  const succeeded = live.filter((e) => e.status === "executed" && e.ok);
  const failed = live.filter((e) => e.status === "failed");
  const simulated = executions.filter((e) => e.status === "simulated");

  const m = [];
  m.push(ok("execution_count", "Executions", executions.length, { total: executions.length, live: live.length, simulated: simulated.length }));
  m.push(live.length ? ok("execution_success_rate", "Execution success rate", round(succeeded.length / live.length), { succeeded: succeeded.length, live: live.length }) : gap("execution_success_rate", "Execution success rate", "no live executions (side-effects gate is off or nothing executed)"));
  m.push(live.length ? ok("execution_failure_rate", "Execution failure rate", round(failed.length / live.length), { failed: failed.length, live: live.length }) : gap("execution_failure_rate", "Execution failure rate", "no live executions"));

  const latencies = executions.map((e) => (ms(e.endedAt) != null && ms(e.startedAt) != null ? ms(e.endedAt) - ms(e.startedAt) : null)).filter((x) => x != null);
  m.push(latencies.length ? ok("avg_execution_latency_ms", "Average execution latency", round(latencies.reduce((a, b) => a + b, 0) / latencies.length, 1), { n: latencies.length }) : gap("avg_execution_latency_ms", "Average execution latency", "no timed executions"));

  const approvalTimes = approvals.filter((a) => a.state?.status === "approved" && a.state.history?.length && a.request?.createdAt)
    .map((a) => ms(a.state.history[a.state.history.length - 1].occurredAt) - ms(a.request.createdAt)).filter((x) => x != null && x >= 0);
  m.push(approvalTimes.length ? ok("avg_approval_time_ms", "Average approval time", round(approvalTimes.reduce((a, b) => a + b, 0) / approvalTimes.length, 1), { n: approvalTimes.length }) : gap("avg_approval_time_ms", "Average approval time", "no completed approvals"));

  const autoFired = actions.filter((a) => a.type === "automation_fired").length;
  const decisions = actions.filter((a) => a.type === "decision_created").length;
  m.push((autoFired + decisions) ? ok("automation_rate", "Share of actions initiated by automation", round(autoFired / (autoFired + decisions)), { autoFired, decisions }) : gap("automation_rate", "Share of actions initiated by automation", "no decisions or automations recorded"));

  // Explicitly not fabricated — need measured impact / a user denominator.
  m.push(gap("retry_rate", "Retry rate", "requires per-execution attempt tracking (available on workflow runs only)"));
  m.push(gap("roi", "Return on investment", "requires measured business impact (hours/cost saved) — not yet recorded"));
  m.push(gap("adoption", "Adoption", "requires an active-user/workspace denominator — not yet recorded"));
  return m;
}
