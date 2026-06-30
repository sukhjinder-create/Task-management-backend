import pool from "../../db.js";
import { getRuntimeSettings } from "../config/runtimeSettings.service.js";
import { buildOperationalContext, summarizeOperationalContext } from "../context/contextBuilder.service.js";
import { routeRecommendation } from "../approvals/approvalEngine.service.js";
import { reasonFromOperationalContext } from "../reasoning/reasoningEngine.service.js";
import { startMatchingWorkflows } from "../workflows/workflowEngine.service.js";
import { applyAdaptivePolicy } from "../personalization/adaptivePolicy.service.js";

async function startRun({ event, queueItem, settings }) {
  const { rows } = await pool.query(
    `
    INSERT INTO adaptive_runtime_runs (
      workspace_id, event_id, queue_id, mode, status, trigger_type,
      trace_id, correlation_id
    ) VALUES ($1,$2,$3,$4,'started','event',COALESCE($5, gen_random_uuid()),$6)
    RETURNING *
    `,
    [event.workspaceId, event.eventId, queueItem?.id || null, settings.mode, event.traceId || null, event.correlationId || null]
  );
  return rows[0];
}

async function completeRun({ runId, context, reasoning, policy, routed, workflows, startedAt }) {
  const selectedCapabilities = Array.from(new Set(policy.proposed.map((item) => item.capabilityKey)));
  const timings = {
    totalMs: Date.now() - startedAt,
    contextMs: context.durationMs,
    recommendationRoutingMs: Math.max(0, Date.now() - startedAt - context.durationMs),
  };
  const { rows } = await pool.query(
    `
    UPDATE adaptive_runtime_runs
    SET status = 'completed',
        context_summary = $1::jsonb,
        selected_capabilities = $2::jsonb,
        reasoning_summary = $3,
        evidence = $4::jsonb,
        recommendation_count = $5,
        timings = $6::jsonb,
        completed_at = NOW()
    WHERE id = $7
    RETURNING *
    `,
    [
      JSON.stringify({ ...summarizeOperationalContext(context), workflows, suppressed: policy.suppressed.map((item) => ({ ruleKey: item.ruleKey, explanation: item.policyExplanation })) }),
      JSON.stringify(selectedCapabilities),
      reasoning.summary,
      JSON.stringify(reasoning.evidence),
      policy.proposed.length,
      JSON.stringify(timings),
      runId,
    ]
  );
  return { run: rows[0], routed, workflows };
}

async function failRun(runId, error, startedAt) {
  await pool.query(
    `
    UPDATE adaptive_runtime_runs
    SET status = 'failed', error_code = $1, error_message = $2,
        timings = $3::jsonb, completed_at = NOW()
    WHERE id = $4
    `,
    [
      error?.code || "ADAPTIVE_RUNTIME_FAILED",
      String(error?.message || error).slice(0, 2000),
      JSON.stringify({ totalMs: Date.now() - startedAt }),
      runId,
    ]
  );
}

export async function processAdaptiveEvent({ event, queueItem = null }) {
  const startedAt = Date.now();
  const settings = await getRuntimeSettings(event.workspaceId);
  const run = await startRun({ event, queueItem, settings });
  try {
    if (settings.mode === "off") {
      const { rows } = await pool.query(
        `UPDATE adaptive_runtime_runs
         SET status = 'skipped', reasoning_summary = 'Runtime disabled by workspace policy', completed_at = NOW()
         WHERE id = $1 RETURNING *`,
        [run.id]
      );
      return { run: rows[0], routed: [], workflows: [] };
    }

    const context = await buildOperationalContext({ event, settings });
    const reasoning = reasonFromOperationalContext({ event, context });
    const policy = await applyAdaptivePolicy({ event, context, recommendations: reasoning.recommendations });
    const routed = [];

    if (["assist", "auto"].includes(settings.mode)) {
      for (const recommendation of policy.proposed) {
        routed.push(await routeRecommendation({ recommendation, event, runtimeRunId: run.id, settings }));
      }
    }

    const workflows = await startMatchingWorkflows({ event, runtimeRunId: run.id, context, settings });
    return completeRun({ runId: run.id, context, reasoning, policy, routed, workflows, startedAt });
  } catch (error) {
    await failRun(run.id, error, startedAt);
    throw error;
  }
}
