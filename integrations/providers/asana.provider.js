import axios from "axios";
import qs from "qs";

import BaseProvider from "./base.provider.js";
import { registerProvider } from "../integration.registry.js";
import { emitIntegrationEvent } from "../integration.events.js";
import pool from "../../db.js";
import { hashIntegrationState } from "../../events/utils/hashState.js";

const ASANA_API_BASE = "https://app.asana.com/api/1.0";
const TASK_FIELDS =
  "gid,name,completed,assignee,assignee.gid,modified_at,created_at";
const DEFAULT_PROJECT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_INCREMENTAL_LOOKBACK_MS = 2 * 60 * 1000;

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIsoString(value) {
  const date = parseDate(value);
  return date ? date.toISOString() : null;
}

function withLookback(value) {
  const date = parseDate(value);
  if (!date) return null;

  const lookbackMs = readPositiveInt(
    process.env.INTEGRATION_INCREMENTAL_LOOKBACK_MS,
    DEFAULT_INCREMENTAL_LOOKBACK_MS
  );

  return new Date(Math.max(0, date.getTime() - lookbackMs)).toISOString();
}

function normalizeProjects(projects = []) {
  return projects
    .filter((project) => project?.gid)
    .map((project) => ({
      gid: project.gid,
      name: project.name || project.gid,
    }));
}

function getProjectCache(state) {
  const cache = state?.projectCache;
  if (!cache || !Array.isArray(cache.projects)) return null;
  return cache;
}

function isProjectCacheFresh(state) {
  const cache = getProjectCache(state);
  const syncedAt = parseDate(cache?.syncedAt);
  if (!cache || !syncedAt) return false;

  const ttlMs = readPositiveInt(
    process.env.INTEGRATION_PROJECT_CACHE_TTL_MS,
    DEFAULT_PROJECT_CACHE_TTL_MS
  );

  return Date.now() - syncedAt.getTime() < ttlMs;
}

function isTokenExpiredError(err) {
  const messages = err.response?.data?.errors
    ?.map((error) => error?.message)
    .filter(Boolean)
    .join(" ");

  return (
    err.response?.status === 401 &&
    /expired|invalid.*token|token.*invalid/i.test(messages || err.message || "")
  );
}

function isProjectAccessError(err) {
  return err.response?.status === 403 || err.response?.status === 404;
}

async function refreshAsanaToken(refreshToken) {
  const res = await axios.post(
    "https://app.asana.com/-/oauth_token",
    qs.stringify({
      grant_type: "refresh_token",
      client_id: process.env.ASANA_CLIENT_ID,
      client_secret: process.env.ASANA_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  return res.data;
}

async function fetchAsanaWorkspaces(headers) {
  const res = await axios.get(`${ASANA_API_BASE}/workspaces`, { headers });
  return res.data?.data || [];
}

async function fetchProjects(workspaceGid, headers) {
  let offset = null;
  const projects = [];

  do {
    const res = await axios.get(`${ASANA_API_BASE}/projects`, {
      headers,
      params: {
        workspace: workspaceGid,
        archived: false,
        limit: 100,
        offset,
        opt_fields: "gid,name",
      },
    });

    projects.push(...(res.data?.data || []));
    offset = res.data?.next_page?.offset || null;
  } while (offset);

  return normalizeProjects(projects);
}

async function fetchTasks(projectGid, headers, { modifiedSince } = {}) {
  let offset = null;
  const tasks = [];

  do {
    const params = {
      project: projectGid,
      limit: 100,
      offset,
      opt_fields: TASK_FIELDS,
    };

    if (modifiedSince) {
      params.modified_since = modifiedSince;
    }

    const res = await axios.get(`${ASANA_API_BASE}/tasks`, {
      headers,
      params,
    });

    tasks.push(...(res.data?.data || []));
    offset = res.data?.next_page?.offset || null;
  } while (offset);

  return tasks;
}

async function getPreviousState(workspaceId, externalId) {
  const { rows } = await pool.query(
    `
    SELECT state_hash
    FROM integration_entity_state
    WHERE workspace_id = $1
      AND provider = 'asana'
      AND external_entity_id = $2
    LIMIT 1
    `,
    [workspaceId, externalId]
  );

  return rows[0]?.state_hash || null;
}

async function saveState(workspaceId, externalId, hash) {
  await pool.query(
    `
    INSERT INTO integration_entity_state
      (workspace_id, provider, external_entity_id, state_hash, updated_at)
    VALUES ($1, 'asana', $2, $3, NOW())
    ON CONFLICT (workspace_id, provider, external_entity_id)
    DO UPDATE SET
      state_hash = EXCLUDED.state_hash,
      updated_at = NOW()
    `,
    [workspaceId, externalId, hash]
  );
}

async function hasWorkspaceBootstrapped(workspaceId) {
  const { rows } = await pool.query(
    `
    SELECT 1
    FROM integration_entity_state
    WHERE workspace_id = $1
      AND provider = 'asana'
    LIMIT 1
    `,
    [workspaceId]
  );

  return rows.length > 0;
}

class AsanaProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.name = "asana";
  }

  async connect() {
    console.log("Asana provider connected");
    return true;
  }

  async loadIntegrationConfig(workspaceId) {
    const result = await pool.query(
      `
      SELECT config
      FROM workspace_integrations
      WHERE workspace_id = $1
        AND provider = 'asana'
      LIMIT 1
      `,
      [workspaceId]
    );

    return result.rows[0]?.config || null;
  }

  async resolveProjects({ headers, state, syncStartedAt, isBootstrap }) {
    if (!isBootstrap && isProjectCacheFresh(state)) {
      return {
        projects: getProjectCache(state).projects,
        projectCache: getProjectCache(state),
        refreshed: false,
      };
    }

    const workspaces = await fetchAsanaWorkspaces(headers);
    const asanaWorkspace = workspaces[0];

    if (!asanaWorkspace) {
      return {
        projects: [],
        projectCache: {
          workspaceGid: null,
          projects: [],
          syncedAt: syncStartedAt,
        },
        refreshed: true,
      };
    }

    const projects = await fetchProjects(asanaWorkspace.gid, headers);

    return {
      projects,
      projectCache: {
        workspaceGid: asanaWorkspace.gid,
        projects,
        syncedAt: syncStartedAt,
      },
      refreshed: true,
    };
  }

  async sync({
    workspaceId,
    state = {},
    lastSyncedAt = null,
    syncStartedAt = new Date().toISOString(),
    retryTokenRefresh = false,
    // Empty = every project the token can see (previous behaviour). Non-empty
    // restricts this sync to the projects an admin scoped, or to the single
    // project a webhook reported as changed.
    scopedProjectIds = [],
  }) {
    const startedAt = toIsoString(syncStartedAt) || new Date().toISOString();
    let integrationConfig = null;

    try {
      integrationConfig = await this.loadIntegrationConfig(workspaceId);

      if (!integrationConfig?.access_token) {
        throw new Error("Asana access token missing");
      }

      const headers = {
        Authorization: `Bearer ${integrationConfig.access_token}`,
      };

      const entityStateExists = await hasWorkspaceBootstrapped(workspaceId);
      const bootstrapComplete =
        state.bootstrapComplete === true || entityStateExists;
      const isBootstrap = !bootstrapComplete;
      const cursor =
        state.lastCursorAt || state.lastSuccessfulSyncAt || lastSyncedAt;
      const modifiedSince = isBootstrap ? null : withLookback(cursor);

      const { projects: allProjects, projectCache, refreshed } = await this.resolveProjects({
        headers,
        state,
        syncStartedAt: startedAt,
        isBootstrap,
      });

      // Scope AFTER resolution so the project cache still reflects the full
      // account — narrowing the cache would make it wrong for other callers.
      const scopeSet = new Set((scopedProjectIds || []).map(String).filter(Boolean));
      const projects = scopeSet.size
        ? allProjects.filter((project) => scopeSet.has(String(project.gid ?? project.id)))
        : allProjects;

      const stats = {
        projectsInAccount: allProjects.length,
        projectScopeApplied: scopeSet.size > 0,
        mode: isBootstrap ? "bootstrap" : "incremental",
        incrementalSince: modifiedSince,
        projectCacheRefreshed: refreshed,
        projectsChecked: projects.length,
        projectsSkipped: 0,
        tasksObserved: 0,
        statesChanged: 0,
        eventsEmitted: 0,
      };

      for (const project of projects) {
        let tasks = [];

        try {
          tasks = await fetchTasks(project.gid, headers, { modifiedSince });
        } catch (err) {
          if (isTokenExpiredError(err)) {
            throw err;
          }

          if (!isProjectAccessError(err)) {
            throw err;
          }

          stats.projectsSkipped += 1;
          console.log(`Skipping Asana project without task access: ${project.name}`);
          continue;
        }

        stats.tasksObserved += tasks.length;

        for (const task of tasks) {
          const snapshot = {
            completed: task.completed,
            assignee: task.assignee?.gid || null,
          };

          const newHash = hashIntegrationState(snapshot);
          const previousHash = await getPreviousState(workspaceId, task.gid);

          if (previousHash === newHash) {
            continue;
          }

          await saveState(workspaceId, task.gid, newHash);
          stats.statesChanged += 1;

          if (isBootstrap) {
            continue;
          }

          await emitIntegrationEvent("integration.activity.observed", {
            origin: "integration",
            provider: "asana",
            workspaceId,
            entityType: "task",
            externalId: task.gid,
            action: task.completed ? "task_completed" : "task_active",
            title: task.name,
            projectName: project.name,
            observedAt: new Date().toISOString(),
            modifiedAt: task.modified_at,
            createdAt: task.created_at,
          });

          stats.eventsEmitted += 1;
        }
      }

      return {
        state: {
          bootstrapComplete: true,
          lastCursorAt: startedAt,
          projectCache,
        },
        stats,
      };
    } catch (err) {
      if (isTokenExpiredError(err) && !retryTokenRefresh) {
        const refreshToken = integrationConfig?.refresh_token;
        if (!refreshToken) {
          throw new Error("Asana token expired and refresh token is missing");
        }

        const newTokens = await refreshAsanaToken(refreshToken);
        const nextRefreshToken = newTokens.refresh_token || refreshToken;

        await pool.query(
          `
          UPDATE workspace_integrations
          SET config = jsonb_set(
            jsonb_set(config, '{access_token}', to_jsonb($2::text)),
            '{refresh_token}', to_jsonb($3::text)
          )
          WHERE workspace_id = $1
            AND provider = 'asana'
          `,
          [workspaceId, newTokens.access_token, nextRefreshToken]
        );

        return this.sync({
          workspaceId,
          state,
          lastSyncedAt,
          syncStartedAt: startedAt,
          retryTokenRefresh: true,
        });
      }

      throw err;
    }
  }

  async validate() {
    return true;
  }
}

registerProvider("asana", AsanaProvider);
export default AsanaProvider;
