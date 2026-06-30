import { getApplicableContextProviders } from "./contextRegistry.js";
import { compactSummary, withTimeout } from "../shared/runtimeUtils.js";

export async function buildOperationalContext({ event, settings }) {
  const timeoutMs = Math.min(
    Math.max(Number(settings?.context_limits?.timeoutMs) || 2500, 250),
    10000
  );
  const providers = getApplicableContextProviders({ event, settings });
  const startedAt = Date.now();

  const settled = await Promise.all(
    providers.map(async (provider) => {
      const providerStartedAt = Date.now();
      try {
        const value = await withTimeout(
          Promise.resolve(provider.load({ event, settings })),
          Number(provider.timeoutMs || timeoutMs),
          `context:${provider.key}`
        );
        return {
          key: provider.key,
          status: "available",
          durationMs: Date.now() - providerStartedAt,
          value,
        };
      } catch (error) {
        return {
          key: provider.key,
          status: "unavailable",
          durationMs: Date.now() - providerStartedAt,
          error: error?.message || "Context provider failed",
          value: null,
        };
      }
    })
  );

  const data = Object.fromEntries(settled.map((result) => [result.key, result.value]));
  const sources = settled.map(({ key, status, durationMs, error }) => ({ key, status, durationMs, error }));
  const available = sources.filter((source) => source.status === "available").length;

  return {
    event,
    data,
    sources,
    coverage: providers.length ? available / providers.length : 1,
    durationMs: Date.now() - startedAt,
  };
}

export function summarizeOperationalContext(context) {
  const task = context?.data?.task;
  const project = context?.data?.project;
  const intelligence = context?.data?.workspaceIntelligence;
  return compactSummary({
    coverage: context?.coverage,
    sources: context?.sources,
    task: task ? {
      id: task.id,
      title: task.task,
      status: task.status,
      priority: task.priority,
      dueDate: task.due_date,
      assignedTo: task.assigned_to,
      projectId: task.project_id,
    } : null,
    project: project ? { id: project.id, name: project.name, status: project.status } : null,
    workspaceIntelligence: intelligence ? {
      score: intelligence.score,
      risk: intelligence.risk,
      confidence: intelligence.confidence,
      updatedAt: intelligence.updated_at,
    } : null,
    memoryCount: Array.isArray(context?.data?.workspaceMemory) ? context.data.workspaceMemory.length : 0,
  });
}
