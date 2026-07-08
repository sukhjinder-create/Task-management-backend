// ei/graph/graph.js
//
// EI V2.1 — the Enterprise Intelligence Graph PROJECTION. This is not a second
// store: it is a pure, deterministic projection over the records the pipeline already
// produces (attributions → evidence → traces → predictions → recommendations). Every
// node and every edge carries the id that justifies it, so the whole graph remains
// traceable back to evidence. No LLM, no learning. Reuses deepFreeze.

import { deepFreeze } from "../../ai-platform/contract/common.js";

export const GRAPH_SCHEMA_VERSION = 1;

const NODE = Object.freeze({ ENTITY: "entity", TRACE: "trace", PREDICTION: "prediction", RECOMMENDATION: "recommendation", EVIDENCE: "evidence", ATTRIBUTION: "attribution" });
const EDGE = Object.freeze({
  SUBJECT_OF: "subject_of",      // entity  -> trace
  EVIDENCES: "evidences",        // attribution -> trace
  SUPPORTS: "supports",          // evidence -> trace
  PREDICTS: "predicts",          // trace   -> prediction
  RECOMMENDS: "recommends",      // prediction -> recommendation
  ABOUT: "about",                // recommendation -> entity
});

function keyEntityNode(ref /* "Type:id" */) { return { id: `entity:${ref}`, type: NODE.ENTITY, ref }; }

/**
 * Project a corpus into a deterministic { nodes, edges }.
 * @param {object} p
 * @param {string} p.workspaceId
 * @param {Array}  [p.traces]
 * @param {Array}  [p.predictions]
 * @param {Array}  [p.recommendations]
 * @returns {object} frozen graph
 */
export function buildGraph({ workspaceId, traces = [], predictions = [], recommendations = [] } = {}) {
  const nodes = new Map();   // id -> node
  const edges = new Map();   // signature -> edge
  const addNode = (n) => { if (n && n.id && !nodes.has(n.id)) nodes.set(n.id, n); };
  const addEdge = (from, to, rel, justifiedBy) => {
    if (!from || !to) return;
    const sig = `${from}|${rel}|${to}`;
    if (!edges.has(sig)) edges.set(sig, { from, to, rel, justifiedBy: justifiedBy ?? null });
  };

  for (const t of traces) {
    if (!t || !t.traceId) continue;
    const traceNodeId = `trace:${t.traceId}`;
    addNode({ id: traceNodeId, type: NODE.TRACE, ref: t.traceId, predicate: t.claim?.predicate ?? null, status: t.claim?.status ?? null });

    const ent = t.claim?.entity;
    if (ent && ent.id != null) {
      const ref = `${ent.type}:${ent.id}`;
      addNode(keyEntityNode(ref));
      addEdge(`entity:${ref}`, traceNodeId, EDGE.SUBJECT_OF, t.traceId);
    }
    for (const gn of t.referencedGraphNodes || []) { addNode(keyEntityNode(gn)); }
    for (const aid of t.referencedAttribution || []) {
      addNode({ id: `attribution:${aid}`, type: NODE.ATTRIBUTION, ref: aid });
      addEdge(`attribution:${aid}`, traceNodeId, EDGE.EVIDENCES, aid);
    }
    for (const eid of t.referencedEvidence || []) {
      addNode({ id: `evidence:${eid}`, type: NODE.EVIDENCE, ref: eid });
      addEdge(`evidence:${eid}`, traceNodeId, EDGE.SUPPORTS, eid);
    }
  }

  for (const pr of predictions) {
    if (!pr || !pr.predictionId) continue;
    const predNodeId = `prediction:${pr.predictionId}`;
    addNode({ id: predNodeId, type: NODE.PREDICTION, ref: pr.predictionId, predictionType: pr.predictionType, probability: pr.probability ?? null });
    if (pr.supportingReasoningTraceId) addEdge(`trace:${pr.supportingReasoningTraceId}`, predNodeId, EDGE.PREDICTS, pr.predictionId);
  }

  for (const rc of recommendations) {
    if (!rc || !rc.recommendationId) continue;
    const recNodeId = `recommendation:${rc.recommendationId}`;
    addNode({ id: recNodeId, type: NODE.RECOMMENDATION, ref: rc.recommendationId, recommendationType: rc.recommendationType, status: rc.status });
    if (rc.rationaleRefs?.predictionId) addEdge(`prediction:${rc.rationaleRefs.predictionId}`, recNodeId, EDGE.RECOMMENDS, rc.recommendationId);
    const ent = rc.entity;
    if (ent && ent.id != null) {
      const ref = `${ent.type}:${ent.id}`;
      addNode(keyEntityNode(ref));
      addEdge(recNodeId, `entity:${ref}`, EDGE.ABOUT, rc.recommendationId);
    }
  }

  const nodeList = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const edgeList = [...edges.values()].sort((a, b) => `${a.from}|${a.rel}|${a.to}`.localeCompare(`${b.from}|${b.rel}|${b.to}`));

  return deepFreeze({
    eiVersion: "2.1",
    schemaVersion: GRAPH_SCHEMA_VERSION,
    workspaceId: String(workspaceId),
    nodes: nodeList,
    edges: edgeList,
    counts: { nodes: nodeList.length, edges: edgeList.length },
    nodeTypes: NODE,
    edgeTypes: EDGE,
  });
}

export { NODE as GRAPH_NODE_TYPES, EDGE as GRAPH_EDGE_TYPES };
