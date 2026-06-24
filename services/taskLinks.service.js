import pool from "../db.js";
import { queueTaskImpact } from "../intelligence/realtime/recalculation.service.js";

const INVERSE = {
  blocks: "is_blocked_by",
  is_blocked_by: "blocks",
  relates_to: "relates_to",
  duplicates: "duplicate_of",
  duplicate_of: "duplicates",
  parent_of: "child_of",
  child_of: "parent_of",
};

export async function getTaskLinks({ taskId }) {
  const { rows } = await pool.query(
    `SELECT
       tl.id, tl.link_type, tl.created_at,
       tl.source_task_id, tl.target_task_id,
       t.id   AS linked_task_id,
       t.task AS linked_task_title,
       CASE WHEN p.project_code IS NOT NULL AND t.ticket_number IS NOT NULL
            THEN p.project_code || '-' || t.ticket_number END AS linked_display_id,
       t.status AS linked_status,
       t.priority AS linked_priority
     FROM task_links tl
     JOIN tasks t ON t.id = CASE
       WHEN tl.source_task_id = $1 THEN tl.target_task_id
       ELSE tl.source_task_id
     END
     LEFT JOIN projects p ON p.id = t.project_id
     WHERE tl.source_task_id = $1 OR tl.target_task_id = $1
     ORDER BY tl.created_at DESC`,
    [taskId]
  );

  // Normalize: always show link_type from the perspective of taskId
  return rows.map((r) => ({
    ...r,
    link_type:
      r.source_task_id === taskId
        ? r.link_type
        : (INVERSE[r.link_type] || r.link_type),
  }));
}

export async function addTaskLink({ sourceTaskId, targetTaskId, linkType, workspaceId, createdBy }) {
  if (sourceTaskId === targetTaskId) throw new Error("Cannot link a task to itself");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Insert primary link
    await client.query(
      `INSERT INTO task_links (source_task_id, target_task_id, link_type, workspace_id, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source_task_id, target_task_id, link_type) DO NOTHING`,
      [sourceTaskId, targetTaskId, linkType, workspaceId, createdBy]
    );

    // Insert inverse link for bidirectional types
    const inverse = INVERSE[linkType];
    if (inverse && inverse !== linkType) {
      await client.query(
        `INSERT INTO task_links (source_task_id, target_task_id, link_type, workspace_id, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (source_task_id, target_task_id, link_type) DO NOTHING`,
        [targetTaskId, sourceTaskId, inverse, workspaceId, createdBy]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const metadata = {
    sourceTaskId,
    targetTaskId,
    linkType,
    createdBy,
  };
  queueTaskImpact({
    workspaceId,
    taskId: sourceTaskId,
    reason: linkType === "blocks" || linkType === "is_blocked_by" ? "blocker_added" : "task_dependency_added",
    userIds: [createdBy],
    metadata,
  }).catch(() => {});
  queueTaskImpact({
    workspaceId,
    taskId: targetTaskId,
    reason: linkType === "blocks" || linkType === "is_blocked_by" ? "blocker_added" : "task_dependency_added",
    userIds: [createdBy],
    metadata,
  }).catch(() => {});

  return getTaskLinks({ taskId: sourceTaskId });
}

export async function removeTaskLink({ linkId, workspaceId }) {
  // Remove link and its inverse
  const { rows } = await pool.query(
    `SELECT source_task_id, target_task_id, link_type FROM task_links WHERE id = $1 AND workspace_id = $2`,
    [linkId, workspaceId]
  );
  if (!rows[0]) throw new Error("Link not found");
  const { source_task_id, target_task_id, link_type } = rows[0];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM task_links WHERE id = $1`, [linkId]);
    const inverse = INVERSE[link_type];
    if (inverse && inverse !== link_type) {
      await client.query(
        `DELETE FROM task_links WHERE source_task_id = $1 AND target_task_id = $2 AND link_type = $3`,
        [target_task_id, source_task_id, inverse]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const metadata = {
    sourceTaskId: source_task_id,
    targetTaskId: target_task_id,
    linkType: link_type,
  };
  queueTaskImpact({
    workspaceId,
    taskId: source_task_id,
    reason: link_type === "blocks" || link_type === "is_blocked_by" ? "blocker_resolved" : "task_dependency_removed",
    metadata,
  }).catch(() => {});
  queueTaskImpact({
    workspaceId,
    taskId: target_task_id,
    reason: link_type === "blocks" || link_type === "is_blocked_by" ? "blocker_resolved" : "task_dependency_removed",
    metadata,
  }).catch(() => {});
}

export async function searchTasksForLinking({ workspaceId, query, excludeTaskId }) {
  const { rows } = await pool.query(
    `SELECT
       t.id, t.task, t.status, t.priority,
       CASE WHEN p.project_code IS NOT NULL AND t.ticket_number IS NOT NULL
            THEN p.project_code || '-' || t.ticket_number END AS display_id
     FROM tasks t
     LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.workspace_id = $1
       AND t.id != $2
       AND (t.task ILIKE $3 OR (p.project_code || '-' || t.ticket_number) ILIKE $3)
     ORDER BY t.created_at DESC
     LIMIT 20`,
    [workspaceId, excludeTaskId, `%${query}%`]
  );
  return rows;
}
