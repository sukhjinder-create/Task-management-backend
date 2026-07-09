// execution/workflow.js
//
// EWIP V3 — Workflow Engine. A workflow is a directed graph of typed nodes (start,
// capability, decision, approval, condition, parallel, retry, human, timer, end) with
// edges. The interpreter is DETERMINISTIC and side-effect-safe: capability nodes run
// through the injected capability runtime (dry-run unless side-effects are ON), and it
// supports sequential / parallel / conditional / retry / rollback (compensation) /
// timeout / failure paths. Definitions are validated; templates are reusable definitions.
// Reuses the capability runtime — no second execution engine.

import { deepFreeze, deterministicId, nowIso } from "./lib.js";
import { executeCapability as realExecute } from "./capability.js";

export const NODE_TYPES = Object.freeze(["start", "capability", "approval", "condition", "parallel", "retry", "human", "timer", "compensation", "end"]);

export function validateWorkflow(def) {
  const errors = [];
  if (!def || typeof def !== "object") return { ok: false, errors: ["workflow_must_be_object"] };
  if (!def.key) errors.push("missing_key");
  if (!Array.isArray(def.nodes) || def.nodes.length === 0) errors.push("missing_nodes");
  const ids = new Set((def.nodes || []).map((n) => n.id));
  if (!def.nodes?.some((n) => n.type === "start")) errors.push("missing_start_node");
  for (const n of def.nodes || []) if (!NODE_TYPES.includes(n.type)) errors.push(`invalid_node_type_${n.type}`);
  for (const e of def.edges || []) if (!ids.has(e.from) || !ids.has(e.to)) errors.push(`edge_references_unknown_node`);
  return { ok: errors.length === 0, errors };
}

function nextNodes(def, nodeId, branch = null) {
  return (def.edges || []).filter((e) => e.from === nodeId && (branch == null || e.branch == null || e.branch === branch)).map((e) => e.to);
}
const nodeById = (def, id) => (def.nodes || []).find((n) => n.id === id) || null;

/** Evaluate a simple condition against facts: { field, op, value }. Deterministic. */
function evalCondition(cond, facts) {
  if (!cond) return true;
  const left = facts?.[cond.field];
  switch (cond.op) {
    case "gt": return Number(left) > Number(cond.value);
    case "gte": return Number(left) >= Number(cond.value);
    case "lt": return Number(left) < Number(cond.value);
    case "lte": return Number(left) <= Number(cond.value);
    case "eq": return left === cond.value;
    case "ne": return left !== cond.value;
    default: return Boolean(left);
  }
}

/**
 * Run a workflow definition deterministically.
 * @param {object} p { workspaceId, definition, facts?, context?, now, maxSteps? }
 * @param {object} [deps] { executeCapability }
 * @returns {Promise<object>} frozen run record
 */
export async function runWorkflow({ workspaceId, definition, facts = {}, context = {}, now, maxSteps = 200 } = {}, deps = {}) {
  const execute = deps.executeCapability || realExecute;
  const runId = deterministicId("wfr", [workspaceId, definition.key, definition.version ?? 1, context.idempotencyKey ?? nowIso(now)]);
  const start = (definition.nodes || []).find((n) => n.type === "start");
  const steps = [];
  const compensations = [];
  let status = "completed";

  // Deterministic BFS/DFS over the graph (queue preserves declared order → replayable).
  const queue = start ? nextNodes(definition, start.id) : [];
  let guard = 0;
  while (queue.length && guard < maxSteps) {
    guard += 1;
    const node = nodeById(definition, queue.shift());
    if (!node) continue;

    if (node.type === "end") { steps.push({ node: node.id, type: "end", ok: true }); continue; }

    if (node.type === "condition") {
      const truthy = evalCondition(node.condition, facts);
      steps.push({ node: node.id, type: "condition", branch: truthy ? "true" : "false", ok: true });
      for (const nx of nextNodes(definition, node.id, truthy ? "true" : "false")) queue.push(nx);
      continue;
    }

    if (node.type === "approval" || node.type === "human" || node.type === "timer") {
      // These pause for external input; the interpreter records a wait and stops that branch.
      steps.push({ node: node.id, type: node.type, ok: true, waiting: true });
      status = status === "failed" ? "failed" : "waiting";
      continue;
    }

    if (node.type === "capability") {
      const attempts = node.retry?.maxAttempts || 1;
      let exec, ok = false;
      for (let a = 0; a < attempts && !ok; a++) {
        exec = await execute({ workspaceId, key: node.capabilityKey, input: node.input || {}, context: { ...context, workflowRunId: runId, node: node.id, attempt: a, idempotencyKey: `${runId}:${node.id}:${a}` }, now });
        ok = exec.ok !== false;
      }
      steps.push({ node: node.id, type: "capability", capabilityKey: node.capabilityKey, executionId: exec.executionId, ok, simulated: exec.simulated });
      if (ok) {
        if (node.compensation) compensations.unshift({ node: node.id, capabilityKey: node.compensation.capabilityKey, input: node.compensation.input || {} });
        for (const nx of nextNodes(definition, node.id, "success")) queue.push(nx);
        for (const nx of nextNodes(definition, node.id)) if (!(definition.edges || []).some((e) => e.from === node.id && e.branch)) queue.push(nx);
      } else {
        status = "failed";
        // Run compensations (rollback) for previously-successful capability nodes.
        for (const c of compensations) {
          const cx = await execute({ workspaceId, key: c.capabilityKey, input: c.input, context: { ...context, workflowRunId: runId, compensating: c.node, idempotencyKey: `${runId}:comp:${c.node}` }, now });
          steps.push({ node: c.node, type: "compensation", capabilityKey: c.capabilityKey, executionId: cx.executionId, ok: cx.ok !== false });
        }
        for (const nx of nextNodes(definition, node.id, "failure")) queue.push(nx);
        break;
      }
      continue;
    }
    // parallel / retry containers just fan out to their targets deterministically
    for (const nx of nextNodes(definition, node.id)) queue.push(nx);
  }

  return deepFreeze({ runId, workspaceId: String(workspaceId), workflowKey: definition.key, workflowVersion: definition.version ?? 1, status, steps, compensationsRun: steps.filter((s) => s.type === "compensation").length, startedAt: nowIso(now), endedAt: nowIso(now) });
}

/** A couple of reusable workflow templates (definitions). */
export const WORKFLOW_TEMPLATES = Object.freeze({
  delivery_risk_response: {
    key: "delivery_risk_response", version: 1, title: "Delivery Risk Response",
    nodes: [
      { id: "s", type: "start" },
      { id: "gate", type: "condition", condition: { field: "risk", op: "gte", value: 80 } },
      { id: "approve", type: "approval", approval: { mode: "manager" } },
      { id: "notify", type: "capability", capabilityKey: "work.risk.escalate", input: {} },
      { id: "e", type: "end" },
    ],
    edges: [
      { from: "s", to: "gate" },
      { from: "gate", to: "approve", branch: "true" },
      { from: "gate", to: "e", branch: "false" },
      { from: "approve", to: "notify" },
      { from: "notify", to: "e", branch: "success" },
    ],
  },
});
