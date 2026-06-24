import pool from "../../db.js";
import { recalculateImpactedIntelligence } from "../engine/unifiedIntelligence.engine.js";
import { recordRecalculationEvent } from "../repositories/unifiedIntelligence.repository.js";

const COALESCE_DELAY_MS = 750;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1500;

const pendingJobs = new Map();

function uniq(values = []) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(String(value || ""));
}

function uniqUuid(values = []) {
  return uniq(values).filter(isUuid);
}

function stableKey({
  workspaceId,
  reason,
  sourceType = null,
  sourceId = null,
  userIds = [],
  projectIds = [],
  managerIds = [],
}) {
  return [
    workspaceId,
    reason,
    sourceType || "",
    sourceId || "",
    uniqUuid(userIds).sort().join(","),
    uniqUuid(projectIds).sort().join(","),
    uniqUuid(managerIds).sort().join(","),
  ].join("|");
}

function mergeJob(existing, next) {
  return {
    ...existing,
    workspaceId: existing.workspaceId || next.workspaceId,
    reason: existing.reason || next.reason,
    sourceType: existing.sourceType || next.sourceType || null,
    sourceId: existing.sourceId || next.sourceId || null,
    userIds: uniqUuid([...(existing.userIds || []), ...(next.userIds || [])]),
    projectIds: uniqUuid([...(existing.projectIds || []), ...(next.projectIds || [])]),
    managerIds: uniqUuid([...(existing.managerIds || []), ...(next.managerIds || [])]),
    metadata: {
      ...(existing.metadata || {}),
      ...(next.metadata || {}),
      coalescedEvents: Number(existing.metadata?.coalescedEvents || 1) + 1,
    },
    attempt: existing.attempt || 0,
    dedupeKey: existing.dedupeKey || next.dedupeKey,
  };
}

async function emitUpdate(workspaceId, reason, result) {
  try {
    const { emitWorkspaceIntelligenceUpdate } = await import("../../realtime/socket.js");
    emitWorkspaceIntelligenceUpdate(workspaceId, {
      type: "enterprise-intelligence-updated",
      reason,
      impacted: {
        users: result.users.length,
        projects: result.projects.length,
        teams: result.teams.length,
      },
    });
  } catch {
    // Realtime notifications are best-effort; repository updates are authoritative.
  }
}

function scheduleJob(key, delayMs) {
  const job = pendingJobs.get(key);
  if (!job) return;
  clearTimeout(job.timer);
  job.timer = setTimeout(() => processJob(key), delayMs);
  pendingJobs.set(key, job);
}

async function processJob(key) {
  const job = pendingJobs.get(key);
  if (!job) return;

  job.attempt = Number(job.attempt || 0) + 1;
  pendingJobs.set(key, job);

  try {
    const result = await recalculateImpactedIntelligence({
      workspaceId: job.workspaceId,
      reason: job.reason,
      userIds: job.userIds,
      projectIds: job.projectIds,
      managerIds: job.managerIds,
      sourceType: job.sourceType,
      sourceId: job.sourceId,
      metadata: {
        ...job.metadata,
        dedupeKey: job.dedupeKey,
        queueAttempt: job.attempt,
      },
    });

    pendingJobs.delete(key);
    await emitUpdate(job.workspaceId, job.reason, result);
  } catch (err) {
    if (err?.code === "INTELLIGENCE_SCHEMA_MISSING") {
      pendingJobs.delete(key);
      return;
    }

    if (job.attempt < MAX_ATTEMPTS) {
      const delay = RETRY_BASE_DELAY_MS * job.attempt;
      scheduleJob(key, delay);
      return;
    }

    pendingJobs.delete(key);
    await recordRecalculationEvent({
      workspaceId: job.workspaceId,
      reason: job.reason,
      sourceType: job.sourceType,
      sourceId: job.sourceId,
      userIds: job.userIds,
      projectIds: job.projectIds,
      teamKeys: job.managerIds.map((id) => `manager:${id}`),
      status: "failed",
      error: err.message,
      metadata: {
        ...job.metadata,
        dedupeKey: job.dedupeKey,
        attempts: job.attempt,
        retryExhausted: true,
      },
    });
    console.error("[enterprise-intelligence] impacted recalculation failed:", err.message);
  }
}

export async function resolveTaskImpact({ taskId, workspaceId }) {
  if (!taskId || !workspaceId) {
    return { userIds: [], projectIds: [] };
  }

  const { rows } = await pool.query(
    `SELECT id, assigned_to, added_by, project_id
     FROM tasks
     WHERE id = $1 AND workspace_id = $2
     LIMIT 1`,
    [taskId, workspaceId]
  ).catch(() => ({ rows: [] }));

  const task = rows[0];
  if (!task) return { userIds: [], projectIds: [] };

  return {
    userIds: uniqUuid([task.assigned_to, task.added_by]),
    projectIds: uniqUuid([task.project_id]),
  };
}

export function queueImpactedIntelligenceRecalculation({
  workspaceId,
  reason,
  userIds = [],
  projectIds = [],
  managerIds = [],
  sourceType = null,
  sourceId = null,
  metadata = {},
}) {
  if (!workspaceId || !reason) return;

  const normalized = {
    workspaceId,
    reason,
    userIds: uniqUuid(userIds),
    projectIds: uniqUuid(projectIds),
    managerIds: uniqUuid(managerIds),
    sourceType,
    sourceId,
    metadata,
  };
  const key = stableKey(normalized);
  const next = {
    ...normalized,
    dedupeKey: key,
    attempt: 0,
  };
  const existing = pendingJobs.get(key);
  pendingJobs.set(key, existing ? mergeJob(existing, next) : next);
  scheduleJob(key, COALESCE_DELAY_MS);
}

export async function queueTaskImpact({ workspaceId, taskId, reason, userIds = [], projectIds = [], metadata = {} }) {
  const impact = await resolveTaskImpact({ taskId, workspaceId });
  queueImpactedIntelligenceRecalculation({
    workspaceId,
    reason,
    userIds: uniqUuid([...impact.userIds, ...userIds]),
    projectIds: uniqUuid([...impact.projectIds, ...projectIds]),
    sourceType: "task",
    sourceId: taskId,
    metadata,
  });
}

export function getRecalculationQueueDiagnostics() {
  return {
    pendingJobs: pendingJobs.size,
    coalesceDelayMs: COALESCE_DELAY_MS,
    maxAttempts: MAX_ATTEMPTS,
    keys: [...pendingJobs.keys()],
  };
}

export default {
  resolveTaskImpact,
  queueImpactedIntelligenceRecalculation,
  queueTaskImpact,
  getRecalculationQueueDiagnostics,
};
