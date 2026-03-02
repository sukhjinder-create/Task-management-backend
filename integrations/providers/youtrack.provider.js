console.log("🔥 YOUTRACK PROVIDER FILE EXECUTED");

import BaseProvider from "./base.provider.js";
import { registerProvider } from "../integration.registry.js";
import youtrackAdapter from "../youtrack/youtrack.adapter.js";
import { emitIntegrationEvent }
  from "../integration.events.js";
import pool from "../../db.js";
import { hashIntegrationState }
  from "../../events/utils/hashState.js";
import { upsertIntegration } from "../integration.repository.js";

async function getPreviousState(workspaceId, externalId) {
  const { rows } = await pool.query(`
    SELECT state_hash
    FROM integration_entity_state
    WHERE workspace_id=$1
      AND provider='youtrack'
      AND external_entity_id=$2
    LIMIT 1
  `, [workspaceId, externalId]);

  return rows[0]?.state_hash || null;
}

async function saveState(workspaceId, externalId, hash) {
  await pool.query(`
    INSERT INTO integration_entity_state
      (workspace_id, provider, external_entity_id, state_hash, updated_at)
    VALUES ($1,'youtrack',$2,$3,NOW())
    ON CONFLICT (workspace_id, provider, external_entity_id)
    DO UPDATE SET
      state_hash=EXCLUDED.state_hash,
      updated_at=NOW()
  `, [workspaceId, externalId, hash]);
}

class YouTrackProvider extends BaseProvider {

  constructor(config = {}) {
    super(config);
    this.name = "youtrack";
  }

  /* =============================
     CONNECT (called on rehydrate)
  ============================= */
  async connect({ workspaceId, config, rehydrated }) {

    this.workspaceId = workspaceId;
    this.config = config;

    console.log(
      `✅ YouTrack connected for workspace ${workspaceId}`,
      rehydrated ? "(rehydrated)" : ""
    );

    return true;
  }

  /* =============================
     SYNC WORKER
  ============================= */
  async sync({ workspaceId }) {

    console.log(
      `🔄 YouTrack sync running for workspace ${workspaceId}`
    );

    const projects =
      await youtrackAdapter.listProjects(workspaceId);

    for (const project of projects) {

      console.log("👁 Observing project:", project.name);

      let tasks;

      try {
        tasks = await youtrackAdapter.listTasks(
          workspaceId,
          project.key
        );
      } catch (err) {
        console.log(
          `⚠️ Skipping project (no task access): ${project.name}`
        );
        continue;
      }

      console.log(
        `✅ Issues observed from ${project.name}:`,
        tasks.length
      );

      /* =====================================================
         🔥 CHANGE-AWARE EVENT EMISSION (DEDUP SAFE)
      ===================================================== */
      for (const issue of tasks) {

        const state = {
          completed: issue.completed,
          updated: issue.updated
        };

        const newHash = hashIntegrationState(state);

        const previousHash =
          await getPreviousState(workspaceId, issue.id);

        // ✅ nothing changed → skip event emission
        if (previousHash === newHash) {
          continue;
        }

        // ✅ persist latest known state
        await saveState(workspaceId, issue.id, newHash);

        // ✅ emit only when real change detected
        await emitIntegrationEvent(
          "integration.activity.observed",
          {
            origin: "integration",
            provider: "youtrack",
            workspaceId,

            entityType: "task",
            externalId: issue.id,

            title: issue.name,
            projectName: project.name,

            action: issue.completed
              ? "task_completed"
              : "task_active",

            observedAt: new Date().toISOString(),
            modifiedAt: issue.updated,
            createdAt: issue.created,
          }
        );
      }
    }
  }

  async validate() {
    return true;
  }
}

registerProvider("youtrack", YouTrackProvider);

export default YouTrackProvider;