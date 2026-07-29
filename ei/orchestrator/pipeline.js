// ei/orchestrator/pipeline.js
//
// Enterprise Intelligence — the pipeline that runs the deterministic reasoning chain
// end-to-end for one workspace and PERSISTS each stage. It REUSES the existing engines
// and the existing flag-gated stage services (no duplicate logic): events →
// computeAttributions → (evidence / reasoning / prediction / recommendation) services.
// Deterministic + idempotent (all stores are ON CONFLICT DO NOTHING; ids are stable),
// so it is replay-safe: running it repeatedly converges, it never double-writes.
// Stores/services are injectable (DI) for hermetic tests.

import { computeAttributions } from "../attribution/engine.js";
import { appendAttribution as appendAttributionStore } from "../attribution/store.js";
import { buildEvidenceForWorkspace } from "../evidence/service.js";
import { buildTracesForWorkspace } from "../reasoning/service.js";
import { predictForWorkspace } from "../prediction/service.js";
import { recommendForWorkspace } from "../recommendation/service.js";
import { readEvents } from "../events/eventStore.js";

const parse = (v) => { try { return typeof v === "string" ? JSON.parse(v) : (v ?? null); } catch { return v; } };

/** Map an ei_events row back into the canonical event shape the engines consume. */
function rowToEvent(r) {
  return {
    eventId: r.event_id, seq: Number(r.seq), workspaceId: r.workspace_id, type: r.type,
    occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : r.occurred_at,
    entities: parse(r.entities_json) || [],
  };
}

/**
 * @param {object} p { workspaceId, events?, now, limit? }
 * @param {object} [deps] { readEvents, appendAttribution, appendEvidence, appendTrace, appendPrediction, appendRecommendation }
 * @returns {Promise<object>} stage counts (deterministic given events + now)
 */
export async function runPipelineForWorkspace({ workspaceId, events = null, now = Date.now(), limit = 2000 } = {}, deps = {}) {
  const read = deps.readEvents || readEvents;
  const appendAttribution = deps.appendAttribution || appendAttributionStore;

  const canonical = events || (await read({ workspaceId, sinceSeq: 0, limit })).map(rowToEvent);

  // 1) Attribution (pure) → persist.
  const attributions = computeAttributions({ workspaceId, events: canonical });
  let attrWritten = 0;
  for (const a of attributions) { if (await appendAttribution(a)) attrWritten += 1; }

  // 2–5) Evidence → Reasoning → Prediction → Recommendation, via the EXISTING flag-gated
  //      services (each no-ops with { skipped:"flag_off" } unless enabled for the ws).
  const evidenceRes = await buildEvidenceForWorkspace({ workspaceId, attributions }, { appendEvidence: deps.appendEvidence });
  const traceRes = await buildTracesForWorkspace({ workspaceId, attributions, now }, { appendTrace: deps.appendTrace });
  const traces = traceRes.traces || [];
  const predictionRes = await predictForWorkspace({ workspaceId, traces }, { appendPrediction: deps.appendPrediction });
  const predictions = predictionRes.predictions || [];
  const tracesById = Object.fromEntries(traces.map((t) => [t.traceId, t]));
  const recommendationRes = await recommendForWorkspace({ workspaceId, predictions, tracesById }, { appendRecommendation: deps.appendRecommendation });

  return {
    workspaceId: String(workspaceId),
    events: canonical.length,
    attributions: attributions.length,
    attributionsWritten: attrWritten,
    evidence: evidenceRes.projected ?? (evidenceRes.skipped ? 0 : 0),
    traces: traces.length,
    predictions: predictions.length,
    recommendations: recommendationRes.recommended ?? 0,
    stagesSkipped: [evidenceRes, traceRes, predictionRes, recommendationRes].filter((r) => r.skipped).length,
  };
}
