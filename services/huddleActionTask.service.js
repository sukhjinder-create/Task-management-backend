import pool from "../db.js";
import { createTask } from "./task.service.js";
import {
  createHuddleArtifact,
  getHuddleArtifact,
} from "./huddleArtifact.service.js";
import { createHuddleSessionEvent } from "./huddleEvent.service.js";

function safeString(value, maxLength = 200000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function serviceError(reason, statusCode = 400) {
  const error = new Error(reason);
  error.reason = reason;
  error.statusCode = statusCode;
  return error;
}

function canCreateWorkspaceTask(role) {
  return ["admin", "owner", "manager"].includes(
    safeString(role, 40).toLowerCase()
  );
}

async function loadSession({ workspaceId, sessionId, actorUserId, role, client }) {
  const { rows } = await client.query(
    `
    SELECT id, started_by, host_user_id
    FROM huddle_sessions
    WHERE workspace_id = $1 AND id = $2
    LIMIT 1
    `,
    [workspaceId, sessionId]
  );
  const session = rows[0];
  if (!session) throw serviceError("huddle_session_not_found", 404);
  if (!canCreateWorkspaceTask(role)) {
    throw serviceError("huddle_task_creation_forbidden", 403);
  }
  return session;
}

function actionItemFromArtifact(artifact, actionItemId) {
  return (artifact?.contentJson?.actionItems || []).find(
    (item) => String(item?.id || "") === String(actionItemId || "")
  );
}

function taskSourceKey(sessionId, artifactId, actionItemId) {
  return `${sessionId}:${artifactId}:${actionItemId}`;
}

function taskDescription({ actionItem, sessionId, artifactId }) {
  const lines = [
    safeString(actionItem.description, 10000),
    "",
    "Created from an approved Huddle action item.",
    `Huddle session: ${sessionId}`,
    `Source artifact: ${artifactId}`,
    `Evidence segments: ${(actionItem.evidenceSegmentIds || []).join(", ") || "none recorded"}`,
  ];
  return lines.filter((line, index) => line || index === 1).join("\n");
}

export async function listHuddleActionTasks({
  workspaceId,
  sessionId,
  client = null,
}) {
  const runner = client || pool;
  const { rows } = await runner.query(
    `
    SELECT
      t.id,
      t.task,
      t.project_id,
      t.status,
      t.priority,
      t.assigned_to,
      t.due_date,
      t.ticket_number,
      t.source_key,
      t.source_metadata,
      t.created_at,
      p.name AS project_name,
      p.project_code,
      u.username AS assigned_to_name
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN users u ON u.id = t.assigned_to
    WHERE t.workspace_id = $1
      AND t.source_type = 'huddle_action_item'
      AND t.source_metadata->>'sessionId' = $2
    ORDER BY t.created_at ASC
    `,
    [workspaceId, sessionId]
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.task,
    projectId: row.project_id,
    projectName: row.project_name,
    displayId:
      row.project_code && row.ticket_number
        ? `${row.project_code}-${row.ticket_number}`
        : null,
    status: row.status,
    priority: row.priority,
    assignedTo: row.assigned_to,
    assignedToName: row.assigned_to_name,
    dueDate: row.due_date,
    sourceKey: row.source_key,
    source: row.source_metadata || {},
    createdAt: row.created_at,
  }));
}

export async function createTaskFromHuddleAction({
  workspaceId,
  sessionId,
  artifactId,
  actionItemId,
  projectId,
  actorUserId,
  role = "user",
}) {
  const lockClient = await pool.connect();
  const sourceKey = taskSourceKey(sessionId, artifactId, actionItemId);
  let committed = false;
  try {
    await lockClient.query("BEGIN");
    await loadSession({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      client: lockClient,
    });
    // Transaction-scoped advisory lock: held for the life of this transaction and
    // auto-released on COMMIT/ROLLBACK. A session-level pg_advisory_lock would be
    // unsafe here — under a transaction-mode pooler, each unwrapped statement can
    // land on a different underlying connection, so the lock, the check below, and
    // the eventual unlock could each hit a different session, providing no real
    // mutual exclusion and potentially leaking the lock on whatever connection
    // acquired it.
    await lockClient.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sourceKey]);

    const existing = await lockClient.query(
      `
      SELECT *
      FROM tasks
      WHERE workspace_id = $1
        AND source_type = 'huddle_action_item'
        AND source_key = $2
      LIMIT 1
      `,
      [workspaceId, sourceKey]
    );
    if (existing.rows[0]) {
      await lockClient.query("COMMIT");
      committed = true;
      return { task: existing.rows[0], created: false, idempotent: true };
    }

    const artifact = await getHuddleArtifact({
      workspaceId,
      artifactId,
      actorUserId,
      role,
    });
    if (
      artifact.sessionId !== sessionId ||
      artifact.artifactType !== "action_item"
    ) {
      throw serviceError("huddle_action_artifact_mismatch", 409);
    }
    if (artifact.status !== "ready" || artifact.approvalStatus !== "approved") {
      throw serviceError("huddle_action_artifact_approval_required", 409);
    }
    const actionItem = actionItemFromArtifact(artifact, actionItemId);
    if (!actionItem) throw serviceError("huddle_action_item_not_found", 404);

    const ownershipResult = await lockClient.query(
      `
      SELECT *
      FROM huddle_ownership_resolutions
      WHERE workspace_id = $1
        AND session_id = $2
        AND metadata->>'actionItemId' = $3
        AND status IN ('approved', 'reassigned')
      ORDER BY resolved_at DESC NULLS LAST, updated_at DESC
      LIMIT 1
      `,
      [workspaceId, sessionId, String(actionItemId)]
    );
    const ownership = ownershipResult.rows[0];
    if (!ownership?.resolved_owner_user_id) {
      throw serviceError("huddle_action_ownership_approval_required", 409);
    }

    const created = await createTask({
      task: safeString(actionItem.title, 500) || "Huddle action item",
      project_id: projectId,
      status: "pending",
      added_by: actorUserId,
      assigned_to: ownership.resolved_owner_user_id,
      due_date: actionItem.dueDate || null,
      description: taskDescription({ actionItem, sessionId, artifactId }),
      priority: safeString(actionItem.priority, 40) || "medium",
      workspaceId,
    });
    const sourceMetadata = {
      sessionId,
      artifactId,
      artifactRevision: artifact.currentRevision,
      actionItemId: String(actionItemId),
      ownershipResolutionId: ownership.id,
      evidenceSegmentIds: actionItem.evidenceSegmentIds || [],
      createdBy: actorUserId,
      createdAt: new Date().toISOString(),
    };
    const updated = await lockClient.query(
      `
      UPDATE tasks
      SET source_type = 'huddle_action_item',
          source_key = $3,
          source_metadata = $4::jsonb
      WHERE id = $1 AND workspace_id = $2
      RETURNING *
      `,
      [created.id, workspaceId, sourceKey, JSON.stringify(sourceMetadata)]
    );
    const task = updated.rows[0];

    const taskLink = await createHuddleArtifact({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      input: {
        artifactType: "task_link",
        status: "ready",
        approvalStatus: "not_required",
        visibility: "session_participants",
        contentText: `${task.task} (${task.id})`,
        contentJson: {
          taskId: task.id,
          actionItemId: String(actionItemId),
          projectId,
          assignedTo: task.assigned_to,
        },
        provenance: {
          source: "approved_huddle_action_item",
          sourceArtifactId: artifactId,
          sourceArtifactRevision: artifact.currentRevision,
          ownershipResolutionId: ownership.id,
        },
        metadata: { automaticCreation: false, humanApproved: true },
        sources: [
          {
            sourceKind: "artifact",
            sourceArtifactId: artifactId,
            sourceRef: `huddle_artifact:${artifactId}`,
            metadata: { relationship: "task_source" },
          },
          ...(actionItem.evidenceSegmentIds || []).map((segmentId) => ({
            sourceKind: "transcript_segment",
            transcriptSegmentId: segmentId,
            sourceRef: `transcript_segment:${segmentId}`,
            metadata: { relationship: "task_evidence" },
          })),
        ],
      },
    });

    await createHuddleSessionEvent({
      workspaceId,
      sessionId,
      actorUserId,
      eventType: "huddle.intelligence.task_created",
      eventPayload: {
        taskId: task.id,
        projectId,
        actionItemId: String(actionItemId),
        sourceArtifactId: artifactId,
        taskLinkArtifactId: taskLink.artifact.id,
      },
    });
    await lockClient.query("COMMIT");
    committed = true;
    return {
      task,
      taskLinkArtifact: taskLink.artifact,
      created: true,
      idempotent: false,
    };
  } finally {
    try {
      if (!committed) await lockClient.query("ROLLBACK");
    } finally {
      lockClient.release();
    }
  }
}

export default {
  createTaskFromHuddleAction,
  listHuddleActionTasks,
};
