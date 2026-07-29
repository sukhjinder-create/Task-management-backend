// ei/orchestrator/metrics.js
//
// Runtime observability for the EI orchestrator worker: counters + a ring buffer of
// recent runs, surfaced via /superadmin/platform-features/orchestrator/status and the
// Intelligence Studio home. In-memory (per server instance) — lightweight and honest:
// it reports what THIS instance has done since boot; persistent history lives in the
// EI tables themselves.

const RECENT_MAX = 50;

const state = {
  startedAt: new Date().toISOString(),
  runs: 0,
  failures: 0,
  lastRunAt: null,
  lastError: null,            // { ts, workspaceId, message }
  recent: [],                 // [{ ts, workspaceId, durationMs, ok, error?, ...stageCounts }]
};

/** Record one workspace pipeline run (success or failure). */
export function recordRun({ workspaceId, durationMs, ok, error = null, counts = {} }) {
  state.runs += 1;
  state.lastRunAt = new Date().toISOString();
  if (!ok) {
    state.failures += 1;
    state.lastError = { ts: state.lastRunAt, workspaceId, message: String(error || "unknown") };
  }
  state.recent.unshift({ ts: state.lastRunAt, workspaceId, durationMs, ok, ...(error ? { error: String(error) } : {}), ...counts });
  if (state.recent.length > RECENT_MAX) state.recent.length = RECENT_MAX;
}

export function getOrchestratorMetrics() {
  return {
    startedAt: state.startedAt,
    runs: state.runs,
    failures: state.failures,
    failureRate: state.runs ? Math.round((state.failures / state.runs) * 1000) / 1000 : 0,
    lastRunAt: state.lastRunAt,
    lastError: state.lastError,
    recent: state.recent,
  };
}

/** Test-only reset. */
export function _resetOrchestratorMetrics() {
  state.runs = 0; state.failures = 0; state.lastRunAt = null; state.lastError = null; state.recent = [];
}
