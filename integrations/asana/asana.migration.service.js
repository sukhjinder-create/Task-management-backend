import pool from "../../db.js";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import taskRepository from "../../repositories/task.repository.js";
import { fetchAsanaProjectTasks } from "./asana.viewer.service.js";
import { emitWorkspaceEvent } from "../../events/emitWorkspaceEvent.js";
import { EVENT_TYPES } from "../../events/eventTypes.js";
import { getSystemActorId } from "../../events/systemActor.service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

async function migrateAsanaAttachments(token, asanaTaskGid, internalTaskId, workspaceId, uploadedBy) {
  try {
    const res = await axios.get("https://app.asana.com/api/1.0/attachments", {
      headers: { Authorization: `Bearer ${token}` },
      params: { parent: asanaTaskGid, opt_fields: "gid,name,download_url,size,mime_type" },
    });

    const attachments = res.data?.data || [];

    for (const att of attachments) {
      if (!att.download_url) continue;
      try {
        const ext = path.extname(att.name) || "";
        const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        const filePath = path.join(UPLOAD_DIR, filename);

        const fileRes = await axios.get(att.download_url, { responseType: "arraybuffer", timeout: 30000 });
        fs.writeFileSync(filePath, Buffer.from(fileRes.data));

        await pool.query(
          `INSERT INTO task_attachments (task_id, url, original_name, mime_type, file_size, uploaded_by, workspace_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [internalTaskId, `/uploads/${filename}`, att.name, att.mime_type || null, att.size || null, uploadedBy, workspaceId]
        );
      } catch (e) {
        console.warn(`Asana attachment download failed (${att.name}):`, e.message);
      }
    }
  } catch (e) {
    console.warn(`Asana attachments fetch failed for task ${asanaTaskGid}:`, e.message);
  }
}

/* =====================================================
   ASSIGNEE MAPPING
===================================================== */
async function mapAsanaAssignee(workspaceId, asanaUser) {
  if (!asanaUser?.email) return null;

  const result = await pool.query(
    `
    SELECT id
    FROM users
    WHERE workspace_id = $1
      AND LOWER(email) = LOWER($2)
    LIMIT 1
    `,
    [workspaceId, asanaUser.email]
  );

  return result.rows[0]?.id || null;
}

/* =====================================================
   FULL TASK FETCH (HYDRATION)
===================================================== */
async function fetchFullAsanaTask(token, taskId) {
  const res = await axios.get(
    `https://app.asana.com/api/1.0/tasks/${taskId}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        opt_fields:
          "gid,name,notes,completed,due_on,assignee,assignee.email,subtasks"
      },
    }
  );

  return res.data.data;
}

/* =====================================================
   ONE CLICK MIGRATION
===================================================== */
export async function migrateAsanaProject({
  workspaceId,
  projectId,
  triggeredBy,
}) {

  console.log("🚀 Starting Asana migration:", projectId);

  /* ---------- GET TOKEN ---------- */
  const tokenRow = await pool.query(
    `SELECT config FROM workspace_integrations
     WHERE workspace_id=$1 AND provider='asana'
     LIMIT 1`,
    [workspaceId]
  );

  const token = tokenRow.rows[0].config.access_token;

  /* ---------- FETCH LIGHT TASK LIST ---------- */
  const result = await fetchAsanaProjectTasks(
    workspaceId,
    projectId,
    { page: 1, limit: 100000, search: "" }
  );

  const liteTasks = result.data || [];

  if (!liteTasks.length) {
    throw new Error("No tasks found in Asana project");
  }

  /* ---------- CREATE PROJECT ONCE ---------- */
  const projectInsert = await pool.query(
    `
    INSERT INTO projects (name, workspace_id, added_by)
    VALUES ($1,$2,$3)
    RETURNING id
    `,
    [`[Imported] ${projectId}`, workspaceId, triggeredBy]
  );

  const newProjectId = projectInsert.rows[0].id;
  const systemActorId = await getSystemActorId(workspaceId);

  let importedCount = 0;

  /* =====================================================
     IMPORT TASKS
  ===================================================== */
  for (const liteTask of liteTasks) {

    const asanaTask = await fetchFullAsanaTask(
      token,
      liteTask.gid
    );

    /* ---- skip already migrated ---- */
    const existing = await pool.query(
      `
      SELECT 1 FROM integration_task_mappings
      WHERE workspace_id=$1
      AND provider='asana'
      AND external_task_id=$2
      `,
      [workspaceId, asanaTask.gid]
    );

    if (existing.rows.length) continue;

    const assignedUserId =
      await mapAsanaAssignee(workspaceId, asanaTask.assignee);

    const createdTask = await taskRepository.createTask({
      task: asanaTask.name || "Untitled Task",
      project_id: newProjectId,
      status: asanaTask.completed ? "completed" : "pending",
      priority: "medium",
      added_by: systemActorId,
      assigned_to: assignedUserId,
      due_date: asanaTask.due_on || null,
      description:
        asanaTask.notes?.trim()?.length
          ? asanaTask.notes.trim()
          : null,
      workspaceId,
    });

    /* ---- mapping ---- */
    await pool.query(
      `
      INSERT INTO integration_task_mappings
      (workspace_id, provider, external_task_id, internal_task_id)
      VALUES ($1,'asana',$2,$3)
      ON CONFLICT DO NOTHING
      `,
      [workspaceId, asanaTask.gid, createdTask.id]
    );

    /* ---- attachments ---- */
    await migrateAsanaAttachments(token, asanaTask.gid, createdTask.id, workspaceId, systemActorId);

    /* =====================================================
   SUBTASK IMPORT (CORRECT HIERARCHY)
===================================================== */
if (asanaTask.subtasks?.length) {

  for (const sub of asanaTask.subtasks) {

    try {
      const subFull = await fetchFullAsanaTask(
        token,
        sub.gid
      );

      const assignedSubUser =
        await mapAsanaAssignee(workspaceId, subFull.assignee);

      await pool.query(
        `
        INSERT INTO subtasks (
          task_id,
          title,
          status,
          priority,
          added_by,
          assigned_to,
          due_date,
          subtask
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
        [
          createdTask.id, // ⭐ parent link
          subFull.name || "Untitled Subtask",
          subFull.completed ? "completed" : "pending",
          "medium",
          systemActorId,
          assignedSubUser,
          subFull.due_on || null,
          subFull.notes || null
        ]
      );

    } catch (err) {
      console.warn("Subtask import failed:", sub.gid);
    }
  }
}

    /* ---- emit intelligence event ---- */
    await emitWorkspaceEvent({
      workspaceId,
      actorUserId: systemActorId,
      eventType: EVENT_TYPES.TASK_CREATED,
      entityType: "task",
      entityId: createdTask.id,
      metadata: {
        origin: "migration",
        provider: "asana",
        external_entity_id: asanaTask.gid,
      },
    });

    importedCount++;
  }

  console.log("✅ Migration completed");

  return {
    success: true,
    importedTasks: importedCount,
    projectId: newProjectId,
  };
}