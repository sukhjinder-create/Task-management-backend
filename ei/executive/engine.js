// ei/executive/engine.js
//
// EI V2.1 Phase 7 — the deterministic Executive Intelligence engine (a.k.a. the
// executive decision engine). It answers a fixed catalog of executive questions by
// aggregating ONLY the structured records the pipeline already produced. Every
// finding references the evidence / reasoning / prediction / recommendation ids that
// justify it — there is no free text and no unsupported conclusion. When a question
// structurally requires data the pipeline does not record (outcome history, a
// department dimension), the answer is "insufficient_evidence" with a precise reason.
// No LLM. Deterministic.

import { deepFreeze } from "../../ai-platform/contract/common.js";
import { QUESTION, QUESTION_META, DELIVERY_PREDICATES } from "./questions.js";

function band(overall = 0) { return overall >= 0.66 ? "high" : overall >= 0.33 ? "moderate" : "low"; }
const entKey = (e) => (e && e.id != null ? `${e.type}:${e.id}` : null);

function answered(questionType, findings, references, extra = {}) {
  return { questionType, status: "answered", findings, references, ...extra };
}
function insufficient(questionType, reason, extra = {}) {
  return { questionType, status: "insufficient_evidence", findings: [], references: emptyRefs(), reason, ...extra };
}
function emptyRefs() { return { traceIds: [], predictionIds: [], recommendationIds: [], evidenceIds: [] }; }

// ── Resolvers ────────────────────────────────────────────────────────────────

function resolveProjectsHighestRisk({ predictions, tracesById }) {
  const risky = predictions
    .filter((p) => String(p.predictionType || "").startsWith("risk:") && (p.probability ?? 0) >= 0.5)
    .slice()
    .sort((a, b) => (b.probability - a.probability) || a.predictionId.localeCompare(b.predictionId));
  if (risky.length === 0) return insufficient(QUESTION.PROJECTS_HIGHEST_RISK, "no risk predictions above threshold in current evidence");

  const findings = risky.map((p) => {
    const t = tracesById[p.supportingReasoningTraceId];
    return {
      entity: p.entity,
      predictionType: p.predictionType,
      probability: p.probability,
      confidenceBand: band(t?.confidenceDecomposition?.overall ?? 0),
      predictionId: p.predictionId,
      traceId: p.supportingReasoningTraceId,
    };
  });
  const references = {
    traceIds: [...new Set(findings.map((f) => f.traceId).filter(Boolean))].sort(),
    predictionIds: findings.map((f) => f.predictionId).sort(),
    recommendationIds: [],
    evidenceIds: [],
  };
  return answered(QUESTION.PROJECTS_HIGHEST_RISK, findings, references);
}

function resolveDeliverySlowing({ traces }) {
  const relevant = traces.filter((t) => DELIVERY_PREDICATES.includes(t.claim?.predicate) && t.claim?.status === "attributed");
  if (relevant.length === 0) return insufficient(QUESTION.DELIVERY_SLOWING, "no attributed delivery-slippage reasoning in current evidence");

  // Aggregate contributing factors deterministically across the relevant traces.
  const byFactor = new Map();
  for (const t of relevant) {
    for (const step of t.reasoningChain || []) {
      const f = step.from?.descriptor;
      if (!f) continue;
      if (!byFactor.has(f)) byFactor.set(f, { factor: f, occurrences: 0, tiers: new Set(), traceIds: new Set(), evidenceIds: new Set() });
      const rec = byFactor.get(f);
      rec.occurrences += 1;
      rec.tiers.add(step.tier);
      rec.traceIds.add(t.traceId);
      for (const eid of t.referencedEvidence || []) rec.evidenceIds.add(eid);
    }
  }
  const findings = [...byFactor.values()]
    .map((r) => ({ factor: r.factor, occurrences: r.occurrences, tiers: [...r.tiers].sort(), exampleTraceIds: [...r.traceIds].sort().slice(0, 5) }))
    .sort((a, b) => (b.occurrences - a.occurrences) || a.factor.localeCompare(b.factor));

  const references = {
    traceIds: [...new Set(relevant.map((t) => t.traceId))].sort(),
    predictionIds: [],
    recommendationIds: [],
    evidenceIds: [...new Set(relevant.flatMap((t) => t.referencedEvidence || []))].sort(),
  };
  return answered(QUESTION.DELIVERY_SLOWING, findings, references, { affectedEntities: [...new Set(relevant.map((t) => entKey(t.claim?.entity)).filter(Boolean))].sort() });
}

function resolveDepartmentsNeedingAttention({ predictions, departmentByEntity }) {
  // Requires an entity → department mapping that the reasoning corpus does not carry.
  if (!departmentByEntity || Object.keys(departmentByEntity).length === 0) {
    return insufficient(QUESTION.DEPARTMENTS_NEEDING_ATTENTION, "no department dimension in current evidence (requires org-graph enrichment: entity → department)");
  }
  const byDept = new Map();
  for (const p of predictions) {
    if (!String(p.predictionType || "").startsWith("risk:") || (p.probability ?? 0) < 0.5) continue;
    const dept = departmentByEntity[entKey(p.entity)];
    if (!dept) continue;
    if (!byDept.has(dept)) byDept.set(dept, { department: dept, riskCount: 0, predictionIds: [] });
    const r = byDept.get(dept); r.riskCount += 1; r.predictionIds.push(p.predictionId);
  }
  if (byDept.size === 0) return insufficient(QUESTION.DEPARTMENTS_NEEDING_ATTENTION, "no risk predictions map to a known department");
  const findings = [...byDept.values()].map((r) => ({ ...r, predictionIds: r.predictionIds.sort() }))
    .sort((a, b) => (b.riskCount - a.riskCount) || a.department.localeCompare(b.department));
  return answered(QUESTION.DEPARTMENTS_NEEDING_ATTENTION, findings, {
    traceIds: [], predictionIds: findings.flatMap((f) => f.predictionIds).sort(), recommendationIds: [], evidenceIds: [],
  });
}

function resolveBehavioursChanging({ traces }) {
  // Only answerable where traces carry a historical comparison (prior overall confidence).
  const withHistory = traces.filter((t) => Array.isArray(t.historicalComparison) && t.historicalComparison.length > 0);
  if (withHistory.length === 0) return insufficient(QUESTION.BEHAVIOURS_CHANGING, "no longitudinal history on current traces (requires prior-period reasoning to compare)");
  const findings = withHistory.map((t) => {
    const priorOverall = t.historicalComparison.map((h) => h.overall).filter((x) => x != null);
    const prior = priorOverall.length ? priorOverall[priorOverall.length - 1] : null;
    const current = t.confidenceDecomposition?.overall ?? null;
    return { predicate: t.claim?.predicate, entity: t.claim?.entity, priorConfidence: prior, currentConfidence: current, delta: (prior != null && current != null) ? Math.round((current - prior) * 1e6) / 1e6 : null, traceId: t.traceId };
  }).sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0) || a.traceId.localeCompare(b.traceId));
  return answered(QUESTION.BEHAVIOURS_CHANGING, findings, {
    traceIds: findings.map((f) => f.traceId).sort(), predictionIds: [], recommendationIds: [], evidenceIds: [],
  });
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * @param {object} p
 * @param {string} p.workspaceId
 * @param {string} p.questionType   one of QUESTION.*
 * @param {object} p.corpus         { traces, predictions, recommendations, evidence, departmentByEntity? }
 * @returns {object} frozen answer
 */
export function answerExecutiveQuestion({ workspaceId, questionType, corpus = {} } = {}) {
  const meta = QUESTION_META[questionType];
  const base = { workspaceId: String(workspaceId), eiVersion: "2.1" };
  if (!meta) return deepFreeze({ ...base, ...insufficient(questionType, "unknown_question_type") });

  const traces = corpus.traces || [];
  const predictions = corpus.predictions || [];
  const tracesById = Object.fromEntries(traces.map((t) => [t.traceId, t]));

  // Questions that structurally require outcome history the pipeline does not record.
  if (meta.requiresOutcomeHistory) {
    return deepFreeze({ ...base, ...insufficient(questionType, "requires outcome history (recommendation → execution → measured outcome), which is not yet recorded — deferred to the learning/calibration wave") });
  }

  let ans;
  switch (questionType) {
    case QUESTION.PROJECTS_HIGHEST_RISK: ans = resolveProjectsHighestRisk({ predictions, tracesById }); break;
    case QUESTION.DELIVERY_SLOWING: ans = resolveDeliverySlowing({ traces }); break;
    case QUESTION.DEPARTMENTS_NEEDING_ATTENTION: ans = resolveDepartmentsNeedingAttention({ predictions, departmentByEntity: corpus.departmentByEntity }); break;
    case QUESTION.BEHAVIOURS_CHANGING: ans = resolveBehavioursChanging({ traces }); break;
    default: ans = insufficient(questionType, "no_resolver");
  }
  return deepFreeze({ ...base, ...ans });
}
