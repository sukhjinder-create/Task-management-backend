// ei/studio/service.js
//
// Enterprise Intelligence Studio — read orchestration. Fetches persisted records via
// the EXISTING stores, maps them with read.js, and delegates all computation to the
// EXISTING engines (graph / validation / effectiveness / health / metrics / executive).
// Nothing here re-implements intelligence — it only assembles and exposes. Stores are
// injectable (DI) so this is hermetically testable. Read-only.

import { listAttributions } from "../attribution/store.js";
import { listCurrentEvidence } from "../evidence/store.js";
import { listTraces } from "../reasoning/store.js";
import { listPredictions } from "../prediction/store.js";
import { listRecommendations } from "../recommendation/store.js";
import { listOutcomes } from "../outcomes/store.js";
import { getCurrentCalibrationModel } from "../calibration/store.js";
import { listProposals, listReviewDecisions } from "../learning/store.js";
import { listExperiments } from "../experiments/store.js";
import { listCurrentMemory } from "../memory/store.js";

import { buildGraph } from "../graph/graph.js";
import { validatePredictionOutcomes } from "../validation/validation.js";
import { computeEffectiveness } from "../effectiveness/effectiveness.js";
import { computeHealth } from "../health/health.js";
import { computeMetrics } from "../metrics/metrics.js";
import { answerExecutiveQuestion } from "../executive/engine.js";
import { ALL_QUESTIONS } from "../executive/questions.js";

import {
  rowToTrace, rowToPrediction, rowToRecommendation, rowToOutcome, rowToEvidence,
  rowToMemory, rowToProposal, rowToExperiment, rowToAttribution, mapRows,
  searchIntelligence, traceRelations,
} from "./read.js";

function makeStores(deps = {}) {
  return {
    listAttributions: deps.listAttributions || listAttributions,
    listCurrentEvidence: deps.listCurrentEvidence || listCurrentEvidence,
    listTraces: deps.listTraces || listTraces,
    listPredictions: deps.listPredictions || listPredictions,
    listRecommendations: deps.listRecommendations || listRecommendations,
    listOutcomes: deps.listOutcomes || listOutcomes,
    getCurrentCalibrationModel: deps.getCurrentCalibrationModel || getCurrentCalibrationModel,
    listProposals: deps.listProposals || listProposals,
    listReviewDecisions: deps.listReviewDecisions || listReviewDecisions,
    listExperiments: deps.listExperiments || listExperiments,
    listCurrentMemory: deps.listCurrentMemory || listCurrentMemory,
  };
}

/** Fetch + map the full intelligence corpus for a workspace (rich objects). */
export async function buildCorpus({ workspaceId }, deps = {}) {
  const s = makeStores(deps);
  const [evidence, attributions, traces, predictions, recommendations, outcomes, calibrationModel, proposals, experiments, memory] = await Promise.all([
    s.listCurrentEvidence({ workspaceId }), s.listAttributions({ workspaceId }), s.listTraces({ workspaceId }),
    s.listPredictions({ workspaceId }), s.listRecommendations({ workspaceId }), s.listOutcomes({ workspaceId }),
    s.getCurrentCalibrationModel({ workspaceId }), s.listProposals({ workspaceId }), s.listExperiments({ workspaceId }), s.listCurrentMemory({ workspaceId }),
  ]);
  return {
    evidence: mapRows(evidence, rowToEvidence),
    attributions: mapRows(attributions, rowToAttribution),
    traces: mapRows(traces, rowToTrace),
    predictions: mapRows(predictions, rowToPrediction),
    recommendations: mapRows(recommendations, rowToRecommendation),
    outcomes: mapRows(outcomes, rowToOutcome),
    calibrationModel: calibrationModel && (calibrationModel.buckets_json ? { version: calibrationModel.version, buckets: JSON.parse(calibrationModel.buckets_json), method: calibrationModel.method } : calibrationModel),
    learning: mapRows(proposals, rowToProposal),
    experiments: mapRows(experiments, rowToExperiment),
    memory: mapRows(memory, rowToMemory),
  };
}

const validationOf = (c) => validatePredictionOutcomes({ predictions: c.predictions, outcomes: c.outcomes.filter((o) => o.kind === "prediction") });
const effectivenessOf = (c) => computeEffectiveness({ recommendations: c.recommendations, outcomes: c.outcomes.filter((o) => o.kind === "recommendation") });

export async function getOverview({ workspaceId }, deps = {}) {
  const c = await buildCorpus({ workspaceId }, deps);
  return {
    counts: { evidence: c.evidence.length, attributions: c.attributions.length, traces: c.traces.length, predictions: c.predictions.length, recommendations: c.recommendations.length, outcomes: c.outcomes.length, experiments: c.experiments.length, learning: c.learning.length, memory: c.memory.length },
    metrics: computeMetrics(c),
    graph: buildGraph({ workspaceId, traces: c.traces, predictions: c.predictions, recommendations: c.recommendations }).counts,
  };
}

export async function getHealth({ workspaceId }, deps = {}) {
  const c = await buildCorpus({ workspaceId }, deps);
  const graph = buildGraph({ workspaceId, traces: c.traces, predictions: c.predictions, recommendations: c.recommendations });
  return computeHealth({ ...c, validation: validationOf(c), effectiveness: effectivenessOf(c), graph });
}

export async function getValidation({ workspaceId }, deps = {}) { return validationOf(await buildCorpus({ workspaceId }, deps)); }
export async function getEffectiveness({ workspaceId }, deps = {}) { return effectivenessOf(await buildCorpus({ workspaceId }, deps)); }
export async function getGraph({ workspaceId }, deps = {}) { const c = await buildCorpus({ workspaceId }, deps); return buildGraph({ workspaceId, traces: c.traces, predictions: c.predictions, recommendations: c.recommendations }); }
export async function getExecutive({ workspaceId }, deps = {}) {
  const c = await buildCorpus({ workspaceId }, deps);
  const corpus = { traces: c.traces, predictions: c.predictions, recommendations: c.recommendations };
  return { answers: ALL_QUESTIONS.map((qn) => answerExecutiveQuestion({ workspaceId, questionType: qn, corpus })) };
}
export async function search({ workspaceId, q }, deps = {}) { return { results: searchIntelligence(q, await buildCorpus({ workspaceId }, deps)) }; }

// Simple list/detail exposers (mapped records).
export async function listEvidence(a, d) { return (await buildCorpus(a, d)).evidence; }
export async function listAttributionsStudio(a, d) { return (await buildCorpus(a, d)).attributions; }
export async function listTracesStudio(a, d) { return (await buildCorpus(a, d)).traces; }
export async function listPredictionsStudio(a, d) { return (await buildCorpus(a, d)).predictions; }
export async function listRecommendationsStudio(a, d) { return (await buildCorpus(a, d)).recommendations; }
export async function listOutcomesStudio(a, d) { return (await buildCorpus(a, d)).outcomes; }
export async function listLearningStudio(a, d) { const c = await buildCorpus(a, d); const s = makeStores(d); const reviews = await s.listReviewDecisions({ workspaceId: a.workspaceId }); return { proposals: c.learning, reviews }; }
export async function listExperimentsStudio(a, d) { return (await buildCorpus(a, d)).experiments; }
export async function listMemoryStudio(a, d) { return (await buildCorpus(a, d)).memory; }
export async function getCalibrationStudio(a, d) { return (await buildCorpus(a, d)).calibrationModel; }

export async function getTraceDetail({ workspaceId, traceId }, deps = {}) {
  const c = await buildCorpus({ workspaceId }, deps);
  const trace = c.traces.find((t) => t.traceId === traceId) || null;
  return { trace, relations: traceRelations(trace, c) };
}
export async function getPredictionDetail({ workspaceId, predictionId }, deps = {}) {
  const c = await buildCorpus({ workspaceId }, deps);
  const prediction = c.predictions.find((p) => p.predictionId === predictionId) || null;
  const trace = prediction ? c.traces.find((t) => t.traceId === prediction.supportingReasoningTraceId) : null;
  const outcomes = c.outcomes.filter((o) => o.refs?.predictionId === predictionId);
  return { prediction, trace, outcomes };
}
export async function getRecommendationDetail({ workspaceId, recommendationId }, deps = {}) {
  const c = await buildCorpus({ workspaceId }, deps);
  const recommendation = c.recommendations.find((r) => r.recommendationId === recommendationId) || null;
  const prediction = recommendation ? c.predictions.find((p) => p.predictionId === recommendation.rationaleRefs?.predictionId) : null;
  const outcomes = c.outcomes.filter((o) => o.refs?.recommendationId === recommendationId);
  return { recommendation, prediction, outcomes };
}
