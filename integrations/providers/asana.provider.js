console.log("🔥 ASANA PROVIDER FILE EXECUTED");

import BaseProvider from "./base.provider.js";
import { registerProvider } from "../integration.registry.js";
import { emitIntegrationEvent } from "../integration.events.js";
import { IntegrationEvents } from "../integration.event.types.js";

import axios from "axios";
import pool from "../../db.js";
import qs from "qs";
import { hashIntegrationState } from "../../events/utils/hashState.js";

/* =====================================================
   TOKEN REFRESH (ASANA REQUIRES URLENCODED BODY)
===================================================== */
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

/* =====================================================
   FETCH ALL TASKS (PAGINATION SAFE)
===================================================== */
async function fetchAllTasks(projectId, headers) {
  let offset = null;
  const allTasks = [];

  do {
    const res = await axios.get(
      `https://app.asana.com/api/1.0/projects/${projectId}/tasks`,
      {
        headers,
        params: {
          limit: 100, // Asana max
          offset,
          opt_fields:
            "gid,name,completed,assignee,modified_at,created_at"
        }
      }
    );

    allTasks.push(...(res.data?.data || []));

    offset = res.data?.next_page?.offset || null;

  } while (offset);

  return allTasks;
}

/* =====================================================
   STATE TRACKING (ENTERPRISE DIFFING)
===================================================== */

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

/* =====================================================
   BOOTSTRAP DETECTION (PREVENT EVENT FLOOD)
===================================================== */

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

  /* =====================================================
     MAIN SYNC WORKER
  ===================================================== */
  async sync({ workspaceId }) {
    console.log(`🔄 Asana sync running for workspace ${workspaceId}`);

    let integrationConfig = null;

    try {
      /* ---------------- LOAD TOKENS ---------------- */
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

      if (!result.rows.length) return;

      integrationConfig = result.rows[0].config;

      const accessToken = integrationConfig?.access_token;
      if (!accessToken) {
        console.log("No access token found");
        return;
      }

      const headers = {
        Authorization: `Bearer ${accessToken}`,
      };

      // ✅ Detect if this is first sync (bootstrap)
    const isBootstrapped = await hasWorkspaceBootstrapped(workspaceId);

      /* ---------------- STEP 1: WORKSPACES ---------------- */
      const wsRes = await axios.get(
        "https://app.asana.com/api/1.0/workspaces",
        { headers }
      );

      const asanaWorkspace = wsRes.data?.data?.[0];
      console.log("✅ Workspaces response:", wsRes.data);

      if (!asanaWorkspace) return;

      /* ---------------- STEP 2: PROJECTS ---------------- */
      const projectRes = await axios.get(
        "https://app.asana.com/api/1.0/projects",
        {
          headers,
          params: {
            workspace: asanaWorkspace.gid,
            archived: false,
            opt_fields: "gid,name",
          },
        }
      );

      const projects = projectRes.data?.data || [];

      if (!projects.length) {
        console.log("No Asana projects found");
        return;
      }

      /* ---------------- STEP 3: ACTIVITY SUPERVISION ---------------- */
for (const project of projects) {

  console.log("👁 Observing project:", project.name);

  let tasks;

  try {
    // ✅ FULL PAGINATION (NO 20 LIMIT ANYMORE)
    tasks = await fetchAllTasks(project.gid, headers);

  } catch {
    console.log(
      `⚠️ Skipping project (no task access): ${project.name}`
    );
    continue;
  }

  console.log(
    `✅ Tasks observed from ${project.name}: ${tasks.length}`
  );

  for (const task of tasks) {

  // ---- CREATE STATE SNAPSHOT ----
  const state = {
    completed: task.completed,
    assignee: task.assignee?.gid || null,
  };

  const newHash = hashIntegrationState(state);

  const previousHash = await getPreviousState(
    workspaceId,
    task.gid
  );

  // ✅ NOTHING CHANGED → SKIP
  if (previousHash === newHash) {
    continue;
  }

  // ---- SAVE NEW STATE ----
await saveState(workspaceId, task.gid, newHash);

// 🚨 During bootstrap we DO NOT emit events
if (!isBootstrapped) {
  continue;
}

// ---- EMIT EVENT ONLY AFTER BOOTSTRAP ----
await emitIntegrationEvent(
  "integration.activity.observed",
  {
    origin: "integration",
    provider: "asana",
    workspaceId,

    entityType: "task",
    externalId: task.gid,

    action: task.completed
      ? "task_completed"
      : "task_active",

    title: task.name,
    projectName: project.name,

    observedAt: new Date().toISOString(),
    modifiedAt: task.modified_at,
    createdAt: task.created_at,
  }
);
}
}

    } catch (err) {
      const errorData = err.response?.data;

      /* ---------------- TOKEN EXPIRED ---------------- */
      if (
        errorData?.errors?.[0]?.message?.includes("token has expired")
      ) {
        console.log("🔄 Refreshing Asana token...");

        const refreshToken = integrationConfig?.refresh_token;
        if (!refreshToken) {
          console.log("No refresh token available");
          return;
        }

        const newTokens = await refreshAsanaToken(refreshToken);

        await pool.query(
          `
          UPDATE workspace_integrations
          SET config = jsonb_set(
            jsonb_set(config,'{access_token}',to_jsonb($2::text)),
            '{refresh_token}',to_jsonb($3::text)
          )
          WHERE workspace_id = $1
            AND provider = 'asana'
        `,
          [workspaceId, newTokens.access_token, newTokens.refresh_token]
        );

        console.log("✅ Asana token refreshed");

        // retry once with fresh token
        return this.sync({ workspaceId });
      }

      console.error(
        "❌ ASANA FULL ERROR:",
        JSON.stringify(errorData, null, 2)
      );
    }
  }

  async validate() {
    return true;
  }
}

registerProvider("asana", AsanaProvider);
export default AsanaProvider;
