import pool from "../db.js";
import {
  createHuddleArtifact,
  getHuddleArtifact,
} from "./huddleArtifact.service.js";
import {
  createMemoryCandidate,
} from "./huddleIntelligence.service.js";
import { createHuddleSessionEvent } from "./huddleEvent.service.js";

function safeString(value, maxLength = 200000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function isReviewer(role, session, actorUserId) {
  const normalizedRole = safeString(role, 40).toLowerCase();
  return (
    ["admin", "owner", "manager"].includes(normalizedRole) ||
    String(session?.started_by || "") === String(actorUserId || "") ||
    String(session?.host_user_id || "") === String(actorUserId || "")
  );
}

function serviceError(reason, statusCode = 400) {
  const error = new Error(reason);
  error.reason = reason;
  error.statusCode = statusCode;
  return error;
}

async function withTransaction(client, callback) {
  if (client) return callback(client);
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const result = await callback(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}

async function assertReviewer({
  workspaceId,
  sessionId,
  actorUserId,
  role,
  client,
}) {
  const { rows } = await client.query(
    `
    SELECT
      s.id,
      s.started_by,
      s.host_user_id,
      s.started_at,
      COALESCE(
        s.metadata->>'title',
        s.metadata->>'meetingTitle',
        c.name,
        CASE WHEN u.username IS NOT NULL THEN u.username || '''s Huddle' END,
        'Huddle'
      ) AS meeting_title,
      COALESCE((
        SELECT jsonb_agg(DISTINCT participant_name)
        FROM (
          SELECT COALESCE(
            pu.username,
            g.display_name,
            p.metadata->>'displayName'
          ) AS participant_name
          FROM huddle_session_participants p
          LEFT JOIN users pu ON pu.id = p.user_id
          LEFT JOIN huddle_guests g ON g.id = p.guest_id
          WHERE p.workspace_id = s.workspace_id
            AND p.session_id = s.id
        ) participants
        WHERE participant_name IS NOT NULL
      ), '[]'::jsonb) AS participant_names
    FROM huddle_sessions s
    LEFT JOIN users u ON u.id = s.host_user_id
    LEFT JOIN chat_channels c ON c.id = s.channel_id
    WHERE s.workspace_id = $1
      AND s.id = $2
    LIMIT 1
    `,
    [workspaceId, sessionId]
  );
  const session = rows[0];
  if (!session) throw serviceError("huddle_session_not_found", 404);
  if (!isReviewer(role, session, actorUserId)) {
    throw serviceError("memory_review_forbidden", 403);
  }
  return session;
}

function artifactMemoryTitle(artifact, session) {
  const meetingTitle = safeString(session?.meeting_title, 220) || "Huddle";
  const typeLabel = {
    summary: "Summary",
    decision: "Decisions",
    action_item: "Action items",
    timeline: "Timeline",
    transcript: "Transcript",
  }[artifact.artifactType] || safeString(artifact.artifactType, 80).replaceAll("_", " ");
  return `${meetingTitle}: ${typeLabel}`;
}

function memoryTags(candidate) {
  const metadata = candidate?.metadata || {};
  const participantNames = Array.isArray(metadata.participantNames)
    ? metadata.participantNames
    : [];
  return [...new Set([
    "huddle",
    "meeting-intelligence",
    safeString(metadata.sourceArtifactType, 80),
    ...participantNames.map((name) =>
      safeString(name, 80).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-")
    ),
  ].filter(Boolean))].slice(0, 20);
}

function collectTranscriptEvidence(value, evidence = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectTranscriptEvidence(item, evidence));
    return evidence;
  }
  if (!value || typeof value !== "object") return evidence;
  for (const [key, nested] of Object.entries(value)) {
    if (
      ["evidenceSegmentIds", "evidence_segment_ids"].includes(key) &&
      Array.isArray(nested)
    ) {
      nested.forEach((id) => {
        if (typeof id === "string" && id.trim()) evidence.add(id.trim());
      });
    } else {
      collectTranscriptEvidence(nested, evidence);
    }
  }
  return evidence;
}

function serializeCandidate(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    artifactId: row.artifact_id,
    sourceArtifactId: row.source_artifact_id,
    title: row.title,
    candidateText: row.candidate_text,
    memoryVisibility: row.memory_visibility,
    status: row.status,
    confidence:
      row.confidence === null || row.confidence === undefined
        ? null
        : Number(row.confidence),
    approvalRequired: Boolean(row.approval_required),
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    rejectedBy: row.rejected_by,
    rejectedAt: row.rejected_at,
    promotedMemoryId: row.promoted_memory_id,
    promotedAt: row.promoted_at,
    provenance: row.provenance_json || {},
    metadata: row.metadata || {},
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createMemoryCandidateFromArtifact({
  workspaceId,
  sessionId,
  artifactId,
  actorUserId,
  role = "user",
  client = null,
}) {
  return withTransaction(client, async (tx) => {
    const session = await assertReviewer({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      client: tx,
    });
    const artifact = await getHuddleArtifact({
      workspaceId,
      artifactId,
      actorUserId,
      role,
      client: tx,
    });
    if (artifact.sessionId !== sessionId) {
      throw serviceError("memory_artifact_session_mismatch", 409);
    }
    if (artifact.approvalStatus !== "approved") {
      throw serviceError("memory_source_artifact_approval_required", 409);
    }
    if (!safeString(artifact.contentText)) {
      throw serviceError("memory_source_artifact_content_required", 422);
    }
    const sourceTranscriptReferences = [
      ...collectTranscriptEvidence(artifact.contentJson),
    ];

    const existing = await tx.query(
      `
      SELECT *
      FROM huddle_memory_candidates
      WHERE workspace_id = $1
        AND session_id = $2
        AND source_artifact_id = $3
        AND status <> 'cancelled'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [workspaceId, sessionId, artifactId]
    );
    if (existing.rows[0]) {
      return {
        memoryCandidate: serializeCandidate(existing.rows[0]),
        created: false,
        idempotent: true,
      };
    }

    const result = await createMemoryCandidate({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      input: {
        sourceArtifactId: artifact.id,
        title: artifactMemoryTitle(artifact, session),
        candidateText: artifact.contentText,
        memoryVisibility: "workspace",
        status: "pending_approval",
        confidence: artifact.contentJson?.confidence ?? null,
        approvalRequired: true,
        provenance: {
          source: "approved_huddle_artifact",
          sourceArtifactId: artifact.id,
          sourceArtifactType: artifact.artifactType,
          sourceArtifactRevision: artifact.currentRevision,
          sourceTranscriptReferences,
          meetingSessionId: sessionId,
          meetingTitle: session.meeting_title,
          meetingStartedAt: session.started_at,
          participantNames: session.participant_names || [],
        },
        metadata: {
          promotionAutomatic: false,
          sourceApprovalStatus: artifact.approvalStatus,
          sourceArtifactType: artifact.artifactType,
          meetingTitle: session.meeting_title,
          meetingStartedAt: session.started_at,
          participantNames: session.participant_names || [],
        },
      },
      client: tx,
    });
    return {
      memoryCandidate: result.memoryCandidate,
      created: true,
      idempotent: false,
    };
  });
}

export async function promoteApprovedMemoryCandidate({
  workspaceId,
  sessionId,
  memoryCandidateId,
  actorUserId,
  role = "user",
  client = null,
}) {
  return withTransaction(client, async (tx) => {
    await assertReviewer({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      client: tx,
    });
    const candidateResult = await tx.query(
      `
      SELECT *
      FROM huddle_memory_candidates
      WHERE id = $1
        AND workspace_id = $2
        AND session_id = $3
      LIMIT 1
      FOR UPDATE
      `,
      [memoryCandidateId, workspaceId, sessionId]
    );
    const candidate = candidateResult.rows[0];
    if (!candidate) throw serviceError("memory_candidate_not_found", 404);
    if (candidate.status === "promoted" && candidate.promoted_memory_id) {
      const existing = await tx.query(
        `SELECT * FROM workspace_memory_entries WHERE id = $1 LIMIT 1`,
        [candidate.promoted_memory_id]
      );
      return {
        memoryCandidate: serializeCandidate(candidate),
        memoryEntry: existing.rows[0] || null,
        promoted: false,
        idempotent: true,
      };
    }
    if (candidate.status !== "approved") {
      throw serviceError("memory_candidate_approval_required", 409);
    }

    const memoryArtifact = await createHuddleArtifact({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      input: {
        artifactType: "memory",
        status: "ready",
        approvalStatus: "not_required",
        visibility:
          candidate.memory_visibility === "private"
            ? "private"
            : "session_participants",
        contentText: candidate.candidate_text,
        contentJson: {
          title: candidate.title,
          memoryCandidateId: candidate.id,
          sourceArtifactId: candidate.source_artifact_id,
        },
        provenance: {
          ...(candidate.provenance_json || {}),
          source: "approved_memory_candidate",
          memoryCandidateId: candidate.id,
          approvedBy: candidate.approved_by,
          approvedAt: candidate.approved_at,
        },
        metadata: {
          promotionAutomatic: false,
          workspaceMemoryVisibility: candidate.memory_visibility,
        },
        sources: candidate.source_artifact_id
          ? [{
              sourceKind: "artifact",
              sourceArtifactId: candidate.source_artifact_id,
              sourceRef: `huddle_artifact:${candidate.source_artifact_id}`,
              metadata: { relationship: "memory_source" },
            }]
          : [],
      },
      client: tx,
    });

    const entryResult = await tx.query(
      `
      INSERT INTO workspace_memory_entries (
        workspace_id,
        title,
        content,
        tags,
        visibility,
        created_by,
        source_entity_type,
        source_entity_id,
        metadata
      )
      VALUES ($1,$2,$3,$4::jsonb,$5,$6,'huddle_artifact',$7,$8::jsonb)
      RETURNING *
      `,
      [
        workspaceId,
        candidate.title || "Huddle memory",
        candidate.candidate_text,
        JSON.stringify(memoryTags(candidate)),
        candidate.memory_visibility === "private" ? "private" : "workspace",
        actorUserId,
        memoryArtifact.artifact.id,
        JSON.stringify({
          sourceSessionId: sessionId,
          sourceArtifactId: candidate.source_artifact_id,
          memoryArtifactId: memoryArtifact.artifact.id,
          memoryCandidateId: candidate.id,
          meetingTitle:
            candidate.metadata?.meetingTitle ||
            candidate.provenance_json?.meetingTitle ||
            null,
          meetingStartedAt:
            candidate.metadata?.meetingStartedAt ||
            candidate.provenance_json?.meetingStartedAt ||
            null,
          participantNames:
            candidate.metadata?.participantNames ||
            candidate.provenance_json?.participantNames ||
            [],
          approvedBy: candidate.approved_by,
          approvedAt: candidate.approved_at,
          provenance: candidate.provenance_json || {},
        }),
      ]
    );
    const memoryEntry = entryResult.rows[0];
    const updatedResult = await tx.query(
      `
      UPDATE huddle_memory_candidates
      SET
        artifact_id = $4,
        status = 'promoted',
        promoted_memory_id = $5,
        promoted_at = now(),
        metadata = metadata || $6::jsonb,
        updated_at = now()
      WHERE id = $1
        AND workspace_id = $2
        AND session_id = $3
      RETURNING *
      `,
      [
        memoryCandidateId,
        workspaceId,
        sessionId,
        memoryArtifact.artifact.id,
        memoryEntry.id,
        JSON.stringify({
          promotedBy: actorUserId,
          promotionAutomatic: false,
        }),
      ]
    );
    await createHuddleSessionEvent({
      workspaceId,
      sessionId,
      actorUserId,
      eventType: "huddle.intelligence.memory_promoted",
      eventPayload: {
        memoryCandidateId,
        memoryArtifactId: memoryArtifact.artifact.id,
        workspaceMemoryId: memoryEntry.id,
        sourceArtifactId: candidate.source_artifact_id,
      },
      client: tx,
    });
    return {
      memoryCandidate: serializeCandidate(updatedResult.rows[0]),
      memoryArtifact: memoryArtifact.artifact,
      memoryEntry,
      promoted: true,
      idempotent: false,
    };
  });
}

export async function listMemoryCandidateHistory({
  workspaceId,
  sessionId,
  memoryCandidateId,
  actorUserId,
  role = "user",
  client = null,
}) {
  const db = client || pool;
  await assertReviewer({
    workspaceId,
    sessionId,
    actorUserId,
    role,
    client: db,
  });
  const { rows } = await db.query(
    `
    SELECT
      r.*,
      u.username AS changed_by_name
    FROM huddle_memory_candidate_revisions r
    LEFT JOIN users u ON u.id = r.changed_by
    WHERE r.workspace_id = $1
      AND r.session_id = $2
      AND r.memory_candidate_id = $3
    ORDER BY r.revision_number DESC
    `,
    [workspaceId, sessionId, memoryCandidateId]
  );
  return rows.map((row) => ({
    id: row.id,
    revisionNumber: row.revision_number,
    status: row.status,
    title: row.title,
    candidateText: row.candidate_text,
    changedBy: row.changed_by,
    changedByName: row.changed_by_name,
    changeReason: row.change_reason,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  }));
}

export async function revokePromotedMemoryCandidate({
  workspaceId,
  sessionId,
  memoryCandidateId,
  actorUserId,
  role = "user",
  reason = null,
  client = null,
}) {
  return withTransaction(client, async (tx) => {
    await assertReviewer({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      client: tx,
    });
    const result = await tx.query(
      `
      SELECT *
      FROM huddle_memory_candidates
      WHERE id = $1
        AND workspace_id = $2
        AND session_id = $3
      LIMIT 1
      FOR UPDATE
      `,
      [memoryCandidateId, workspaceId, sessionId]
    );
    const candidate = result.rows[0];
    if (!candidate) throw serviceError("memory_candidate_not_found", 404);
    if (candidate.status === "cancelled") {
      return {
        memoryCandidate: serializeCandidate(candidate),
        revoked: false,
        idempotent: true,
      };
    }
    if (candidate.status !== "promoted" || !candidate.promoted_memory_id) {
      throw serviceError("memory_candidate_not_promoted", 409);
    }
    const revisionResult = await tx.query(
      `
      SELECT COALESCE(MAX(revision_number), 0) + 1 AS next_revision
      FROM huddle_memory_candidate_revisions
      WHERE memory_candidate_id = $1
      `,
      [memoryCandidateId]
    );
    await tx.query(
      `
      INSERT INTO huddle_memory_candidate_revisions (
        workspace_id,
        session_id,
        memory_candidate_id,
        revision_number,
        status,
        title,
        candidate_text,
        changed_by,
        change_reason,
        metadata
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'promotion_revoked',$9::jsonb)
      `,
      [
        workspaceId,
        sessionId,
        memoryCandidateId,
        Number(revisionResult.rows[0]?.next_revision || 1),
        candidate.status,
        candidate.title,
        candidate.candidate_text,
        actorUserId,
        JSON.stringify({ reason: safeString(reason, 1000) || null }),
      ]
    );
    await tx.query(
      `
      UPDATE workspace_memory_entries
      SET
        is_archived = TRUE,
        metadata = metadata || $3::jsonb,
        updated_at = now()
      WHERE id = $1 AND workspace_id = $2
      `,
      [
        candidate.promoted_memory_id,
        workspaceId,
        JSON.stringify({
          revokedAt: new Date().toISOString(),
          revokedBy: actorUserId,
          revokeReason: safeString(reason, 1000) || null,
        }),
      ]
    );
    if (candidate.artifact_id) {
      await tx.query(
        `
        UPDATE huddle_artifacts
        SET
          status = 'archived',
          metadata = metadata || $3::jsonb,
          updated_at = now()
        WHERE id = $1 AND workspace_id = $2
        `,
        [
          candidate.artifact_id,
          workspaceId,
          JSON.stringify({
            memoryPromotionRevokedAt: new Date().toISOString(),
            memoryPromotionRevokedBy: actorUserId,
          }),
        ]
      );
    }
    const updated = await tx.query(
      `
      UPDATE huddle_memory_candidates
      SET
        status = 'cancelled',
        metadata = metadata || $4::jsonb,
        updated_at = now()
      WHERE id = $1
        AND workspace_id = $2
        AND session_id = $3
      RETURNING *
      `,
      [
        memoryCandidateId,
        workspaceId,
        sessionId,
        JSON.stringify({
          revokedAt: new Date().toISOString(),
          revokedBy: actorUserId,
          revokeReason: safeString(reason, 1000) || null,
        }),
      ]
    );
    await createHuddleSessionEvent({
      workspaceId,
      sessionId,
      actorUserId,
      eventType: "huddle.intelligence.memory_revoked",
      eventPayload: {
        memoryCandidateId,
        workspaceMemoryId: candidate.promoted_memory_id,
        reason: safeString(reason, 1000) || null,
      },
      client: tx,
    });
    return {
      memoryCandidate: serializeCandidate(updated.rows[0]),
      revoked: true,
      idempotent: false,
    };
  });
}

export default {
  createMemoryCandidateFromArtifact,
  listMemoryCandidateHistory,
  promoteApprovedMemoryCandidate,
  revokePromotedMemoryCandidate,
};
