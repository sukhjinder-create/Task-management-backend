import {
  HUDDLE_INTELLIGENCE_JOB_TYPES,
  claimNextIntelligenceJob,
  completeIntelligenceJob,
  createMeetingDigest,
  enqueueIntelligenceJob,
  failIntelligenceJob,
  getHuddleIntelligenceDiagnostics,
  heartbeatIntelligenceJob,
  recoverStaleIntelligenceJobs,
} from "./huddleIntelligence.service.js";
import {
  createHuddleArtifact,
  listHuddleArtifacts,
} from "./huddleArtifact.service.js";
import { finalizeHuddleTranscript } from "./huddleTranscriptionPipeline.service.js";

const ORCHESTRATION_VERSION = 1;
const DEFAULT_LEASE_SECONDS = 90;
const DEFAULT_BATCH_SIZE = 10;

const ARTIFACT_JOB_TYPES = Object.freeze({
  [HUDDLE_INTELLIGENCE_JOB_TYPES.SUMMARY_GENERATION]: "summary",
  [HUDDLE_INTELLIGENCE_JOB_TYPES.DECISION_EXTRACTION]: "decision",
  [HUDDLE_INTELLIGENCE_JOB_TYPES.ACTION_ITEM_EXTRACTION]: "action_item",
  [HUDDLE_INTELLIGENCE_JOB_TYPES.TIMELINE_GENERATION]: "timeline",
});

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
  const existing = artifacts.find((artifact) =>
    !["failed", "archived", "superseded", "deleted"].includes(artifact.status)
  );
  if (existing) return { artifact: existing, created: false };

  const transcriptArtifactId =
    job.artifactId ||
    job.input?.transcriptArtifactId ||
    null;
  const approvalRequired = ["decision", "action_item"].includes(artifactType);
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

  const summary = await enqueueIntelligenceJob({
    ...base,
    jobType: HUDDLE_INTELLIGENCE_JOB_TYPES.SUMMARY_GENERATION,
    idempotencyKey: `summary:${transcriptArtifactId}:v${ORCHESTRATION_VERSION}`,
  });
  const decisions = await enqueueIntelligenceJob({
    ...base,
    jobType: HUDDLE_INTELLIGENCE_JOB_TYPES.DECISION_EXTRACTION,
    idempotencyKey: `decisions:${transcriptArtifactId}:v${ORCHESTRATION_VERSION}`,
  });
  const actions = await enqueueIntelligenceJob({
    ...base,
    jobType: HUDDLE_INTELLIGENCE_JOB_TYPES.ACTION_ITEM_EXTRACTION,
    idempotencyKey: `actions:${transcriptArtifactId}:v${ORCHESTRATION_VERSION}`,
  });
  const timeline = await enqueueIntelligenceJob({
    ...base,
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
      timeline.job.id,
    ],
  });

  return {
    summaryJobId: summary.job.id,
    decisionJobId: decisions.job.id,
    actionItemJobId: actions.job.id,
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
  return {
    orchestrationOnly: true,
    generationImplemented: false,
    generationState: "awaiting_generator",
    artifactType,
    artifactId: prepared.artifact.id,
    artifactCreated: prepared.created,
  };
}

async function processOwnershipResolution(job) {
  return {
    orchestrationOnly: true,
    generationImplemented: false,
    ownershipState: "awaiting_generated_action_items",
    approvalRequired: true,
    taskCreationEnabled: false,
  };
}

async function processMeetingDigest(job, client = null) {
  const actor = jobActor(job);
  const result = await createMeetingDigest({
    workspaceId: job.workspaceId,
    sessionId: job.sessionId,
    ...actor,
    input: {
      digestType: "post_meeting",
      status: "draft",
      generatedByJobId: job.id,
      digest: {
        generationState: "awaiting_generated_artifacts",
      },
      provenance: {
        source: "huddle_intelligence_worker",
        sourceJobId: job.id,
        transcriptArtifactId: job.artifactId || null,
      },
      metadata: {
        orchestrationOnly: true,
        generationImplemented: false,
      },
    },
    client,
  });
  return {
    orchestrationOnly: true,
    generationImplemented: false,
    generationState: "awaiting_generated_artifacts",
    meetingDigestId: result.meetingDigest.id,
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
  if (ARTIFACT_JOB_TYPES[job.jobType]) {
    return processArtifactPreparation(job, client);
  }
  if (job.jobType === HUDDLE_INTELLIGENCE_JOB_TYPES.OWNERSHIP_RESOLUTION) {
    return processOwnershipResolution(job);
  }
  if (job.jobType === HUDDLE_INTELLIGENCE_JOB_TYPES.MEETING_DIGEST_GENERATION) {
    return processMeetingDigest(job, client);
  }
  return processFrameworkOnlyJob(job);
}

export function getHuddleIntelligenceWorkerDiagnostics() {
  return {
    ready: true,
    architectureOnly: false,
    orchestrationEnabled: true,
    generationEnabled: false,
    sttProviderEnabled: true,
    retryRecoveryEnabled: true,
    dependencySchedulingEnabled: true,
    attemptAuditEnabled: true,
    orchestrationVersion: ORCHESTRATION_VERSION,
    supportedJobTypes: Object.values(HUDDLE_INTELLIGENCE_JOB_TYPES),
    handlers: Object.fromEntries(
      Object.values(HUDDLE_INTELLIGENCE_JOB_TYPES).map((jobType) => [
        jobType,
        {
          registered: true,
          generationImplemented: false,
          orchestrationOnly: true,
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
        orchestrationOnly: true,
        generationImplemented: false,
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
