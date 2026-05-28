import pool from "../../db.js";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import taskRepository from "../../repositories/task.repository.js";
import youtrackAdapter from "./youtrack.adapter.js";
import { emitWorkspaceEvent } from "../../events/emitWorkspaceEvent.js";
import { EVENT_TYPES } from "../../events/eventTypes.js";
import { getSystemActorId } from "../../events/systemActor.service.js";
import { recordMigrationImport } from "../../services/migrationHistory.service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

async function migrateYouTrackAttachments(baseUrl, token, ytIssueId, internalTaskId, workspaceId, uploadedBy) {
  try {
    const res = await axios.get(
      `${baseUrl}/api/issues/${ytIssueId}/attachments`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { fields: "id,name,url,size,mimeType" },
      }
    );

    const attachments = Array.isArray(res.data) ? res.data : [];

    for (const att of attachments) {
      if (!att.url) continue;
      try {
        const downloadUrl = att.url.startsWith("http") ? att.url : `${baseUrl}${att.url}`;
        const ext = path.extname(att.name) || "";
        const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        const filePath = path.join(UPLOAD_DIR, filename);

        const fileRes = await axios.get(downloadUrl, {
          headers: { Authorization: `Bearer ${token}` },
          responseType: "arraybuffer",
          timeout: 30000,
        });
        fs.writeFileSync(filePath, Buffer.from(fileRes.data));

        await pool.query(
          `INSERT INTO task_attachments (task_id, url, original_name, mime_type, file_size, uploaded_by, workspace_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [internalTaskId, `/uploads/${filename}`, att.name, att.mimeType || null, att.size || null, uploadedBy, workspaceId]
        );
      } catch (e) {
        console.warn(`YouTrack attachment download failed (${att.name}):`, e.message);
      }
    }
  } catch (e) {
    console.warn(`YouTrack attachments fetch failed for issue ${ytIssueId}:`, e.message);
  }
}

async function mapYouTrackAssignee(workspaceId, assigneeText) {
  const value = String(assigneeText || "").trim();
  if (!value || value === "-") return null;

  const res = await pool.query(
    `
    SELECT id
    FROM users
    WHERE workspace_id = $1
      AND (
        LOWER(username) = LOWER($2)
        OR LOWER(email) = LOWER($2)
        OR LOWER(split_part(email, '@', 1)) = LOWER($2)
      )
    LIMIT 1
    `,
    [workspaceId, value]
  );

  return res.rows[0]?.id || null;
}

async function resolveYouTrackProject(workspaceId, projectId) {
  const projects = await youtrackAdapter.listProjects(workspaceId);
  const match = projects.find(
    (p) => p.id === projectId || p.key === projectId || p.name === projectId
  );

  if (match) {
    return {
      key: match.key,
      label: match.name || match.key || projectId,
    };
  }

  return { key: projectId, label: projectId };
}

function normalizeDate(value) {
  if (!value) return null;
  if (typeof value === "number") {
    const dt = new Date(value);
    if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  }
  if (typeof value === "string") {
    const dt = new Date(value);
    if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  }
  return null;
}

export async function migrateYouTrackProject({
  workspaceId,
  projectId,
  triggeredBy,
  mode = "skip", // "skip" | "replace"
}) {
  /* ---------- REPLACE: delete previously imported project ---------- */
  if (mode === "replace") {
    const prev = await pool.query(
      `SELECT metadata FROM migration_imports
       WHERE workspace_id=$1 AND source='youtrack'
         AND (metadata->>'youtrackProjectId')=$2
       ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, projectId]
    );
    if (prev.rows.length) {
      const prevProjectId = prev.rows[0].metadata?.projectId;
      if (prevProjectId) {
        await pool.query(`DELETE FROM tasks WHERE project_id=$1`, [prevProjectId]);
        await pool.query(`DELETE FROM projects WHERE id=$1 AND workspace_id=$2`, [prevProjectId, workspaceId]);
        await pool.query(
          `DELETE FROM migration_imports WHERE workspace_id=$1 AND source='youtrack' AND (metadata->>'youtrackProjectId')=$2`,
          [workspaceId, projectId]
        );
      }
    }
  }
  // Fetch config once for attachment downloads
  const configRow = await pool.query(
    `SELECT config FROM workspace_integrations WHERE workspace_id=$1 AND provider='youtrack' LIMIT 1`,
    [workspaceId]
  );
  const ytConfig = configRow.rows[0]?.config || {};
  const ytBaseUrl = ytConfig.base_url || "";
  const ytToken = ytConfig.token || "";

  const { key: projectKey, label } = await resolveYouTrackProject(
    workspaceId,
    projectId
  );

  const result = await youtrackAdapter.listTasks(workspaceId, projectKey);
  const sourceTasks = Array.isArray(result)
    ? result
    : Array.isArray(result?.data)
      ? result.data
      : [];

  if (!sourceTasks.length) {
    throw new Error("No tasks found in YouTrack project");
  }

  const { rows: projectRows } = await pool.query(
    `
    INSERT INTO projects (name, workspace_id, added_by)
    VALUES ($1, $2, $3)
    RETURNING id
    `,
    [`[Imported] ${label}`, workspaceId, triggeredBy]
  );

  const newProjectId = projectRows[0].id;
  const systemActorId = await getSystemActorId(workspaceId);

  let importedCount = 0;

  for (const task of sourceTasks) {
    const externalTaskId = String(task.externalId || task.id || "").trim();
    if (!externalTaskId) continue;

    if (mode === "skip") {
      const existing = await pool.query(
        `SELECT 1 FROM integration_task_mappings
         WHERE workspace_id=$1 AND provider='youtrack' AND external_task_id=$2 LIMIT 1`,
        [workspaceId, externalTaskId]
      );
      if (existing.rows.length) continue;
    }

    const assignedUserId = await mapYouTrackAssignee(workspaceId, task.assignee);

    const createdTask = await taskRepository.createTask({
      task: task.title || task.name || "Untitled Task",
      project_id: newProjectId,
      status: task.completed ? "completed" : "pending",
      priority: "medium",
      added_by: systemActorId,
      assigned_to: assignedUserId,
      due_date: normalizeDate(task.dueDate),
      description: String(task.description || "").trim() || null,
      workspaceId,
    });

    await pool.query(
      `
      INSERT INTO integration_task_mappings
      (workspace_id, provider, external_task_id, internal_task_id)
      VALUES ($1, 'youtrack', $2, $3)
      ON CONFLICT DO NOTHING
      `,
      [workspaceId, externalTaskId, createdTask.id]
    );

    /* ---- attachments ---- */
    if (ytBaseUrl && ytToken) {
      await migrateYouTrackAttachments(ytBaseUrl, ytToken, externalTaskId, createdTask.id, workspaceId, systemActorId);
    }

    await emitWorkspaceEvent({
      workspaceId,
      actorUserId: systemActorId,
      eventType: EVENT_TYPES.TASK_CREATED,
      entityType: "task",
      entityId: createdTask.id,
      metadata: {
        origin: "migration",
        provider: "youtrack",
        external_entity_id: externalTaskId,
      },
    });

    importedCount++;
  }

  const importRecord = await recordMigrationImport({
    workspaceId,
    source: "youtrack",
    stats: { importedTasks: importedCount },
    metadata: { projectId: newProjectId, youtrackProjectId: projectId },
    triggeredBy,
  });

  return {
    success: true,
    importedTasks: importedCount,
    projectId: newProjectId,
    importId: importRecord.id,
    importNumber: importRecord.import_number,
  };
}
