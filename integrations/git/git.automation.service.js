import pool from "../../db.js";
import { ensureSystemUser } from "../../services/ai.system.service.js";
import { notifyUser } from "../../services/notification.service.js";
import { updateTaskAsAdminOrManager } from "../../services/task.service.js";
import { handleGitLinkedTaskAutomation } from "../../services/testingAgent.service.js";

const DEFAULT_ENV_SEQUENCE = ["dev", "qa", "stage", "uat", "prod"];
const PROD_ALIASES = new Set(["prod", "production", "main", "master"]);
const DEFAULT_BRANCH_ENV_MAP = {
  develop: "dev",
  "feature/*": "dev",
  qa: "qa",
  test: "qa",
  staging: "stage",
  "release/*": "stage",
  uat: "uat",
  main: "prod",
  master: "prod",
};
const STOP_WORDS = new Set([
  "the", "a", "an", "to", "for", "of", "and", "or", "in", "on", "with", "is", "are",
  "fix", "update", "changes", "code", "task", "issue", "merge", "branch", "commit",
]);

function normalizeBranch(branch = "") {
  return String(branch || "").replace(/^refs\/heads\//i, "").trim().toLowerCase();
}

function normalizeEnv(env = "") {
  return String(env || "").trim().toLowerCase();
}

function normalizeSequence(seq) {
  const input = Array.isArray(seq) ? seq : DEFAULT_ENV_SEQUENCE;
  const result = [];
  const seen = new Set();
  for (const raw of input) {
    const env = normalizeEnv(raw);
    if (!env || seen.has(env)) continue;
    seen.add(env);
    result.push(env);
  }
  if (!result.includes("prod")) result.push("prod");
  return result;
}

function toStatusKeyForEnv(env) {
  const slug = normalizeEnv(env).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `env_${slug}`;
}

function toStatusLabelForEnv(env) {
  const e = normalizeEnv(env);
  return e ? `In ${e.charAt(0).toUpperCase()}${e.slice(1)}` : "In Env";
}

function tokenize(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9/_\-\s]+/g, " ")
    .split(/[\s/_\-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

function unique(arr = []) {
  return Array.from(new Set(arr));
}

function parseTaskKeysFromText(text = "") {
  const matches = String(text || "").toUpperCase().match(/\b([A-Z][A-Z0-9]{1,15}-\d{1,8})\b/g) || [];
  return Array.from(new Set(matches));
}

function parseTaskKeyParts(taskKey) {
  const m = String(taskKey || "").toUpperCase().match(/^([A-Z][A-Z0-9]{1,15})-(\d{1,8})$/);
  if (!m) return null;
  return { projectCode: m[1], ticketNumber: Number(m[2]), taskKey: `${m[1]}-${Number(m[2])}` };
}

function resolveEnvironmentFromBranch(branch, branchMap = {}) {
  const cleanBranch = normalizeBranch(branch);
  const map = branchMap || {};

  for (const [pattern, mappedEnvRaw] of Object.entries(map)) {
    const mappedEnv = normalizeEnv(mappedEnvRaw);
    const pat = normalizeBranch(pattern);
    if (!pat || !mappedEnv) continue;

    if (pat.endsWith("/*")) {
      const prefix = pat.slice(0, -2);
      if (cleanBranch.startsWith(prefix)) return mappedEnv;
      continue;
    }
    if (cleanBranch === pat) return mappedEnv;
  }

  if (["dev", "develop", "development"].includes(cleanBranch)) return "dev";
  if (["qa", "test", "testing"].includes(cleanBranch)) return "qa";
  if (["stage", "staging", "preprod", "pre-prod", "uat"].includes(cleanBranch)) {
    return cleanBranch === "uat" ? "uat" : "stage";
  }
  if (["main", "master", "prod", "production"].includes(cleanBranch)) return "prod";
  if (cleanBranch.startsWith("release/")) return "stage";
  if (cleanBranch.startsWith("hotfix/")) return "stage";

  return null;
}

function getDefaultBranchMap() {
  return { ...DEFAULT_BRANCH_ENV_MAP };
}

function buildEnvOrderMap(sequence) {
  const map = new Map();
  sequence.forEach((env, idx) => map.set(env, idx));
  return map;
}

function getCurrentEnvFromStatus(taskStatus = "") {
  const raw = normalizeEnv(taskStatus);
  if (raw.startsWith("env_")) return raw.slice(4).replace(/_/g, "-");
  if (raw === "completed") return "prod";
  return null;
}

function shouldMoveForward({ currentStatus, targetEnv, sequence, autoCompleteOnProd }) {
  const order = buildEnvOrderMap(sequence);
  const currentEnv = getCurrentEnvFromStatus(currentStatus);
  const currentIdx = currentEnv && order.has(currentEnv) ? order.get(currentEnv) : -1;
  const targetIdx = order.has(targetEnv) ? order.get(targetEnv) : -1;
  if (targetIdx < 0) return false;
  if (targetIdx <= currentIdx) return false;
  if (PROD_ALIASES.has(targetEnv) && !autoCompleteOnProd) return false;
  return true;
}

async function getProjectAutomationSettings(workspaceId, projectId) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM git_project_automation_settings
    WHERE workspace_id = $1
      AND project_id = $2
    LIMIT 1
    `,
    [workspaceId, projectId]
  );
  return rows[0] || null;
}

export async function assertWorkspaceExists(workspaceId) {
  const { rows } = await pool.query(
    `SELECT id FROM workspaces WHERE id = $1 LIMIT 1`,
    [workspaceId]
  );
  if (!rows.length) {
    const err = new Error("Workspace not found");
    err.code = "WORKSPACE_NOT_FOUND";
    throw err;
  }
}

async function assertProjectBelongsWorkspace(projectId, workspaceId) {
  const { rows } = await pool.query(
    `
    SELECT id
    FROM projects
    WHERE id = $1
      AND workspace_id = $2
    LIMIT 1
    `,
    [projectId, workspaceId]
  );
  if (!rows.length) {
    throw new Error("Project not found in this workspace");
  }
}

async function ensureEnvStatusesForProject(projectId, sequence) {
  const nonProdEnvs = sequence.filter((env) => !PROD_ALIASES.has(env));
  if (!nonProdEnvs.length) return new Map();

  const { rows: statuses } = await pool.query(
    `SELECT id, key, label, sort_order FROM project_statuses WHERE project_id = $1 ORDER BY sort_order ASC`,
    [projectId]
  );
  const byKey = new Map(statuses.map((s) => [s.key, s]));
  let sortOrder = statuses.length ? Math.max(...statuses.map((s) => Number(s.sort_order) || 0)) : 0;

  for (const env of nonProdEnvs) {
    const key = toStatusKeyForEnv(env);
    if (byKey.has(key)) continue;
    sortOrder += 1;
    const { rows } = await pool.query(
      `
      INSERT INTO project_statuses (project_id, key, label, sort_order)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
      RETURNING id, key, label, sort_order
      `,
      [projectId, key, toStatusLabelForEnv(env), sortOrder]
    );
    if (rows[0]) byKey.set(rows[0].key, rows[0]);
  }

  return byKey;
}

async function resolveTasksByKeys(workspaceId, taskKeys, limitProjectIds = null) {
  const parts = taskKeys.map(parseTaskKeyParts).filter(Boolean);
  if (!parts.length) return [];

  const params = [workspaceId];
  const valuesSql = [];
  let idx = 2;
  for (const p of parts) {
    valuesSql.push(`($${idx}, $${idx + 1}, $${idx + 2})`);
    params.push(p.projectCode, p.ticketNumber, p.taskKey);
    idx += 3;
  }

  let projectFilterSql = "";
  if (Array.isArray(limitProjectIds) && limitProjectIds.length > 0) {
    projectFilterSql = ` AND p.id = ANY($${idx})`;
    params.push(limitProjectIds);
  }

  const { rows } = await pool.query(
    `
    WITH wanted(project_code, ticket_number, task_key) AS (
      VALUES ${valuesSql.join(", ")}
    )
    SELECT
      w.task_key,
      t.id AS task_id,
      t.task AS task_name,
      t.status AS task_status,
      t.project_id,
      p.name AS project_name,
      p.project_code
    FROM wanted w
    INNER JOIN projects p
      ON p.workspace_id = $1
      AND UPPER(p.project_code) = w.project_code
    INNER JOIN tasks t
      ON t.workspace_id = $1
      AND t.project_id = p.id
      AND t.ticket_number = w.ticket_number
    WHERE TRUE
    ${projectFilterSql}
    `,
    params
  );

  return rows;
}

function extractPushPayload(payload = {}) {
  const branch = normalizeBranch(payload.ref || "");
  const commits = Array.isArray(payload.commits) ? payload.commits : [];
  const repoFullName =
    payload?.repository?.full_name ||
    payload?.repository?.path_with_namespace ||
    payload?.repository?.name ||
    null;
  return { branch, commits, repoFullName };
}

function collectChangedFiles(commits = []) {
  const files = new Set();
  for (const c of commits || []) {
    for (const f of c?.added || []) files.add(String(f || ""));
    for (const f of c?.modified || []) files.add(String(f || ""));
    for (const f of c?.removed || []) files.add(String(f || ""));
  }
  return Array.from(files).filter(Boolean);
}

function buildPushSignal({ branch, commits }) {
  const changedFiles = collectChangedFiles(commits);
  const messages = (commits || []).map((c) => String(c?.message || ""));
  const fullText = `${branch} ${messages.join(" ")} ${changedFiles.join(" ")}`;
  const tokens = unique(tokenize(fullText));
  return { changedFiles, messages, fullText, tokens };
}

function extractTaskKeysFromPush({ branch, commits }) {
  const keys = new Set();
  for (const key of parseTaskKeysFromText(branch)) keys.add(key);
  for (const c of commits || []) {
    const text = `${c?.message || ""} ${c?.id || ""}`;
    for (const key of parseTaskKeysFromText(text)) keys.add(key);
  }
  return Array.from(keys);
}

function getDeliveryId(provider, headers = {}) {
  if (provider === "github") return headers["x-github-delivery"] || null;
  if (provider === "gitlab") return headers["x-gitlab-event-uuid"] || null;
  if (provider === "bitbucket") return headers["x-request-uuid"] || headers["x-event-key"] || null;
  return headers["x-delivery-id"] || null;
}

function normalizeInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

async function resolveOpenTasksForProject(workspaceId, projectId, limit = 300) {
  const { rows } = await pool.query(
    `
    SELECT
      t.id AS task_id,
      t.task AS task_name,
      t.description AS task_description,
      t.status AS task_status,
      t.project_id,
      t.ticket_number,
      p.name AS project_name,
      p.project_code
    FROM tasks t
    INNER JOIN projects p ON p.id = t.project_id
    WHERE t.workspace_id = $1
      AND t.project_id = $2
      AND t.status NOT IN ('completed', 'cancelled')
    ORDER BY t.updated_at DESC
    LIMIT $3
    `,
    [workspaceId, projectId, limit]
  );
  return rows;
}

function computeTaskInferenceScore(task, signal) {
  const titleSet = new Set(tokenize(task?.task_name || ""));
  const descSet = new Set(tokenize(task?.task_description || ""));
  if (!titleSet.size && !descSet.size) return 0;

  let titleOverlap = 0;
  let descOverlap = 0;
  for (const tk of signal.tokens || []) {
    if (titleSet.has(tk)) titleOverlap += 1;
    else if (descSet.has(tk)) descOverlap += 1;
  }

  const fileText = (signal.changedFiles || []).join(" ").toLowerCase();
  const titleText = String(task?.task_name || "").toLowerCase();
  const wholePhraseHit = titleText.length >= 8 && signal.fullText.toLowerCase().includes(titleText);
  const fileHintHit = [...titleSet].some((t) => fileText.includes(t));

  let score = 0;
  score += titleOverlap * 14;
  score += descOverlap * 6;
  if (wholePhraseHit) score += 28;
  if (fileHintHit) score += 12;

  const normalized = Math.min(100, Math.round(score));
  return normalized;
}

async function inferTasksFromCodeSignals({
  workspaceId,
  projectId,
  signal,
  minConfidence,
  maxInferredTasks,
  alreadySelectedTaskIds = new Set(),
}) {
  const openTasks = await resolveOpenTasksForProject(workspaceId, projectId);
  const scored = [];
  for (const task of openTasks) {
    if (alreadySelectedTaskIds.has(task.task_id)) continue;
    const confidence = computeTaskInferenceScore(task, signal);
    if (confidence < minConfidence) continue;
    scored.push({
      ...task,
      confidence,
      inferred: true,
      inferReason: "Semantic match from commit messages and changed files",
    });
  }

  scored.sort((a, b) => b.confidence - a.confidence);
  return scored.slice(0, maxInferredTasks);
}

export async function upsertGitProjectAutomationSettings({
  workspaceId,
  projectId,
  enabled,
  autoStatusEnabled,
  autoCompleteOnProd,
  repoFullName,
  environmentSequence,
  branchEnvironmentMap,
  requireTaskKey,
  autoInferTasks,
  minInferenceConfidence,
  maxInferredTasks,
  actorId,
}) {
  await assertProjectBelongsWorkspace(projectId, workspaceId);

  const sequence = normalizeSequence(environmentSequence);
  const map = branchEnvironmentMap && typeof branchEnvironmentMap === "object" ? branchEnvironmentMap : {};

  const { rows } = await pool.query(
    `
    INSERT INTO git_project_automation_settings (
      workspace_id,
      project_id,
      enabled,
      auto_status_enabled,
      auto_complete_on_prod,
      repo_full_name,
      environment_sequence,
      branch_environment_map,
      require_task_key,
      auto_infer_tasks,
      min_inference_confidence,
      max_inferred_tasks,
      created_by,
      updated_by
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
    ON CONFLICT (workspace_id, project_id)
    DO UPDATE SET
      enabled = EXCLUDED.enabled,
      auto_status_enabled = EXCLUDED.auto_status_enabled,
      auto_complete_on_prod = EXCLUDED.auto_complete_on_prod,
      repo_full_name = EXCLUDED.repo_full_name,
      environment_sequence = EXCLUDED.environment_sequence,
      branch_environment_map = EXCLUDED.branch_environment_map,
      require_task_key = EXCLUDED.require_task_key,
      auto_infer_tasks = EXCLUDED.auto_infer_tasks,
      min_inference_confidence = EXCLUDED.min_inference_confidence,
      max_inferred_tasks = EXCLUDED.max_inferred_tasks,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
    RETURNING *
    `,
    [
      workspaceId,
      projectId,
      Boolean(enabled),
      autoStatusEnabled !== false,
      Boolean(autoCompleteOnProd),
      repoFullName || null,
      JSON.stringify(sequence),
      JSON.stringify(map),
      requireTaskKey !== false,
      autoInferTasks !== false,
      normalizeInteger(minInferenceConfidence, 62, 30, 95),
      normalizeInteger(maxInferredTasks, 2, 1, 8),
      actorId || null,
    ]
  );

  if (rows[0]?.enabled && rows[0]?.auto_status_enabled) {
    await ensureEnvStatusesForProject(projectId, sequence);
  }

  return rows[0];
}

export async function autoConfigureWorkspaceGitAutomation({
  workspaceId,
  actorId = null,
  repoFullName = null,
  minInferenceConfidence = 62,
  maxInferredTasks = 2,
}) {
  if (!workspaceId) throw new Error("workspaceId is required");

  const { rows: projects } = await pool.query(
    `
    SELECT id
    FROM projects
    WHERE workspace_id = $1
    `,
    [workspaceId]
  );

  const configured = [];
  for (const p of projects) {
    const row = await upsertGitProjectAutomationSettings({
      workspaceId,
      projectId: p.id,
      enabled: true,
      autoStatusEnabled: true,
      autoCompleteOnProd: true,
      repoFullName: repoFullName || null,
      environmentSequence: DEFAULT_ENV_SEQUENCE,
      branchEnvironmentMap: getDefaultBranchMap(),
      requireTaskKey: false,
      autoInferTasks: true,
      minInferenceConfidence,
      maxInferredTasks,
      actorId,
    });
    configured.push({ projectId: p.id, enabled: row.enabled });
  }

  return {
    workspaceId,
    projectsConfigured: configured.length,
    configured,
    defaults: {
      environmentSequence: DEFAULT_ENV_SEQUENCE,
      branchEnvironmentMap: getDefaultBranchMap(),
      requireTaskKey: false,
      autoInferTasks: true,
      minInferenceConfidence,
      maxInferredTasks,
      autoCompleteOnProd: true,
    },
  };
}

export async function getGitProjectAutomationSettings({ workspaceId, projectId }) {
  await assertProjectBelongsWorkspace(projectId, workspaceId);
  const settings = await getProjectAutomationSettings(workspaceId, projectId);
  if (settings) return settings;
  return {
    workspace_id: workspaceId,
    project_id: projectId,
    enabled: false,
    auto_status_enabled: true,
    auto_complete_on_prod: false,
    repo_full_name: null,
    environment_sequence: DEFAULT_ENV_SEQUENCE,
    branch_environment_map: {},
    require_task_key: true,
    auto_infer_tasks: true,
    min_inference_confidence: 62,
    max_inferred_tasks: 2,
  };
}

async function loadEnabledSettingsForRepo({ workspaceId, repoFullName }) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM git_project_automation_settings
    WHERE workspace_id = $1
      AND enabled = TRUE
      AND auto_status_enabled = TRUE
      AND (repo_full_name IS NULL OR LOWER(repo_full_name) = LOWER($2))
    `,
    [workspaceId, repoFullName || ""]
  );
  return rows;
}

async function insertEventLog({
  workspaceId,
  provider,
  eventType,
  deliveryId,
  repoFullName,
  branchName,
  commitCount,
  linkedTaskCount,
  appliedTaskCount,
  skippedTaskCount,
  payload,
  result,
}) {
  await pool.query(
    `
    INSERT INTO git_automation_events (
      workspace_id,
      provider,
      event_type,
      delivery_id,
      repo_full_name,
      branch_name,
      commit_count,
      linked_task_count,
      applied_task_count,
      skipped_task_count,
      payload_json,
      result_json
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (provider, delivery_id)
      WHERE delivery_id IS NOT NULL
    DO NOTHING
    `,
    [
      workspaceId,
      provider,
      eventType,
      deliveryId || null,
      repoFullName || null,
      branchName || null,
      Number(commitCount || 0),
      Number(linkedTaskCount || 0),
      Number(appliedTaskCount || 0),
      Number(skippedTaskCount || 0),
      JSON.stringify(payload || {}),
      JSON.stringify(result || {}),
    ]
  );
}

export async function listGitAutomationEvents({ workspaceId, limit = 50, page = 1 }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  const { rows } = await pool.query(
    `
    SELECT
      id,
      workspace_id,
      provider,
      event_type,
      delivery_id,
      repo_full_name,
      branch_name,
      commit_count,
      linked_task_count,
      applied_task_count,
      skipped_task_count,
      result_json->'applied' AS applied,
      result_json->'skipped' AS skipped,
      created_at
    FROM git_automation_events
    WHERE workspace_id = $1
    ORDER BY created_at DESC
    LIMIT $2 OFFSET $3
    `,
    [workspaceId, safeLimit, offset]
  );
  return rows;
}

export async function processGitPushEvent({
  workspaceId,
  provider,
  payload,
  headers = {},
  sourceEventType = "push",
}) {
  if (!workspaceId) {
    throw new Error("workspaceId is required");
  }

  const deliveryId = getDeliveryId(provider, headers);
  if (deliveryId) {
    const { rows } = await pool.query(
      `
      SELECT id
      FROM git_automation_events
      WHERE provider = $1 AND delivery_id = $2
      LIMIT 1
      `,
      [provider, deliveryId]
    );
    if (rows.length) {
      return { ok: true, duplicated: true, message: "Event already processed" };
    }
  }

  const { branch, commits, repoFullName } = extractPushPayload(payload);
  const settingsList = await loadEnabledSettingsForRepo({ workspaceId, repoFullName });
  if (!settingsList.length) {
    await insertEventLog({
      workspaceId,
      provider,
      eventType: sourceEventType,
      deliveryId,
      repoFullName,
      branchName: branch,
      commitCount: commits.length,
      linkedTaskCount: 0,
      appliedTaskCount: 0,
      skippedTaskCount: 0,
      payload: { branch, commits: commits.length },
      result: { reason: "No enabled project automation settings for repo/workspace" },
    });
    return { ok: true, message: "No enabled git automation settings for this repo/workspace" };
  }

  const taskKeys = extractTaskKeysFromPush({ branch, commits });
  const signal = buildPushSignal({ branch, commits });
  const settingsByProject = new Map(settingsList.map((s) => [s.project_id, s]));
  const projectIds = settingsList.map((s) => s.project_id);
  const linkedTasksByKeys = await resolveTasksByKeys(workspaceId, taskKeys, projectIds);
  const selectedTasks = [...linkedTasksByKeys];
  const selectedTaskIds = new Set(selectedTasks.map((t) => t.task_id));

  // Fallback inference when explicit keys are absent/insufficient.
  for (const setting of settingsList) {
    const requiresKey = setting.require_task_key !== false;
    const allowInference = setting.auto_infer_tasks !== false;
    const hasExplicitMatchInProject = linkedTasksByKeys.some((t) => t.project_id === setting.project_id);
    if (!allowInference) continue;
    if (requiresKey && hasExplicitMatchInProject) continue;
    if (requiresKey && taskKeys.length > 0 && !hasExplicitMatchInProject) continue;

    const inferred = await inferTasksFromCodeSignals({
      workspaceId,
      projectId: setting.project_id,
      signal,
      minConfidence: normalizeInteger(setting.min_inference_confidence, 62, 30, 95),
      maxInferredTasks: normalizeInteger(setting.max_inferred_tasks, 2, 1, 8),
      alreadySelectedTaskIds: selectedTaskIds,
    });

    for (const task of inferred) {
      selectedTasks.push(task);
      selectedTaskIds.add(task.task_id);
    }
  }

  const actor = await ensureSystemUser(workspaceId);
  const applied = [];
  const skipped = [];
  const envStatusCache = new Map();
  const appliedTaskIds = [];

  for (const task of selectedTasks) {
    const setting = settingsByProject.get(task.project_id);
    if (!setting) {
      skipped.push({ taskId: task.task_id, reason: "No project setting matched" });
      continue;
    }

    const sequence = normalizeSequence(setting.environment_sequence);
    const targetEnv = resolveEnvironmentFromBranch(branch, setting.branch_environment_map);
    if (!targetEnv) {
      skipped.push({ taskName: task.task_name, reason: `No environment mapping for branch '${branch}'` });
      continue;
    }

    if (!shouldMoveForward({
      currentStatus: task.task_status,
      targetEnv,
      sequence,
      autoCompleteOnProd: Boolean(setting.auto_complete_on_prod),
    })) {
      skipped.push({ taskName: task.task_name, reason: "Non-forward transition or prod auto-complete disabled" });
      continue;
    }

    let nextStatus = toStatusKeyForEnv(targetEnv);
    if (PROD_ALIASES.has(targetEnv)) {
      nextStatus = "completed";
    } else {
      if (!envStatusCache.has(task.project_id)) {
        const byKey = await ensureEnvStatusesForProject(task.project_id, sequence);
        envStatusCache.set(task.project_id, byKey);
      }
      const byKey = envStatusCache.get(task.project_id);
      if (!byKey?.has(nextStatus)) {
        skipped.push({ taskName: task.task_name, reason: `Status column '${nextStatus}' missing and could not be created` });
        continue;
      }
    }

    const updatedTask = await updateTaskAsAdminOrManager(task.task_id, {
      status: nextStatus,
      workspaceId,
      updated_by: actor?.id || null,
    });
    appliedTaskIds.push(task.task_id);

    // Notify the task assignee that their task was automatically moved
    if (updatedTask?.assigned_to) {
      notifyUser({
        user_id: updatedTask.assigned_to,
        type: "task_status_changed",
        message: `Task "${task.task_name}" was automatically moved to ${toStatusLabelForEnv(targetEnv)} by a git push to ${branch}`,
        task_id: task.task_id,
        project_id: task.project_id,
        workspaceId,
      }).catch(() => {}); // fire-and-forget, never block the webhook response
    }

    applied.push({
      taskName: task.task_name,
      projectName: task.project_name,
      taskKey: task.task_key || `${task.project_code || "TASK"}-${task.ticket_number || ""}`,
      from: task.task_status,
      to: nextStatus,
      environment: targetEnv,
      confidence: task.confidence || null,
      inferred: Boolean(task.inferred),
    });
  }

  await insertEventLog({
    workspaceId,
    provider,
    eventType: sourceEventType,
    deliveryId,
    repoFullName,
    branchName: branch,
    commitCount: commits.length,
    linkedTaskCount: selectedTasks.length,
    appliedTaskCount: applied.length,
    skippedTaskCount: skipped.length,
    payload: {
      branch,
      taskKeys,
      changedFiles: signal.changedFiles.slice(0, 200),
      repoFullName,
      commitCount: commits.length,
    },
    result: {
      applied,
      skipped,
    },
  });

  if (appliedTaskIds.length > 0) {
    setImmediate(async () => {
      for (const taskId of appliedTaskIds) {
        try {
          await handleGitLinkedTaskAutomation({
            workspaceId,
            taskId,
            actorId: actor?.id || null,
          });
        } catch (err) {
          console.error("Testing agent auto-run skipped/failed:", {
            workspaceId,
            taskId,
            error: err?.message || String(err),
          });
        }
      }
    });
  }

  return {
    ok: true,
    sourceEventType,
    repoFullName,
    branch,
    taskKeysDetected: taskKeys,
    linkedTasks: selectedTasks.length,
    appliedCount: applied.length,
    skippedCount: skipped.length,
    applied,
    skipped,
  };
}

function normalizeWebhookEventName(provider, headers = {}) {
  const raw =
    headers["x-github-event"] ||
    headers["x-gitlab-event"] ||
    headers["x-event-key"] ||
    "push";
  const event = String(raw || "").toLowerCase();

  if (provider === "github") {
    if (event === "push") return "push";
    if (event === "pull_request") return "pr";
    if (event === "deployment_status") return "deployment";
    return "other";
  }
  if (provider === "gitlab") {
    if (event.includes("push")) return "push";
    if (event.includes("merge request")) return "pr";
    if (event.includes("deployment")) return "deployment";
    return "other";
  }
  if (provider === "bitbucket") {
    if (event.includes("repo:push")) return "push";
    if (event.includes("pullrequest:fulfilled")) return "pr";
    if (event.includes("deployment")) return "deployment";
    return "other";
  }
  return event.includes("push") ? "push" : "other";
}

function normalizePrAsPush(provider, payload = {}) {
  if (provider === "github") {
    const merged = Boolean(payload?.pull_request?.merged);
    if (!merged) return null;
    const targetBranch = payload?.pull_request?.base?.ref || "";
    const repoFullName = payload?.repository?.full_name || null;
    const title = payload?.pull_request?.title || "";
    const body = payload?.pull_request?.body || "";
    const sha = payload?.pull_request?.merge_commit_sha || payload?.pull_request?.head?.sha || "pr-merge";
    return {
      ref: `refs/heads/${targetBranch}`,
      repository: { full_name: repoFullName },
      commits: [{ id: sha, message: `${title} ${body}`.trim() }],
    };
  }
  if (provider === "gitlab") {
    const merged = String(payload?.object_attributes?.state || "").toLowerCase() === "merged";
    if (!merged) return null;
    const targetBranch = payload?.object_attributes?.target_branch || "";
    const repoFullName = payload?.project?.path_with_namespace || payload?.project?.name || null;
    const title = payload?.object_attributes?.title || "";
    const desc = payload?.object_attributes?.description || "";
    const sha = payload?.object_attributes?.last_commit?.id || "mr-merge";
    return {
      ref: `refs/heads/${targetBranch}`,
      repository: { full_name: repoFullName },
      commits: [{ id: sha, message: `${title} ${desc}`.trim() }],
    };
  }
  return null;
}

function normalizeDeploymentAsPush(provider, payload = {}) {
  if (provider === "github") {
    const state = String(payload?.deployment_status?.state || "").toLowerCase();
    if (state !== "success") return null;
    const env = String(payload?.deployment?.environment || "").toLowerCase();
    const branch = payload?.deployment?.ref || env || "staging";
    const repoFullName = payload?.repository?.full_name || null;
    const description = payload?.deployment_status?.description || "deployment success";
    return {
      ref: `refs/heads/${branch}`,
      repository: { full_name: repoFullName },
      commits: [{ id: payload?.deployment?.sha || "deployment", message: description }],
    };
  }
  if (provider === "gitlab") {
    const status = String(payload?.object_attributes?.status || "").toLowerCase();
    if (status !== "success") return null;
    const branch = payload?.ref || payload?.object_attributes?.ref || "staging";
    const repoFullName = payload?.project?.path_with_namespace || payload?.project?.name || null;
    return {
      ref: `refs/heads/${branch}`,
      repository: { full_name: repoFullName },
      commits: [{ id: payload?.commit?.id || "deployment", message: "deployment success" }],
    };
  }
  return null;
}

export async function processGitWebhookEvent({
  workspaceId,
  provider,
  payload,
  headers = {},
}) {
  const type = normalizeWebhookEventName(provider, headers);
  if (type === "push") {
    return processGitPushEvent({ workspaceId, provider, payload, headers, sourceEventType: "push" });
  }
  if (type === "pr") {
    const normalized = normalizePrAsPush(provider, payload);
    if (!normalized) {
      return { ok: true, ignored: true, reason: "PR/MR event not merged yet" };
    }
    return processGitPushEvent({ workspaceId, provider, payload: normalized, headers, sourceEventType: "pr-merge" });
  }
  if (type === "deployment") {
    const normalized = normalizeDeploymentAsPush(provider, payload);
    if (!normalized) {
      return { ok: true, ignored: true, reason: "Deployment event not successful" };
    }
    return processGitPushEvent({ workspaceId, provider, payload: normalized, headers, sourceEventType: "deployment" });
  }
  return { ok: true, ignored: true, reason: "Unsupported webhook event" };
}
