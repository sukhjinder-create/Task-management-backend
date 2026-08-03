// integrations/custom/customProvider.service.js
//
// Admin-defined integrations: connect any REST API without a code change.
//
// The admin supplies a base URL, how to authenticate, and where the data lives;
// Asystence fetches a real sample so they can map that tool's field names onto
// Asystence's visually. Everything then flows through the same normalizer and
// the same import path the built-in providers use.

import crypto from "node:crypto";
import pool from "../../db.js";
import { safeFetchJson } from "../core/safeFetch.js";
import { normalizeExternalTask, matchAssignee, getPath } from "../core/taskNormalizer.js";
import { customProviderKey, describeCustomProvider } from "../core/providerCapabilities.js";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{1,62}$/;

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Credentials must never be returned to the browser once saved — an admin can
 * replace them, but nobody should be able to read another admin's token back
 * out of the API.
 */
function redactAuth(authConfig, authType) {
  const config = asObject(authConfig);
  const redacted = {};
  for (const [key, value] of Object.entries(config)) {
    const isSecret = ["token", "value", "password"].includes(key);
    redacted[key] = isSecret && value ? "••••••••" : value;
  }
  return { authType, authConfig: redacted, hasCredentials: Boolean(Object.keys(config).length) };
}

function presentProvider(row) {
  return {
    ...describeCustomProvider(row),
    id: row.id,
    slug: row.provider_key,
    baseUrl: row.base_url,
    endpoints: row.endpoints || {},
    fieldMappings: row.field_mappings || {},
    valueMappings: row.value_mappings || {},
    auth: redactAuth(row.auth_config, row.auth_type),
    lastTestMessage: row.last_test_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listCustomProviders(workspaceId) {
  const { rows } = await pool.query(
    `SELECT * FROM custom_integration_providers WHERE workspace_id = $1 ORDER BY name`,
    [workspaceId]
  );
  return rows.map(presentProvider);
}

export async function getCustomProvider(workspaceId, slug) {
  const { rows } = await pool.query(
    `SELECT * FROM custom_integration_providers WHERE workspace_id = $1 AND provider_key = $2 LIMIT 1`,
    [workspaceId, slug]
  );
  return rows[0] || null;
}

export async function saveCustomProvider({ workspaceId, actorUserId, slug = null, payload = {} }) {
  const name = String(payload.name || "").trim();
  if (!name) throw new Error("Give the platform a name.");

  const providerSlug = slug || slugify(name);
  if (!SLUG_PATTERN.test(providerSlug)) {
    throw new Error("Platform name must contain letters or numbers.");
  }

  const baseUrl = String(payload.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Enter the platform's API base URL.");

  const authType = payload.authType || "bearer";
  if (!["bearer", "header", "basic", "query", "none"].includes(authType)) {
    throw new Error(`Unsupported authentication type: ${authType}`);
  }

  // Preserve stored credentials when the admin edits other settings without
  // re-entering them (the UI sends back the redacted placeholder, not the real value).
  const existing = await getCustomProvider(workspaceId, providerSlug);
  const incomingAuth = asObject(payload.authConfig);
  const mergedAuth = { ...asObject(existing?.auth_config) };
  for (const [key, value] of Object.entries(incomingAuth)) {
    if (value === "••••••••") continue;
    mergedAuth[key] = value;
  }

  const { rows } = await pool.query(
    `
    INSERT INTO custom_integration_providers
      (workspace_id, provider_key, name, description, base_url, auth_type, auth_config,
       endpoints, field_mappings, value_mappings, status, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12)
    ON CONFLICT (workspace_id, provider_key) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      base_url = EXCLUDED.base_url,
      auth_type = EXCLUDED.auth_type,
      auth_config = EXCLUDED.auth_config,
      endpoints = EXCLUDED.endpoints,
      field_mappings = EXCLUDED.field_mappings,
      value_mappings = EXCLUDED.value_mappings,
      status = EXCLUDED.status,
      updated_at = NOW()
    RETURNING *
    `,
    [
      workspaceId,
      providerSlug,
      name,
      payload.description || null,
      baseUrl,
      authType,
      JSON.stringify(mergedAuth),
      JSON.stringify(asObject(payload.endpoints)),
      JSON.stringify(asObject(payload.fieldMappings)),
      JSON.stringify(asObject(payload.valueMappings)),
      payload.status === "active" ? "active" : (existing?.status || "draft"),
      actorUserId || null,
    ]
  );
  return presentProvider(rows[0]);
}

export async function deleteCustomProvider(workspaceId, slug) {
  await pool.query(
    `DELETE FROM custom_integration_providers WHERE workspace_id = $1 AND provider_key = $2`,
    [workspaceId, slug]
  );
  // Leave imported tasks and their mappings intact — deleting a connector must
  // not silently destroy data the workspace already imported through it.
  await pool.query(
    `DELETE FROM integration_sync_config WHERE workspace_id = $1 AND provider = $2`,
    [workspaceId, customProviderKey(slug)]
  );
}

/** Resolve "{projectId}" style placeholders and join onto the base URL. */
function buildUrl(baseUrl, pathTemplate, vars = {}) {
  const path = String(pathTemplate || "").replace(/\{(\w+)\}/g, (_, key) =>
    encodeURIComponent(vars[key] ?? "")
  );
  if (/^https?:\/\//i.test(path)) return path;
  return `${String(baseUrl).replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * Pull the array of records out of a response, whether the API returns a bare
 * array, {data:[...]}, {issues:[...]}, or a configured nested path.
 */
function extractItems(payload, itemsPath) {
  if (itemsPath) {
    const value = getPath(payload, itemsPath);
    return Array.isArray(value) ? value : [];
  }
  if (Array.isArray(payload)) return payload;
  for (const key of ["data", "items", "results", "issues", "tasks", "values", "records", "elements"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

async function callProvider(row, { path, vars = {}, method = "GET" }) {
  return safeFetchJson(buildUrl(row.base_url, path, vars), {
    method,
    authType: row.auth_type,
    authConfig: asObject(row.auth_config),
  });
}

/**
 * Verify the connection and return a real sample record, so the admin maps
 * against what their API actually returns rather than guessing.
 */
export async function testCustomProvider({ workspaceId, slug, probePath = null }) {
  const row = await getCustomProvider(workspaceId, slug);
  if (!row) throw new Error("Platform not found.");

  const endpoints = asObject(row.endpoints);
  const path = probePath || endpoints.tasks?.path || endpoints.projects?.path || "";
  if (!path) throw new Error("Add an endpoint path to test against (for example /rest/issues).");

  let result;
  let message;
  let ok = false;
  let sample = null;
  let sampleFields = [];

  try {
    result = await callProvider(row, { path });
    if (!result.ok) {
      message = `The platform responded with HTTP ${result.status}.` +
        (result.status === 401 || result.status === 403
          ? " That usually means the credentials are wrong or lack permission."
          : "");
    } else if (result.parseError) {
      message = "The platform responded, but not with JSON. Check the endpoint path.";
    } else {
      const items = extractItems(result.data, endpoints.tasks?.itemsPath || endpoints.projects?.itemsPath);
      if (!items.length) {
        ok = true;
        message = "Connected successfully, but that endpoint returned no records to sample.";
      } else {
        ok = true;
        sample = items[0];
        sampleFields = describeSampleFields(sample);
        message = `Connected successfully. Found ${items.length} record${items.length === 1 ? "" : "s"}.`;
      }
    }
  } catch (error) {
    message = error.message;
  }

  await pool.query(
    `UPDATE custom_integration_providers
     SET last_tested_at = NOW(), last_test_ok = $3, last_test_message = $4, updated_at = NOW()
     WHERE workspace_id = $1 AND provider_key = $2`,
    [workspaceId, slug, ok, String(message || "").slice(0, 1000)]
  );

  return { ok, message, sample, sampleFields, status: result?.status ?? null };
}

/**
 * Flatten a sample record into selectable "field paths" for the mapping UI,
 * including a preview value so the admin can recognise each field.
 */
export function describeSampleFields(sample, prefix = "", depth = 0, out = []) {
  if (depth > 3 || sample == null || typeof sample !== "object") return out;

  for (const [key, value] of Object.entries(sample)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      // Objects like { name: "Done" } are commonly what an admin wants to map,
      // so record the container as well as recursing into it.
      out.push({ path, type: "object", preview: JSON.stringify(value).slice(0, 80) });
      describeSampleFields(value, path, depth + 1, out);
    } else if (Array.isArray(value)) {
      out.push({ path, type: "array", preview: `${value.length} item(s)` });
      if (value.length && typeof value[0] === "object") {
        describeSampleFields(value[0], `${path}.0`, depth + 1, out);
      }
    } else {
      out.push({
        path,
        type: value === null ? "null" : typeof value,
        preview: String(value ?? "").slice(0, 80),
      });
    }
  }
  return out;
}

export async function listCustomProviderProjects({ workspaceId, slug }) {
  const row = await getCustomProvider(workspaceId, slug);
  if (!row) throw new Error("Platform not found.");
  const projects = asObject(row.endpoints).projects;
  if (!projects?.path) return [];

  const result = await callProvider(row, { path: projects.path });
  if (!result.ok) throw new Error(`The platform responded with HTTP ${result.status}.`);

  const idField = projects.idField || "id";
  const nameField = projects.nameField || "name";
  return extractItems(result.data, projects.itemsPath).map((item) => ({
    id: String(getPath(item, idField) ?? ""),
    name: String(getPath(item, nameField) ?? getPath(item, idField) ?? "Untitled"),
    raw: item,
  })).filter((project) => project.id);
}

export async function listCustomProviderTasks({ workspaceId, slug, projectId = null }) {
  const row = await getCustomProvider(workspaceId, slug);
  if (!row) throw new Error("Platform not found.");
  const tasks = asObject(row.endpoints).tasks;
  if (!tasks?.path) throw new Error("Add a tasks endpoint before importing.");

  const result = await callProvider(row, { path: tasks.path, vars: { projectId } });
  if (!result.ok) throw new Error(`The platform responded with HTTP ${result.status}.`);

  return { raw: extractItems(result.data, tasks.itemsPath), row };
}

/**
 * Import a custom provider's tasks using the same normalizer, the same
 * dedupe/mapping table and the same history/rollback mechanism as the built-ins.
 */
export async function migrateCustomProvider({
  workspaceId, slug, projectId = null, triggeredBy, mode = "skip",
}) {
  const { raw, row } = await listCustomProviderTasks({ workspaceId, slug, projectId });
  if (!raw.length) throw new Error("No records found to import.");

  const providerId = customProviderKey(slug);
  const { getSystemActorId } = await import("../../events/systemActor.service.js");
  const { default: taskRepository } = await import("../../repositories/task.repository.js");
  const { recordMigrationImport } = await import("../../services/migrationHistory.service.js");

  const label = projectId ? `${row.name} · ${projectId}` : row.name;
  const { rows: projectRows } = await pool.query(
    `INSERT INTO projects (name, workspace_id, added_by) VALUES ($1,$2,$3) RETURNING id`,
    [`[Imported] ${label}`, workspaceId, triggeredBy]
  );
  const newProjectId = projectRows[0].id;
  const systemActorId = await getSystemActorId(workspaceId);

  const { rows: workspaceUsers } = await pool.query(
    "SELECT id, email, username FROM users WHERE workspace_id = $1",
    [workspaceId]
  );

  const fieldMappings = asObject(row.field_mappings);
  const valueMappings = asObject(row.value_mappings);
  const unmappedValues = new Set();
  let importedCount = 0;
  let skippedCount = 0;

  for (const item of raw) {
    const normalized = normalizeExternalTask(item, {
      fieldMappings,
      valueMappings,
      resolveAssignee: (value) => matchAssignee(value, workspaceUsers),
    });
    for (const value of normalized.unmapped) unmappedValues.add(value);

    const externalId = normalized.externalId;
    if (!externalId) continue;

    if (mode === "skip") {
      const { rows: existing } = await pool.query(
        `SELECT 1 FROM integration_task_mappings m
         JOIN tasks t ON t.id = m.internal_task_id
         WHERE m.workspace_id=$1 AND m.provider=$2 AND m.external_task_id=$3 LIMIT 1`,
        [workspaceId, providerId, externalId]
      );
      if (existing.length) { skippedCount += 1; continue; }
    }

    const created = await taskRepository.createTask({
      ...normalized.task,
      description: normalized.task.description?.trim() || null,
      project_id: newProjectId,
      added_by: systemActorId,
      workspaceId,
    });

    await pool.query(
      `INSERT INTO integration_task_mappings
         (workspace_id, provider, external_task_id, internal_task_id)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [workspaceId, providerId, externalId, created.id]
    );
    importedCount += 1;
  }

  const importRecord = await recordMigrationImport({
    workspaceId,
    source: providerId,
    stats: { importedTasks: importedCount, skippedTasks: skippedCount, unmappedValues: [...unmappedValues] },
    metadata: {
      projectId: newProjectId,
      customProvider: slug,
      externalProjectId: projectId,
      unmappedValues: [...unmappedValues],
    },
    triggeredBy,
  });

  return {
    success: true,
    importedTasks: importedCount,
    skippedTasks: skippedCount,
    projectId: newProjectId,
    unmappedValues: [...unmappedValues],
    importId: importRecord.id,
    importNumber: importRecord.import_number,
  };
}

/** Secret for a custom provider's inbound webhook endpoint. */
export function generateWebhookSecret() {
  return crypto.randomBytes(32).toString("hex");
}

export const __testables = { buildUrl, extractItems, slugify, redactAuth };
