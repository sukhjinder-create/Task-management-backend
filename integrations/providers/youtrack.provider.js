import BaseProvider from "./base.provider.js";
import { registerProvider } from "../integration.registry.js";
import youtrackAdapter from "../youtrack/youtrack.adapter.js";
import { emitIntegrationEvent } from "../integration.events.js";
import pool from "../../db.js";
import { hashIntegrationState } from "../../events/utils/hashState.js";

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

function isAuthError(err) {
  return err.response?.status === 401;
}

function isProjectAccessError(err) {
  return err.response?.status === 403 || err.response?.status === 404;
}

async function getPreviousState(workspaceId, externalId) {
  const { rows } = await pool.query(
    `
    SELECT state_hash
    FROM integration_entity_state
    WHERE workspace_id=$1
      AND provider='youtrack'
      AND external_entity_id=$2
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
    VALUES ($1,'youtrack',$2,$3,NOW())
    ON CONFLICT (workspace_id, provider, external_entity_id)
    DO UPDATE SET
      state_hash=EXCLUDED.state_hash,
      updated_at=NOW()
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
      AND provider = 'youtrack'
    LIMIT 1
    `,
    [workspaceId]
  );

  return rows.length > 0;
}

class YouTrackProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.name = "youtrack";
  }

  async connect({ workspaceId, config, rehydrated }) {
    this.workspaceId = workspaceId;
    this.config = config;

    console.log(
      `YouTrack connected for workspace ${workspaceId}`,
      rehydrated ? "(rehydrated)" : ""
    );

    return true;
  }

  async resolveProjects({ workspaceId, state, syncStartedAt, isBootstrap }) {
    if (!isBootstrap && isProjectCacheFresh(state)) {
      return {
        projects: getProjectCache(state).projects,
        projectCache: getProjectCache(state),
        refreshed: false,
      };
    }

    const projects = await youtrackAdapter.listProjects(workspaceId);
    const projectCache = {
      projects,
      syncedAt: syncStartedAt,
    };

    return {
      projects,
      projectCache,
      refreshed: true,
    };
  }

  async sync({
    workspaceId,
    state = {},
    lastSyncedAt = null,
    syncStartedAt = new Date().toISOString(),
    // Empty = every project the token can see (previous behaviour). Non-empty
    // restricts this sync to the projects an admin scoped, or to the single
    // project a webhook reported as changed.
    scopedProjectIds = [],
  }) {
    const startedAt = toIsoString(syncStartedAt) || new Date().toISOString();
    const entityStateExists = await hasWorkspaceBootstrapped(workspaceId);
    const bootstrapComplete =
      state.bootstrapComplete === true || entityStateExists;
    const isBootstrap = !bootstrapComplete;
    const cursor =
      state.lastCursorAt || state.lastSuccessfulSyncAt || lastSyncedAt;
    const updatedAfter = isBootstrap ? null : withLookback(cursor);

    const { projects: allProjects, projectCache, refreshed } = await this.resolveProjects({
      workspaceId,
      state,
      syncStartedAt: startedAt,
      isBootstrap,
    });

    // Scope AFTER resolution so the project cache still reflects the full
    // instance — narrowing the cache would make it wrong for other callers.
    // Matches on id, key or name since callers may hold any of them.
    const scopeSet = new Set((scopedProjectIds || []).map(String).filter(Boolean));
    const projects = scopeSet.size
      ? allProjects.filter((project) =>
          scopeSet.has(String(project.id)) ||
          scopeSet.has(String(project.key)) ||
          scopeSet.has(String(project.name))
        )
      : allProjects;

    const stats = {
      projectsInAccount: allProjects.length,
      projectScopeApplied: scopeSet.size > 0,
      mode: isBootstrap ? "bootstrap" : "incremental",
      incrementalSince: updatedAfter,
      projectCacheRefreshed: refreshed,
      projectsChecked: projects.length,
      projectsSkipped: 0,
      issuesObserved: 0,
      statesChanged: 0,
      eventsEmitted: 0,
    };

    for (const project of projects) {
      let tasks = [];

      try {
        tasks = await youtrackAdapter.listTasks(workspaceId, project.key, {
          updatedAfter,
        });
      } catch (err) {
        if (isAuthError(err)) {
          throw err;
        }

        if (!isProjectAccessError(err)) {
          throw err;
        }

        stats.projectsSkipped += 1;
        console.log(`Skipping YouTrack project without task access: ${project.name}`);
        continue;
      }

      stats.issuesObserved += tasks.length;

      for (const issue of tasks) {
        const snapshot = {
          completed: issue.completed,
          status: issue.status,
          assignee: issue.assignee,
          updated: issue.updated,
        };

        const newHash = hashIntegrationState(snapshot);
        const previousHash = await getPreviousState(workspaceId, issue.id);

        if (previousHash === newHash) {
          continue;
        }

        await saveState(workspaceId, issue.id, newHash);
        stats.statesChanged += 1;

        if (isBootstrap) {
          continue;
        }

        await emitIntegrationEvent("integration.activity.observed", {
          origin: "integration",
          provider: "youtrack",
          workspaceId,
          entityType: "task",
          externalId: issue.id,
          title: issue.name,
          projectName: project.name,
          action: issue.completed ? "task_completed" : "task_active",
          observedAt: new Date().toISOString(),
          modifiedAt: issue.updated,
          createdAt: issue.created,
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
  }

  async validate() {
    return true;
  }
}

registerProvider("youtrack", YouTrackProvider);

export default YouTrackProvider;
