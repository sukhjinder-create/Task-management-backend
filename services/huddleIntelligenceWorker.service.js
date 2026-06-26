import {
  HUDDLE_INTELLIGENCE_JOB_TYPES,
  claimNextIntelligenceJob,
  completeIntelligenceJob,
  enqueueIntelligenceJob,
  failIntelligenceJob,
  getHuddleIntelligenceDiagnostics,
  heartbeatIntelligenceJob,
  recoverStaleIntelligenceJobs,
  upsertMeetingDigest,
} from "./huddleIntelligence.service.js";
import {
  createHuddleArtifact,
  listHuddleArtifacts,
  updateHuddleArtifact,
} from "./huddleArtifact.service.js";
import { finalizeHuddleTranscript } from "./huddleTranscriptionPipeline.service.js";
import {
  createOwnershipSuggestions,
  generateHuddleArtifact,
  getHuddleIntelligenceGenerationDiagnostics,
} from "./huddleIntelligenceGeneration.service.js";
import { runLanguageNormalization } from "./huddleLanguageNormalization.service.js";
import { runTopicSegmentation, listTopicSegments } from "./huddleTopicSegmentation.service.js";
import { runRiskBlockerExtraction, listRiskBlockerItems } from "./huddleRiskBlockerExtraction.service.js";
import {
  getMeetingIntelligenceDeliveryContext,
} from "./huddleMeetingIntelligence.service.js";
import { notifyUser } from "./notification.service.js";

const ORCHESTRATION_VERSION = 2;
const DEFAULT_LEASE_SECONDS = 90;
const DEFAULT_BATCH_SIZE = 10;

// Timeline is deterministic (derived from topic segments, no LLM call) and
// gets its own dedicated handler below instead of going through the
// LLM-based artifact generator used for summary/decision/action_item.
const ARTIFACT_JOB_TYPES = Object.freeze({
  [HUDDLE_INTELLIGENCE_JOB_TYPES.SUMMARY_GENERATION]: "summary",
  [HUDDLE_INTELLIGENCE_JOB_TYPES.DECISION_EXTRACTION]: "decision",
  [HUDDLE_INTELLIGENCE_JOB_TYPES.ACTION_ITEM_EXTRACTION]: "action_item",
});

const GENERATED_ARTIFACT_TYPES = new Set(["summary", "decision", "action_item"]);

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function jobActor(job) {
  const actorUserId = safeString(job?.createdBy);
  if (!actorUserId) {
    const error = new Error("intelligence_job_actor_missing");
    error.reason = "intelligence_job_actor_missing";
    error.retryable = false;
    throw error;
  }
  return { actorUserId, role: "admin" };
}

async function ensurePendingArtifact(job, artifactType, client = null) {
  const actor = jobActor(job);
  const artifacts = await listHuddleArtifacts({
    workspaceId: job.workspaceId,
    sessionId: job.sessionId,
    ...actor,
    artifactType,
    includeDeleted: false,
    limit: 100,
    client,
  });
  const existing = artifacts.find((artifact) => {
    if (!["draft", "pending", "processing"].includes(artifact.status)) return false;
    return ["awaiting_generator", "processing", "failed"].includes(
      artifact.contentJson?.generationState
    );
  });
  if (existing) return { artifact: existing, created: false };

  const transcriptArtifactId =
    job.artifactId ||
    job.input?.transcriptArtifactId ||
    null;
  const approvalRequired = GENERATED_ARTIFACT_TYPES.has(artifactType);
  const result = await createHuddleArtifact({
    workspaceId: job.workspaceId,
    sessionId: job.sessionId,
    ...actor,
    input: {
      artifactType,
      status: "pending",
      approvalStatus: approvalRequired ? "pending" : "not_required",
      visibility: "session_participants",
      contentJson: {
        generationState: "awaiting_generator",
        orchestrationVersion: ORCHESTRATION_VERSION,
      },
      provenance: {
        source: "huddle_intelligence_worker",
        sourceJobId: job.id,
        sourceJobType: job.jobType,
        transcriptArtifactId,
        generationImplemented: false,
      },
      metadata: {
        orchestrationOnly: true,
        generationState: "awaiting_generator",
      },
      sources: transcriptArtifactId
        ? [{
            sourceKind: "artifact",
            sourceArtifactId: transcriptArtifactId,
            sourceRef: `huddle_artifact:${transcriptArtifactId}`,
            metadata: { relationship: "source_transcript" },
          }]
        : [],
    },
    client,
  });
  return { artifact: result.artifact, created: true };
}

async function enqueueTranscriptWorkflow(job, transcriptArtifactId, client = null) {
  const actor = jobActor(job);
  const base = {
    workspaceId: job.workspaceId,
    sessionId: job.sessionId,
    ...actor,
    artifactId: transcriptArtifactId,
    version: ORCHESTRATION_VERSION,
    maxAttempts: 3,
    provenance: {
      source: "transcript_finalization",
      sourceJobId: job.id,
      transcriptArtifactId,
    },
    metadata: {
      orchestrationOnly: true,
      generationImplemented: false,
    },
    dependsOnJobIds: [job.id],
    client,
  };

  // Pipeline order: language normalization runs first so every later stage
  // works from consistent English text; topic segmentation runs next so
  // decision/action/risk extraction and the summary all condition on
  // discussion structure instead of raw undifferentiated dialogue.
  const languageNormalization = await enqueueIntelligenceJob({
    ...base,
    jobType: HUDDLE_INTELLIGENCE_JOB_TYPES.LANGUAGE_NORMALIZATION,
    idempotencyKey: `language-normalization:${transcriptArtifactId}:v${ORCHESTRATION_VERSION}`,
  });
  const topicSegmentation = await enqueueIntelligenceJob({
    ...base,
    jobType: HUDDLE_INTELLIGENCE_JOB_TYPES.TOPIC_SEGMENTATION,
    idempotencyKey: `topic-segmentation:${transcriptArtifactId}:v${ORCHESTRATION_VERSION}`,
    dependsOnJobIds: [languageNormalization.job.id],
  });
  const segmentationDependent = {
    ...base,
    dependsOnJobIds: [topicSegmentation.job.id],
  };

  const summary = await enqueueIntelligenceJob({
    ...segmentationDependent,
    jobType: HUDDLE_INTELLIGENCE_JOB_TYPES.SUMMARY_GENERATION,
    idempotencyKey: `summary:${transcriptArtifactId}:v${ORCHESTRATION_VERSION}`,
  });
  const decisions = await enqueueIntelligenceJob({
    ...segmentationDependent,
    jobType: HUDDLE_INTELLIGENCE_JOB_TYPES.DECISION_EXTRACTION,
    idempotencyKey: `decisions:${transcriptArtifactId}:v${ORCHESTRATION_VERSION}`,
  });
  const actions = await enqueueIntelligenceJob({
    ...segmentationDependent,
    jobType: HUDDLE_INTELLIGENCE_JOB_TYPES.ACTION_ITEM_EXTRACTION,
    idempotencyKey: `actions:${transcriptArtifactId}:v${ORCHESTRATION_VERSION}`,
  });
  const riskBlockers = await enqueueIntelligenceJob({
    ...segmentationDependent,
    jobType: HUDDLE_INTELLIGENCE_JOB_TYPES.RISK_BLOCKER_EXTRACTION,
    idempotencyKey: `risk-blockers:${transcriptArtifactId}:v${ORCHESTRATION_VERSION}`,
  });
  const timeline = await enqueueIntelligenceJob({
    ...segmentationDependent,
    jobType: HUDDLE_INTELLIGENCE_JOB_TYPES.TIMELINE_GENERATION,
    idempotencyKey: `timeline:${transcriptArtifactId}:v${ORCHESTRATION_VERSION}`,
  });
  const ownership = await enqueueIntelligenceJob({
    ...base,
    jobType: HUDDLE_INTELLIGENCE_JOB_TYPES.OWNERSHIP_RESOLUTION,
    idempotencyKey: `ownership:${transcriptArtifactId}:v${ORCHESTRATION_VERSION}`,
    dependsOnJobIds: [actions.job.id],
  });
  const digest = await enqueueIntelligenceJob({
    ...base,
    jobType: HUDDLE_INTELLIGENCE_JOB_TYPES.MEETING_DIGEST_GENERATION,
    idempotencyKey: `digest:${transcriptArtifactId}:v${ORCHESTRATION_VERSION}`,
    dependsOnJobIds: [
      summary.job.id,
      decisions.job.id,
      actions.job.id,
      riskBlockers.job.id,
      timeline.job.id,
      ownership.job.id,
    ],
  });

  return {
    languageNormalizationJobId: languageNormalization.job.id,
    topicSegmentationJobId: topicSegmentation.job.id,
    summaryJobId: summary.job.id,
    decisionJobId: decisions.job.id,
    actionItemJobId: actions.job.id,
    riskBlockerJobId: riskBlockers.job.id,
    timelineJobId: timeline.job.id,
    ownershipJobId: ownership.job.id,
    meetingDigestJobId: digest.job.id,
  };
}

async function processTranscriptFinalization(job, client = null) {
  const actor = jobActor(job);
  const finalization = await finalizeHuddleTranscript({
    workspaceId: job.workspaceId,
    sessionId: job.sessionId,
    ...actor,
    reason: "intelligence_worker",
    client,
  });
  const transcriptArtifactId =
    finalization?.artifact?.id ||
    job.artifactId ||
    job.input?.transcriptArtifactId ||
    null;
  if (!transcriptArtifactId) {
    return {
      orchestrationOnly: true,
      transcriptFinalized: true,
      downstreamQueued: false,
      reason: finalization?.reason || "no_transcript_artifact",
    };
  }
  const downstream = await enqueueTranscriptWorkflow(job, transcriptArtifactId, client);
  return {
    orchestrationOnly: true,
    transcriptFinalized: true,
    transcriptArtifactId,
    downstreamQueued: true,
    downstream,
  };
}

async function processArtifactPreparation(job, client = null) {
  const artifactType = ARTIFACT_JOB_TYPES[job.jobType];
  const prepared = await ensurePendingArtifact(job, artifactType, client);
  if (GENERATED_ARTIFACT_TYPES.has(artifactType)) {
    const generated = await generateHuddleArtifact({
      job,
      artifact: prepared.artifact,
      client,
    });
    return {
      orchestrationOnly: false,
      generationImplemented: true,
      generationState: "generated_pending_approval",
      artifactType,
      artifactId: generated.artifact.id,
      artifactCreated: prepared.created,
      evidenceSegmentIds: generated.evidenceSegmentIds,
      diagnostics: generated.diagnostics,
    };
  }
  return {
    orchestrationOnly: true,
    generationImplemented: false,
    generationState: "awaiting_generator",
    artifactType,
    artifactId: prepared.artifact.id,
    artifactCreated: prepared.created,
  };
}

async function processLanguageNormalization(job, client = null) {
  const result = await runLanguageNormalization({ job, client });
  return { stage: "language_normalization", ...result };
}

async function processTopicSegmentation(job, client = null) {
  const result = await runTopicSegmentation({ job, client });
  return { stage: "topic_segmentation", ...result };
}

async function processRiskBlockerExtraction(job, client = null) {
  const result = await runRiskBlockerExtraction({ job, client });
  return { stage: "risk_blocker_extraction", ...result };
}

async function processTimelineGeneration(job, client = null) {
  const actor = jobActor(job);
  const topicSegments = await listTopicSegments({
    workspaceId: job.workspaceId,
    sessionId: job.sessionId,
    client,
  });
  const prepared = await ensurePendingArtifact(job, "timeline", client);
  if (!topicSegments.length) {
    return {
      orchestrationOnly: true,
      generationImplemented: false,
      artifactId: prepared.artifact.id,
      reason: "no_topic_segments",
    };
  }
  const timelineEntries = topicSegments.map((topic) => ({
    title: topic.title,
    description: topic.summary,
    occurredAt: topic.startedAt,
    evidenceSegmentIds: topic.evidenceSegmentIds,
  }));
  const completed = await updateHuddleArtifact({
    workspaceId: job.workspaceId,
    artifactId: prepared.artifact.id,
    actorUserId: actor.actorUserId,
    role: "admin",
    patch: {
      status: "ready",
      approvalStatus: "not_required",
      contentJson: {
        timeline: timelineEntries,
        generationState: "generated",
        generatedAt: new Date().toISOString(),
      },
      contentText: timelineEntries
        .map((entry) => `${entry.occurredAt || ""} - ${entry.title}: ${entry.description || ""}`)
        .join("\n"),
      provenance: {
        ...prepared.artifact.provenance,
        source: "huddle_topic_segments_deterministic",
        generationImplemented: true,
      },
      metadata: {
        orchestrationOnly: false,
        generationImplemented: true,
        generationState: "generated",
      },
    },
    client,
  });
  return {
    orchestrationOnly: false,
    generationImplemented: true,
    artifactId: completed.artifact.id,
    entryCount: timelineEntries.length,
  };
}

async function processOwnershipResolution(job, client = null) {
  const result = await createOwnershipSuggestions({ job, client });
  return {
    orchestrationOnly: false,
    generationImplemented: true,
    ownershipState: "pending_approval",
    ...result,
  };
}

async function processMeetingDigest(job, client = null) {
  const actor = jobActor(job);
  const [artifacts, delivery, riskBlockerItems, topicSegments] = await Promise.all([
    listHuddleArtifacts({
      workspaceId: job.workspaceId,
      sessionId: job.sessionId,
      ...actor,
      includeDeleted: false,
      limit: 100,
      client,
    }),
    getMeetingIntelligenceDeliveryContext({
      workspaceId: job.workspaceId,
      sessionId: job.sessionId,
      client,
    }),
    listRiskBlockerItems({ workspaceId: job.workspaceId, sessionId: job.sessionId, client }),
    listTopicSegments({ workspaceId: job.workspaceId, sessionId: job.sessionId, client }),
  ]);
  const latestReady = (type) =>
    artifacts.find(
      (artifact) => artifact.artifactType === type && artifact.status === "ready"
    ) || null;
  const transcript = latestReady("transcript");
  const summary = latestReady("summary");
  const decisions = latestReady("decision");
  const actions = latestReady("action_item");
  const timeline = latestReady("timeline");
  const decisionCount = Array.isArray(decisions?.contentJson?.decisions)
    ? decisions.contentJson.decisions.length
    : 0;
  const actionItemCount = Array.isArray(actions?.contentJson?.actionItems)
    ? actions.contentJson.actionItems.length
    : 0;
  const riskCount = riskBlockerItems.filter((item) => item.itemType === "risk").length;
  const blockerCount = riskBlockerItems.filter((item) => item.itemType === "blocker").length;
  const reviewPath = `/huddles/${job.sessionId}/intelligence`;
  const summaryLabel = summary
    ? "summary available"
    : transcript
      ? "transcript available"
      : "transcript not captured";
  const result = await upsertMeetingDigest({
    workspaceId: job.workspaceId,
    sessionId: job.sessionId,
    ...actor,
    input: {
      digestType: "post_meeting",
      status: "ready",
      summaryArtifactId: summary?.id,
      decisionsArtifactId: decisions?.id,
      actionsArtifactId: actions?.id,
      timelineArtifactId: timeline?.id,
      generatedByJobId: job.id,
      digest: {
        schemaVersion: 2,
        generationState: "ready_for_review",
        summaryAvailable: Boolean(summary),
        transcriptAvailable: Boolean(transcript),
        decisionCount,
        actionItemCount,
        riskCount,
        blockerCount,
        topicSegmentCount: topicSegments.length,
        reviewPath,
        transcriptUnavailableReason:
          job.input?.transcriptUnavailableReason ||
          job.provenance?.transcriptUnavailableReason ||
          null,
      },
      provenance: {
        source: "huddle_intelligence_worker",
        sourceJobId: job.id,
        transcriptArtifactId: job.artifactId || null,
        transcriptAvailable: Boolean(transcript),
        transcriptUnavailableReason:
          job.input?.transcriptUnavailableReason ||
          job.provenance?.transcriptUnavailableReason ||
          null,
        summaryArtifactId: summary?.id || null,
        decisionsArtifactId: decisions?.id || null,
        actionsArtifactId: actions?.id || null,
      },
      metadata: {
        orchestrationOnly: false,
        deliveryImplemented: true,
        taskCreationEnabled: false,
      },
    },
    client,
  });

  await Promise.all(
    delivery.participantUserIds.map((userId) =>
      notifyUser({
        user_id: userId,
        workspaceId: job.workspaceId,
        type: "huddle_intelligence_ready",
        title: "Meeting intelligence is ready",
        message: `${delivery.title}: ${summaryLabel}, ${decisionCount} decision${decisionCount === 1 ? "" : "s"}, ${actionItemCount} action item${actionItemCount === 1 ? "" : "s"}${riskCount + blockerCount > 0 ? `, ${riskCount} risk${riskCount === 1 ? "" : "s"} & ${blockerCount} blocker${blockerCount === 1 ? "" : "s"}` : ""}.`,
        action_url: reviewPath,
        source_key: `huddle-intelligence:${job.sessionId}:${userId}`,
        metadata: {
          sessionId: job.sessionId,
          meetingTitle: delivery.title,
          summaryAvailable: Boolean(summary),
          transcriptAvailable: Boolean(transcript),
          transcriptUnavailableReason:
            job.input?.transcriptUnavailableReason ||
            job.provenance?.transcriptUnavailableReason ||
            null,
          decisionCount,
          actionItemCount,
          riskCount,
          blockerCount,
          meetingDigestId: result.meetingDigest.id,
        },
      })
    )
  );

  return {
    orchestrationOnly: false,
    generationImplemented: false,
    deliveryImplemented: true,
    generationState: "ready_for_review",
    meetingDigestId: result.meetingDigest.id,
    notificationCount: delivery.participantUserIds.length,
    reviewPath,
    summaryAvailable: Boolean(summary),
    transcriptAvailable: Boolean(transcript),
    decisionCount,
    actionItemCount,
  };
}

async function processFrameworkOnlyJob(job) {
  if (job.jobType === HUDDLE_INTELLIGENCE_JOB_TYPES.CAPTION_GENERATION) {
    return {
      orchestrationOnly: true,
      providerPipeline: "canonical_transcript_segments",
      captionsGeneratedByIngestion: true,
    };
  }
  if (job.jobType === HUDDLE_INTELLIGENCE_JOB_TYPES.MEMORY_PROMOTION) {
    return {
      orchestrationOnly: true,
      automaticPromotionEnabled: false,
      promotionState: "awaiting_approval",
    };
  }
  return {
    orchestrationOnly: true,
    generationImplemented: false,
  };
}

async function processClaimedJob(job, client = null) {
  if (job.jobType === HUDDLE_INTELLIGENCE_JOB_TYPES.TRANSCRIPT_FINALIZATION) {
    return processTranscriptFinalization(job, client);
  }
  if (job.jobType === HUDDLE_INTELLIGENCE_JOB_TYPES.LANGUAGE_NORMALIZATION) {
    return processLanguageNormalization(job, client);
  }
  if (job.jobType === HUDDLE_INTELLIGENCE_JOB_TYPES.TOPIC_SEGMENTATION) {
    return processTopicSegmentation(job, client);
  }
  if (job.jobType === HUDDLE_INTELLIGENCE_JOB_TYPES.RISK_BLOCKER_EXTRACTION) {
    return processRiskBlockerExtraction(job, client);
  }
  if (job.jobType === HUDDLE_INTELLIGENCE_JOB_TYPES.TIMELINE_GENERATION) {
    return processTimelineGeneration(job, client);
  }
  if (ARTIFACT_JOB_TYPES[job.jobType]) {
    return processArtifactPreparation(job, client);
  }
  if (job.jobType === HUDDLE_INTELLIGENCE_JOB_TYPES.OWNERSHIP_RESOLUTION) {
    return processOwnershipResolution(job, client);
  }
  if (job.jobType === HUDDLE_INTELLIGENCE_JOB_TYPES.MEETING_DIGEST_GENERATION) {
    return processMeetingDigest(job, client);
  }
  return processFrameworkOnlyJob(job);
}

export function getHuddleIntelligenceWorkerDiagnostics() {
  const generation = getHuddleIntelligenceGenerationDiagnostics();
  return {
    ready: true,
    architectureOnly: false,
    orchestrationEnabled: true,
    generationEnabled: generation.generationEnabled,
    sttProviderEnabled: true,
    retryRecoveryEnabled: true,
    dependencySchedulingEnabled: true,
    attemptAuditEnabled: true,
    orchestrationVersion: ORCHESTRATION_VERSION,
    generation,
    supportedJobTypes: Object.values(HUDDLE_INTELLIGENCE_JOB_TYPES),
    handlers: Object.fromEntries(
      Object.values(HUDDLE_INTELLIGENCE_JOB_TYPES).map((jobType) => [
        jobType,
        {
          registered: true,
          generationImplemented:
            [
              HUDDLE_INTELLIGENCE_JOB_TYPES.LANGUAGE_NORMALIZATION,
              HUDDLE_INTELLIGENCE_JOB_TYPES.TOPIC_SEGMENTATION,
              HUDDLE_INTELLIGENCE_JOB_TYPES.SUMMARY_GENERATION,
              HUDDLE_INTELLIGENCE_JOB_TYPES.DECISION_EXTRACTION,
              HUDDLE_INTELLIGENCE_JOB_TYPES.ACTION_ITEM_EXTRACTION,
              HUDDLE_INTELLIGENCE_JOB_TYPES.RISK_BLOCKER_EXTRACTION,
              HUDDLE_INTELLIGENCE_JOB_TYPES.TIMELINE_GENERATION,
              HUDDLE_INTELLIGENCE_JOB_TYPES.OWNERSHIP_RESOLUTION,
            ].includes(jobType),
          orchestrationOnly:
            ![
              HUDDLE_INTELLIGENCE_JOB_TYPES.LANGUAGE_NORMALIZATION,
              HUDDLE_INTELLIGENCE_JOB_TYPES.TOPIC_SEGMENTATION,
              HUDDLE_INTELLIGENCE_JOB_TYPES.SUMMARY_GENERATION,
              HUDDLE_INTELLIGENCE_JOB_TYPES.DECISION_EXTRACTION,
              HUDDLE_INTELLIGENCE_JOB_TYPES.ACTION_ITEM_EXTRACTION,
              HUDDLE_INTELLIGENCE_JOB_TYPES.RISK_BLOCKER_EXTRACTION,
              HUDDLE_INTELLIGENCE_JOB_TYPES.TIMELINE_GENERATION,
              HUDDLE_INTELLIGENCE_JOB_TYPES.OWNERSHIP_RESOLUTION,
            ].includes(jobType),
          preparesArtifact: Boolean(ARTIFACT_JOB_TYPES[jobType]),
        },
      ])
    ),
    intelligence: getHuddleIntelligenceDiagnostics(),
  };
}

export async function runHuddleIntelligenceJobOnce({
  workerId = "huddle-intelligence-worker",
  jobTypes = Object.values(HUDDLE_INTELLIGENCE_JOB_TYPES),
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  client = null,
} = {}) {
  const job = await claimNextIntelligenceJob({
    workerId,
    jobTypes,
    leaseSeconds,
    client,
  });

  if (!job) {
    return { ok: true, claimed: false, reason: "no_queued_job" };
  }

  try {
    await heartbeatIntelligenceJob({
      workspaceId: job.workspaceId,
      jobId: job.id,
      workerId,
      leaseSeconds,
      client,
    });
    const output = await processClaimedJob(job, client);
    const result = await completeIntelligenceJob({
      workspaceId: job.workspaceId,
      jobId: job.id,
      output,
      outputArtifactId: output.artifactId || null,
      metadata: {
        orchestrationOnly: output.orchestrationOnly !== false,
        generationImplemented: Boolean(output.generationImplemented),
        workerId,
      },
      client,
    });
    return {
      ok: true,
      claimed: true,
      processed: true,
      job: result.job,
      output,
    };
  } catch (error) {
    const retry = error?.retryable !== false && job.attemptCount < job.maxAttempts;
    const retryDelaySeconds = Math.min(15 * (2 ** Math.max(job.attemptCount - 1, 0)), 900);
    const result = await failIntelligenceJob({
      workspaceId: job.workspaceId,
      jobId: job.id,
      errorCode: safeString(error?.reason || error?.code) || "intelligence_job_failed",
      errorMessage: safeString(error?.message) || "Huddle Intelligence orchestration failed.",
      retry,
      retryDelaySeconds,
      metadata: {
        orchestrationOnly: true,
        generationImplemented: false,
        workerId,
      },
      client,
    });
    return {
      ok: false,
      claimed: true,
      processed: false,
      retryScheduled: result.job.status === "queued",
      job: result.job,
      reason: result.job.errorCode,
    };
  }
}

export async function runHuddleIntelligenceWorkerCycle({
  workerId = "huddle-intelligence-worker",
  batchSize = DEFAULT_BATCH_SIZE,
  client = null,
} = {}) {
  const recovery = await recoverStaleIntelligenceJobs({ client });
  const results = [];
  const size = Math.min(Math.max(Number(batchSize) || DEFAULT_BATCH_SIZE, 1), 50);
  for (let index = 0; index < size; index += 1) {
    const result = await runHuddleIntelligenceJobOnce({ workerId, client });
    results.push(result);
    if (!result.claimed) break;
  }
  return {
    ok: results.every((result) => result.ok || result.retryScheduled),
    recovery,
    claimedCount: results.filter((result) => result.claimed).length,
    processedCount: results.filter((result) => result.processed).length,
    results,
  };
}

export async function completeArchitectureOnlyJob({
  workspaceId,
  jobId,
  output = {},
  metadata = {},
  client = null,
}) {
  return completeIntelligenceJob({
    workspaceId,
    jobId,
    output: {
      orchestrationOnly: true,
      generationImplemented: false,
      ...output,
    },
    metadata: {
      generationImplemented: false,
      ...metadata,
    },
    client,
  });
}

export default {
  getHuddleIntelligenceWorkerDiagnostics,
  runHuddleIntelligenceJobOnce,
  runHuddleIntelligenceWorkerCycle,
  completeArchitectureOnlyJob,
};
