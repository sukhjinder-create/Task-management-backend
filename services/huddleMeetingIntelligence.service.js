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
import { listHuddleActionTasks } from "./huddleActionTask.service.js";

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

function array(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => safeString(value)).filter(Boolean))];
}

function participantAliasEntries(participants = []) {
  const names = uniqueStrings(
    participants
      .map((participant) => participant.displayName)
      .filter((name) => name && !/^participant(?:\s+\d+)?$/i.test(name))
  );
  return names.map((name, index) => [`Participant ${index + 1}`, name]);
}

function resolveParticipantAliases(value, participants = []) {
  if (typeof value === "string") {
    let resolved = value;
    for (const [alias, name] of participantAliasEntries(participants)) {
      resolved = resolved.replace(
        new RegExp(`\\b${alias.replace(" ", "\\s+")}\\b`, "gi"),
        name
      );
    }
    if (participants.length === 1) {
      resolved = resolved.replace(
        /\bParticipant\b/gi,
        participants[0].displayName || "Participant"
      );
    }
    return resolved;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveParticipantAliases(item, participants));
  }
  if (value instanceof Date) return value;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      resolveParticipantAliases(nested, participants),
    ])
  );
}

function resolveArtifactParticipantNames(artifact, participants) {
  if (!artifact) return null;
  return {
    ...artifact,
    contentText: resolveParticipantAliases(artifact.contentText, participants),
    contentJson: resolveParticipantAliases(artifact.contentJson, participants),
  };
}

function evidenceSpeakers(segmentIds, segmentById) {
  return uniqueStrings(
    array(segmentIds).map((id) => segmentById.get(String(id))?.speaker?.label)
  );
}

function buildMeetingReport({
  title,
  selected,
  transcript,
  timeline,
  ownership,
}) {
  const summary = selected.summary?.contentJson || {};
  const decisions = array(selected.decisions?.contentJson?.decisions);
  const actions = array(selected.actions?.contentJson?.actionItems);
  const segmentById = new Map(transcript.map((segment) => [String(segment.id), segment]));
  const ownershipByAction = new Map(
    ownership.map((item) => [String(item.metadata?.actionItemId || ""), item])
  );
  const discussionHighlights = array(
    summary.speakerHighlights || summary.discussionHighlights
  ).map((item, index) => ({
    id: item.id || `highlight-${index + 1}`,
    speaker:
      safeString(item.speaker) ||
      evidenceSpeakers(item.evidenceSegmentIds, segmentById).join(", ") ||
      "Participants",
    text: safeString(item.text || item.highlight),
    evidenceSegmentIds: array(item.evidenceSegmentIds),
  })).filter((item) => item.text);
  const keyPoints = array(summary.keyPoints).map((item, index) => ({
    id: item.id || `point-${index + 1}`,
    text: safeString(item.text || item.point),
    evidenceSegmentIds: array(item.evidenceSegmentIds),
  })).filter((item) => item.text);
  const openQuestions = array(summary.openQuestions).map((item, index) => ({
    id: item.id || `question-${index + 1}`,
    question: safeString(item.question || item.text),
    raisedBy:
      safeString(item.raisedBy) ||
      evidenceSpeakers(item.evidenceSegmentIds, segmentById).join(", ") ||
      null,
    evidenceSegmentIds: array(item.evidenceSegmentIds),
  })).filter((item) => item.question);
  const reportDecisions = decisions.map((item, index) => ({
    ...item,
    id: item.id || `decision-${index + 1}`,
    participants: uniqueStrings([
      ...array(item.participants),
      ...evidenceSpeakers(item.evidenceSegmentIds, segmentById),
    ]),
  }));
  const reportActions = actions.map((item, index) => {
    const resolution = ownershipByAction.get(String(item.id || ""));
    return {
      ...item,
      id: item.id || `action-${index + 1}`,
      owner: resolution
        ? {
            userId:
              resolution.resolvedOwnerUserId ||
              resolution.suggestedOwnerUserId ||
              null,
            label:
              resolution.metadata?.resolvedOwnerLabel ||
              resolution.metadata?.ownerLabel ||
              item.suggestedOwner?.label ||
              "Unassigned",
            status: resolution.status,
            confidence: resolution.confidence,
          }
        : item.suggestedOwner || null,
      participants: evidenceSpeakers(item.evidenceSegmentIds, segmentById),
    };
  });
  const speakerNames = uniqueStrings([
    ...transcript.map((segment) => segment.speaker?.label),
    ...discussionHighlights.map((item) => item.speaker),
  ]);
  const speakerHighlights = speakerNames.map((speaker) => {
    const keyPointsRaised = discussionHighlights.filter(
      (item) => item.speaker === speaker
    );
    const commitments = reportActions.filter(
      (item) =>
        item.owner?.label === speaker || item.participants?.includes(speaker)
    );
    const decisionsInfluenced = reportDecisions.filter((item) =>
      item.participants?.includes(speaker)
    );
    const concernsRaised = [...keyPoints, ...openQuestions]
      .filter((item) =>
        evidenceSpeakers(item.evidenceSegmentIds, segmentById).includes(speaker)
      )
      .filter((item) =>
        /\b(risk|block|concern|delay|dependency|uncertain|issue|question)\b/i.test(
          item.text || item.question || ""
        )
      );
    return {
      speaker,
      keyPointsRaised,
      commitments,
      concernsRaised,
      decisionsInfluenced,
    };
  }).filter(
    (item) =>
      item.keyPointsRaised.length ||
      item.commitments.length ||
      item.concernsRaised.length ||
      item.decisionsInfluenced.length
  );
  const chronologicalConversation = array(summary.chronologicalSummary).length
    ? array(summary.chronologicalSummary)
    : [
        ...discussionHighlights.map((item) => ({
          id: item.id,
          title: item.speaker,
          description: item.text,
          evidenceSegmentIds: item.evidenceSegmentIds,
          occurredAt:
            segmentById.get(String(item.evidenceSegmentIds?.[0] || ""))?.startedAt ||
            null,
        })),
        ...timeline
          .filter((entry) => entry.entryType !== "system")
          .map((entry) => ({
            id: entry.id,
            title: entry.title || entry.entryType,
            description: entry.description,
            evidenceSegmentIds: entry.transcriptSegmentId
              ? [entry.transcriptSegmentId]
              : [],
            occurredAt: entry.occurredAt,
          })),
      ].sort(
        (left, right) =>
          new Date(left.occurredAt || 0).getTime() -
          new Date(right.occurredAt || 0).getTime()
      );
  const risks = array(summary.risksRaised).length
    ? array(summary.risksRaised)
    : [...keyPoints, ...openQuestions]
        .filter((item) =>
          /\b(risk|block|concern|delay|dependency|uncertain|issue)\b/i.test(
            item.text || item.question || ""
          )
        )
        .map((item) => ({
          id: `risk-${item.id}`,
          text: item.text || item.question,
          evidenceSegmentIds: item.evidenceSegmentIds || [],
        }));
  // Executive synthesis fields (schemaVersion 4 summary). These drive the new
  // executive-report UI. discussionThemes replaces per-speaker highlights.
  const discussionThemes = array(summary.discussionThemes).map((item, index) => ({
    id: item.id || `theme-${index + 1}`,
    theme: safeString(item.theme) || `Theme ${index + 1}`,
    detail: safeString(item.detail),
    evidenceSegmentIds: array(item.evidenceSegmentIds),
  })).filter((item) => item.detail || item.theme);
  const recommendations = array(summary.recommendations).map((item, index) => ({
    id: item.id || `recommendation-${index + 1}`,
    text: safeString(item.text),
    evidenceSegmentIds: array(item.evidenceSegmentIds),
  })).filter((item) => item.text);
  const executiveNarrative =
    safeString(summary.executiveSummary) || safeString(summary.overview) || "";
  return {
    schemaVersion: 4,
    title,
    executiveSummary: {
      purpose: safeString(summary.purpose) || safeString(summary.title) || title,
      businessContext: safeString(summary.businessContext) || null,
      narrative: executiveNarrative,
      // `outcome` retained for backward compatibility with older clients.
      outcome:
        safeString(summary.outcome) ||
        executiveNarrative ||
        "No executive summary is available yet.",
      conclusions: array(summary.conclusions).length
        ? array(summary.conclusions)
        : keyPoints,
      unresolved: openQuestions,
      evidenceSegmentIds: array(summary.overviewEvidenceSegmentIds),
    },
    businessContext: safeString(summary.businessContext) || null,
    discussionThemes,
    recommendations,
    discussionHighlights,
    discussionSummary: array(summary.discussionSummary),
    speakerHighlights,
    keyPoints,
    chronologicalConversation,
    decisions: reportDecisions,
    actionItems: reportActions,
    ownershipSuggestions: ownership,
    openQuestions,
    risks,
    nextSteps: array(summary.nextSteps),
    outcomes: array(summary.meetingOutcomes).length
      ? array(summary.meetingOutcomes)
      : [
          ...reportDecisions.map((item) => ({
            type: "decision",
            text: item.decision || item.title,
            evidenceSegmentIds: array(item.evidenceSegmentIds),
          })),
          ...reportActions.map((item) => ({
            type: "action_item",
            text: item.title,
            owner: item.owner,
            evidenceSegmentIds: array(item.evidenceSegmentIds),
          })),
        ],
  };
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
      occurredAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
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
    actionTasks,
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
    listHuddleActionTasks({
      workspaceId,
      sessionId,
      client,
    }),
  ]);

  const selected = {
    transcript: resolveArtifactParticipantNames(
      latestArtifact(artifacts, "transcript"),
      context.participants
    ),
    summary: resolveArtifactParticipantNames(
      latestArtifact(artifacts, "summary"),
      context.participants
    ),
    decisions: resolveArtifactParticipantNames(
      latestArtifact(artifacts, "decision"),
      context.participants
    ),
    actions: resolveArtifactParticipantNames(
      latestArtifact(artifacts, "action_item"),
      context.participants
    ),
    timeline: resolveArtifactParticipantNames(
      latestArtifact(artifacts, "timeline"),
      context.participants
    ),
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
  // selected.timeline is the auto-generated artifact (huddleIntelligenceWorker
  // .service.js processTimelineGeneration, derived deterministically from
  // topic segments) — its contentJson.timeline entries were being computed
  // and stored but never actually merged into what the UI renders, only
  // `timeline` (the separate, manually-created huddle_timeline_entries) and
  // lifecycle events were. Without this the entire timeline_generation stage
  // had no visible effect on the meeting intelligence page.
  const generatedTimelineSource = selected.timeline?.contentJson?.timeline;
  const generatedTimelineEntries = (Array.isArray(generatedTimelineSource) ? generatedTimelineSource : []).map(
    (entry, index) => ({
      id: `generated-timeline-${index}`,
      title: entry.title,
      description: entry.description,
      occurredAt: entry.occurredAt,
      entryType: "topic_segment",
      transcriptSegmentId: entry.evidenceSegmentIds?.[0] || null,
    })
  );
  const combinedTimeline = [
    ...timeline,
    ...generatedTimelineEntries,
    ...context.lifecycleEvents,
  ].map((entry) =>
    resolveParticipantAliases(entry, context.participants)
  ).sort(
    (left, right) =>
      new Date(left.occurredAt || 0).getTime() -
      new Date(right.occurredAt || 0).getTime()
  );
  const decisionCount = artifactCounts(selected.decisions);
  const actionItemCount = artifactCounts(selected.actions);
  const report = buildMeetingReport({
    title: context.title,
    selected,
    transcript,
    timeline: combinedTimeline,
    ownership: resolveParticipantAliases(ownership, context.participants),
  });

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
      canCreateTasks: privileged,
      canUseCopilot: true,
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
    ownership: resolveParticipantAliases(ownership, context.participants),
    memoryCandidates: resolveParticipantAliases(
      memoryCandidates,
      context.participants
    ),
    actionTasks,
    report,
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
