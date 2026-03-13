import pool from "../db.js";

/* ─────────────────────────────────────────────
   RECORD a new import run
   Returns the saved import row
───────────────────────────────────────────── */
export async function recordMigrationImport({
  workspaceId,
  source,          // 'slack' | 'asana' | 'youtrack'
  stats = {},      // { usersCreated, messagesImported, … }
  metadata = {},   // { channelKeys: [], createdUserIds: [], projectId: '' }
  triggeredBy,
  status = "completed",
}) {
  // Auto-increment import_number per workspace+source
  const numRes = await pool.query(
    `SELECT COALESCE(MAX(import_number), 0) + 1 AS next_num
     FROM migration_imports
     WHERE workspace_id = $1 AND source = $2`,
    [workspaceId, source]
  );
  const importNumber = numRes.rows[0].next_num;

  const res = await pool.query(
    `INSERT INTO migration_imports
       (workspace_id, source, import_number, status, stats, metadata, triggered_by, completed_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, now())
     RETURNING *`,
    [workspaceId, source, importNumber, status, JSON.stringify(stats), JSON.stringify(metadata), triggeredBy]
  );
  return res.rows[0];
}

/* ─────────────────────────────────────────────
   CREATE a "running" import record immediately
   so the frontend can poll for status
───────────────────────────────────────────── */
export async function createRunningMigrationImport({ workspaceId, source, triggeredBy }) {
  const numRes = await pool.query(
    `SELECT COALESCE(MAX(import_number), 0) + 1 AS next_num
     FROM migration_imports
     WHERE workspace_id = $1 AND source = $2`,
    [workspaceId, source]
  );
  const importNumber = numRes.rows[0].next_num;

  const res = await pool.query(
    `INSERT INTO migration_imports
       (workspace_id, source, import_number, status, stats, metadata, triggered_by)
     VALUES ($1, $2, $3, 'running', '{}'::jsonb, '{}'::jsonb, $4)
     RETURNING *`,
    [workspaceId, source, importNumber, triggeredBy]
  );
  return res.rows[0];
}

/* ─────────────────────────────────────────────
   FINALIZE a running import with results
───────────────────────────────────────────── */
export async function finalizeMigrationImport(importId, { stats = {}, metadata = {}, status = "completed" }) {
  const res = await pool.query(
    `UPDATE migration_imports
     SET status = $2, stats = $3::jsonb, metadata = $4::jsonb, completed_at = now()
     WHERE id = $1
     RETURNING *`,
    [importId, status, JSON.stringify(stats), JSON.stringify(metadata)]
  );
  return res.rows[0];
}

/* ─────────────────────────────────────────────
   LIST history for a workspace+source
───────────────────────────────────────────── */
export async function getMigrationHistory(workspaceId, source = null) {
  const params = [workspaceId];
  let sourceFilter = "";
  if (source) {
    sourceFilter = "AND source = $2";
    params.push(source);
  }

  const res = await pool.query(
    `SELECT * FROM migration_imports
     WHERE workspace_id = $1 ${sourceFilter}
     ORDER BY created_at DESC`,
    params
  );
  return res.rows;
}

/* ─────────────────────────────────────────────
   DELETE an import and all data it created
───────────────────────────────────────────── */
export async function deleteMigrationImport(importId, workspaceId) {
  const res = await pool.query(
    `SELECT * FROM migration_imports WHERE id = $1 AND workspace_id = $2`,
    [importId, workspaceId]
  );
  if (!res.rows.length) throw new Error("Import not found");

  const record = res.rows[0];
  const { source, metadata } = record;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (source === "slack") {
      const channelKeys = metadata.channelKeys || [];
      const createdUserIds = metadata.createdUserIds || [];

      if (channelKeys.length) {
        // Delete messages
        await client.query(
          `DELETE FROM chat_messages WHERE channel_key = ANY($1) AND workspace_id = $2`,
          [channelKeys, workspaceId]
        );
        // Delete channel members/admins
        const channelRes = await client.query(
          `SELECT id FROM chat_channels WHERE key = ANY($1) AND workspace_id = $2`,
          [channelKeys, workspaceId]
        );
        const channelIds = channelRes.rows.map((r) => r.id);
        if (channelIds.length) {
          await client.query(`DELETE FROM chat_channel_members WHERE channel_id = ANY($1)`, [channelIds]);
          await client.query(`DELETE FROM chat_channel_admins  WHERE channel_id = ANY($1)`, [channelIds]);
        }
        await client.query(
          `DELETE FROM chat_channels WHERE key = ANY($1) AND workspace_id = $2`,
          [channelKeys, workspaceId]
        );
      }

      // Delete users that were created by this import (not pre-existing)
      if (createdUserIds.length) {
        // Delete ALL messages sent by these users (they may exist in channels not created by this import)
        await client.query(
          `DELETE FROM chat_messages WHERE user_id = ANY($1) AND workspace_id = $2`,
          [createdUserIds, workspaceId]
        );
        await client.query(
          `DELETE FROM workspace_users WHERE user_id = ANY($1)`,
          [createdUserIds]
        );
        await client.query(
          `DELETE FROM users WHERE id = ANY($1)`,
          [createdUserIds]
        );
      }
    }

    if (source === "asana" || source === "youtrack") {
      const projectId = metadata.projectId;
      if (projectId) {
        // Delete tasks first (comments, attachments cascade from tasks)
        await client.query(
          `DELETE FROM tasks WHERE project_id = $1`,
          [projectId]
        );
        await client.query(
          `DELETE FROM projects WHERE id = $1 AND workspace_id = $2`,
          [projectId, workspaceId]
        );
      }
    }

    // Delete the history record itself
    await client.query(`DELETE FROM migration_imports WHERE id = $1`, [importId]);

    await client.query("COMMIT");
    return { deleted: true, source, importNumber: record.import_number };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
