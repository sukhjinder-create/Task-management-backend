import pool from "../db.js";
import {
  listArtifactSources,
  listHuddleArtifacts,
} from "./huddleArtifact.service.js";
import {
  listIntelligenceJobs,
  listMeetingDigests,
  listOwnershipResolutions,
  listTimelineEntries,
} from "./huddleIntelligence.service.js";
import { listTranscriptSegments } from "./huddleTranscript.service.js";

function runner(client = null) {
  return client || pool;
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function latestArtifact(artifacts, artifactType) {
  return artifacts.find(
    (artifact) =>
      artifact.artifactType === artifactType &&
      artifact.status === "ready"
  ) || artifacts.find((artifact) => artifact.artifactType === artifactType) || null;
}

function artifactCounts(artifact) {
  if (!artifact) return 0;
  if (artifact.artifactType === "decision") {
    return Array.isArray(artifact.contentJson?.decisions)
      ? artifact.contentJson.decisions.length
      : 0;
  }
  if (artifact.artifactType === "action_item") {
    return Array.isArray(artifact.contentJson?.actionItems)
      ? artifact.contentJson.actionItems.length
      : 0;
  }
  return 0;
}

function lifecycleTitle(eventType) {
  const normalized = safeString(eventType).replace(/^huddle[.:_-]?/i, "");
  return normalized
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Meeting event";
}

async function loadMeetingContext({ workspaceId, sessionId, client = null }) {
  const [sessionResult, participantsResult, eventsResult] = await Promise.all([
    runner(client).query(
      `
      SELECT
        s.*,
        u.username AS host_name,
        c.name AS channel_name
      FROM huddle_sessions s
      LEFT JOIN users u ON u.id = s.host_user_id
      LEFT JOIN chat_channels c ON c.id = s.channel_id
      WHERE s.workspace_id = $1
        AND s.id = $2
      LIMIT 1
      `,
      [workspaceId, sessionId]
    ),
    runner(client).query(
      `
      SELECT
        p.id AS participant_id,
        p.user_id,
        p.guest_id,
        p.participant_kind,
        p.role,
        p.join_state,
        p.joined_at,
        p.left_at,
        COALESCE(u.username, g.display_name, p.metadata->>'displayName', 'Participant') AS display_name
      FROM huddle_session_participants p
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN huddle_guests g ON g.id = p.guest_id
      WHERE p.workspace_id = $1
        AND p.session_id = $2
      ORDER BY p.joined_at ASC NULLS LAST, p.created_at ASC
      `,
      [workspaceId, sessionId]
    ),
    runner(client).query(
      `
      SELECT
        e.id,
        e.actor_user_id,
        e.actor_guest_id,
        e.event_type,
        e.event_payload,
        e.created_at,
        COALESCE(u.username, g.display_name) AS actor_name
      FROM huddle_session_events e
      LEFT JOIN users u ON u.id = e.actor_user_id
      LEFT JOIN huddle_guests g ON g.id = e.actor_guest_id
      WHERE e.workspace_id = $1
        AND e.session_id = $2
      ORDER BY e.created_at ASC
      LIMIT 1000
      `,
      [workspaceId, sessionId]
    ),
  ]);

  const session = sessionResult.rows[0];
  if (!session) {
    const error = new Error("huddle_session_not_found");
    error.statusCode = 404;
    error.reason = "huddle_session_not_found";
    throw error;
  }

  const title =
    safeString(session.metadata?.title) ||
    safeString(session.metadata?.meetingTitle) ||
    safeString(session.channel_name) ||
    (safeString(session.host_name) ? `${session.host_name}'s Huddle` : "Huddle");

  return {
    session,
    title,
    participants: participantsResult.rows.map((row) => ({
      participantId: row.participant_id,
      userId: row.user_id,
      guestId: row.guest_id,
      participantKind: row.participant_kind,
      role: row.role,
      joinState: row.join_state,
      joinedAt: row.joined_at,
      leftAt: row.left_at,
      displayName: row.display_name,
    })),
    lifecycleEvents: eventsResult.rows.map((row) => ({
      id: row.id,
      entryType: "system",
      title: lifecycleTitle(row.event_type),
      description: row.actor_name ? `${row.actor_name} - ${lifecycleTitle(row.event_type)}` : null,
      occurredAt: row.created_at,
      eventType: row.event_type,
      eventPayload: row.event_payload || {},
      actorUserId: row.actor_user_id,
      actorGuestId: row.actor_guest_id,
      actorName: row.actor_name,
      provenance: { source: "huddle_session_event", eventId: row.id },
    })),
  };
}

export async function getMeetingIntelligenceDeliveryContext({
  workspaceId,
  sessionId,
  client = null,
}) {
  const context = await loadMeetingContext({ workspaceId, sessionId, client });
  const participantUserIds = [
    ...new Set([
      context.session.started_by,
      context.session.host_user_id,
      ...context.participants.map((participant) => participant.userId),
    ].filter(Boolean)),
  ];
  return {
    title: context.title,
    participantUserIds,
    participants: context.participants,
    startedAt: context.session.started_at,
    endedAt: context.session.ended_at,
  };
}

export async function getMeetingIntelligenceReview({
  workspaceId,
  sessionId,
  actorUserId,
  role = "user",
  client = null,
}) {
  const [
    context,
    artifacts,
    transcript,
    timeline,
    ownership,
    digests,
    jobs,
  ] = await Promise.all([
    loadMeetingContext({ workspaceId, sessionId, client }),
    listHuddleArtifacts({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      includeDeleted: false,
      limit: 200,
      client,
    }),
    listTranscriptSegments({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      status: "final",
      includeRetracted: false,
      limit: 1000,
      client,
    }),
    listTimelineEntries({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      limit: 1000,
      client,
    }),
    listOwnershipResolutions({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      limit: 500,
      client,
    }),
    listMeetingDigests({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      limit: 20,
      client,
    }),
    listIntelligenceJobs({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      limit: 200,
      client,
    }),
  ]);

  const selected = {
    transcript: latestArtifact(artifacts, "transcript"),
    summary: latestArtifact(artifacts, "summary"),
    decisions: latestArtifact(artifacts, "decision"),
    actions: latestArtifact(artifacts, "action_item"),
    timeline: latestArtifact(artifacts, "timeline"),
  };
  const selectedArtifacts = Object.values(selected).filter(Boolean);
  const sourcePairs = await Promise.all(
    selectedArtifacts.map(async (artifact) => [
      artifact.id,
      await listArtifactSources({
        workspaceId,
        artifactId: artifact.id,
        actorUserId,
        role,
        client,
      }),
    ])
  );
  const sourcesByArtifactId = Object.fromEntries(sourcePairs);
  const privileged = ["admin", "manager", "owner"].includes(
    safeString(role).toLowerCase()
  );
  const host =
    String(context.session.started_by || "") === String(actorUserId || "") ||
    String(context.session.host_user_id || "") === String(actorUserId || "");
  const latestDigest = digests[0] || null;
  const combinedTimeline = [
    ...timeline,
    ...context.lifecycleEvents,
  ].sort(
    (left, right) =>
      new Date(left.occurredAt || 0).getTime() -
      new Date(right.occurredAt || 0).getTime()
  );
  const decisionCount = artifactCounts(selected.decisions);
  const actionItemCount = artifactCounts(selected.actions);

  return {
    session: {
      id: context.session.id,
      workspaceId: context.session.workspace_id,
      title: context.title,
      state: context.session.state,
      mode: context.session.mode,
      startedAt: context.session.started_at,
      endedAt: context.session.ended_at,
      hostUserId: context.session.host_user_id,
      hostName: context.session.host_name,
      channelId: context.session.channel_id,
      channelName: context.session.channel_name,
    },
    participants: context.participants,
    permissions: {
      canRead: true,
      canReviewArtifacts: privileged || host,
      canEditApprovedArtifacts: privileged,
      canReviewOwnership: privileged,
      canCreateTasks: false,
    },
    status: {
      summaryAvailable: Boolean(selected.summary?.status === "ready"),
      decisionCount,
      actionItemCount,
      ownershipSuggestionCount: ownership.length,
      transcriptSegmentCount: transcript.length,
      pendingReviewCount: selectedArtifacts.filter(
        (artifact) => artifact.approvalStatus === "pending"
      ).length + ownership.filter((item) => item.status === "pending_approval").length,
      processingJobCount: jobs.filter((job) =>
        ["queued", "processing"].includes(job.status)
      ).length,
      failedJobCount: jobs.filter((job) => job.status === "failed").length,
    },
    artifacts: {
      ...selected,
      sourcesByArtifactId,
    },
    transcript,
    timeline: combinedTimeline,
    ownership,
    digest: latestDigest,
    jobs,
    export: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sessionId,
      title: context.title,
      summaryArtifactId: selected.summary?.id || null,
      decisionsArtifactId: selected.decisions?.id || null,
      actionsArtifactId: selected.actions?.id || null,
      timelineArtifactId: selected.timeline?.id || null,
      transcriptArtifactId: selected.transcript?.id || null,
    },
  };
}

export default {
  getMeetingIntelligenceDeliveryContext,
  getMeetingIntelligenceReview,
};
