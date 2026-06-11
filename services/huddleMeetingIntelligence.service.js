import pool from "../db.js";
import {
  listArtifactSources,
  listHuddleArtifacts,
} from "./huddleArtifact.service.js";
import {
  listIntelligenceJobs,
  listMeetingDigests,
  listMemoryCandidates,
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
    memoryCandidates,
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
    listMemoryCandidates({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      limit: 200,
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
      canReviewOwnership: privileged || host,
      canReviewMemory: privileged || host,
      canCreateTasks: false,
    },
    status: {
      summaryAvailable: Boolean(selected.summary?.status === "ready"),
      decisionCount,
      actionItemCount,
      ownershipSuggestionCount: ownership.length,
      memoryCandidateCount: memoryCandidates.length,
      transcriptSegmentCount: transcript.length,
      pendingReviewCount: selectedArtifacts.filter(
        (artifact) => artifact.approvalStatus === "pending"
      ).length +
        ownership.filter((item) => item.status === "pending_approval").length +
        memoryCandidates.filter((item) => item.status === "pending_approval").length,
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
    memoryCandidates,
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

function segmentTimestamp(segment) {
  return new Date(segment.startedAt || segment.createdAt || 0).getTime();
}

function evidenceIntersects(item, segmentIds) {
  return (item?.evidenceSegmentIds || []).some((id) => segmentIds.has(id));
}

export async function getWhatDidIMiss({
  workspaceId,
  sessionId,
  actorUserId,
  role = "user",
  since = null,
  client = null,
}) {
  const [context, transcript, artifacts] = await Promise.all([
    loadMeetingContext({ workspaceId, sessionId, client }),
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
    listHuddleArtifacts({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      includeDeleted: false,
      limit: 100,
      client,
    }),
  ]);
  const actorParticipant = context.participants.find(
    (participant) => String(participant.userId || "") === String(actorUserId || "")
  );
  const requestedSince = since ? new Date(since) : null;
  const explicitSince = requestedSince && !Number.isNaN(requestedSince.getTime());
  const sessionStartedTimestamp = new Date(context.session.started_at || 0).getTime();
  const actorJoinedTimestamp = new Date(actorParticipant?.joinedAt || 0).getTime();
  const actorIsHost =
    String(context.session.started_by || "") === String(actorUserId || "") ||
    String(context.session.host_user_id || "") === String(actorUserId || "");
  const lateJoin =
    !actorIsHost &&
    Number.isFinite(actorJoinedTimestamp) &&
    actorJoinedTimestamp > sessionStartedTimestamp + 5000;
  const coverageMode = explicitSince
    ? "since_requested_time"
    : lateJoin
      ? "before_participant_join"
      : "meeting_so_far";
  const missedSegments = explicitSince
    ? transcript.filter(
        (segment) => segmentTimestamp(segment) >= requestedSince.getTime()
      )
    : lateJoin
      ? transcript.filter(
          (segment) => segmentTimestamp(segment) < actorJoinedTimestamp
        )
      : transcript;
  const relevantSegments = missedSegments.slice(-80);
  const sinceAt = explicitSince
    ? requestedSince.toISOString()
    : relevantSegments[0]?.startedAt || context.session.started_at;
  const throughAt = lateJoin
    ? actorParticipant.joinedAt
    : relevantSegments.at(-1)?.endedAt ||
      relevantSegments.at(-1)?.startedAt ||
      null;
  const relevantIds = new Set(relevantSegments.map((segment) => segment.id));
  const summary = latestArtifact(artifacts, "summary");
  const decisionArtifact = latestArtifact(artifacts, "decision");
  const actionArtifact = latestArtifact(artifacts, "action_item");
  const discussionHighlights = relevantSegments.slice(-12).map((segment) => ({
    speaker: segment.speaker?.label || "Participant",
    text: segment.text,
    occurredAt: segment.startedAt,
    evidenceSegmentIds: [segment.id],
  }));
  const generatedHighlights = (summary?.contentJson?.discussionHighlights || [])
    .filter((item) => evidenceIntersects(item, relevantIds));
  const openQuestions = (summary?.contentJson?.openQuestions || [])
    .filter((item) => evidenceIntersects(item, relevantIds));
  const decisions = (decisionArtifact?.contentJson?.decisions || [])
    .filter((item) => evidenceIntersects(item, relevantIds));
  const actionItems = (actionArtifact?.contentJson?.actionItems || [])
    .filter((item) => evidenceIntersects(item, relevantIds));
  const rollingSummary = generatedHighlights.length
    ? generatedHighlights
        .slice(-8)
        .map((item) => `${item.speaker}: ${item.text}`)
        .join("\n")
    : discussionHighlights
        .slice(-8)
        .map((item) => `${item.speaker}: ${item.text}`)
        .join("\n");

  return {
    session: {
      id: context.session.id,
      title: context.title,
      state: context.session.state,
      startedAt: context.session.started_at,
      endedAt: context.session.ended_at,
    },
    sinceAt,
    throughAt,
    coverageMode,
    generatedAt: new Date().toISOString(),
    live: context.session.state !== "ended",
    rollingSummary,
    discussionHighlights:
      generatedHighlights.length > 0 ? generatedHighlights : discussionHighlights,
    decisions,
    actionItems,
    openQuestions,
    transcript: relevantSegments,
    evidence: {
      canonicalTranscript: true,
      segmentCount: relevantSegments.length,
      generatedArtifactIds: {
        summary: summary?.id || null,
        decisions: decisionArtifact?.id || null,
        actions: actionArtifact?.id || null,
      },
    },
  };
}

export default {
  getMeetingIntelligenceDeliveryContext,
  getMeetingIntelligenceReview,
  getWhatDidIMiss,
};
