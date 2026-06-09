import {
  HUDDLE_INTELLIGENCE_JOB_TYPES,
  claimNextIntelligenceJob,
  completeIntelligenceJob,
  failIntelligenceJob,
  getHuddleIntelligenceDiagnostics,
} from "./huddleIntelligence.service.js";

const ARCHITECTURE_ONLY_REASON = "generation_not_implemented";

export function getHuddleIntelligenceWorkerDiagnostics() {
  return {
    ready: true,
    architectureOnly: true,
    generationEnabled: false,
    sttProviderEnabled: false,
    supportedJobTypes: Object.values(HUDDLE_INTELLIGENCE_JOB_TYPES),
    handlers: Object.fromEntries(
      Object.values(HUDDLE_INTELLIGENCE_JOB_TYPES).map((jobType) => [
        jobType,
        {
          registered: true,
          generationImplemented: false,
          orchestrationOnly: true,
        },
      ])
    ),
    intelligence: getHuddleIntelligenceDiagnostics(),
  };
}

export async function runHuddleIntelligenceJobOnce({
  workerId = "huddle-intelligence-worker",
  jobTypes = Object.values(HUDDLE_INTELLIGENCE_JOB_TYPES),
  failUnsupported = true,
  client = null,
} = {}) {
  const job = await claimNextIntelligenceJob({
    workerId,
    jobTypes,
    client,
  });

  if (!job) {
    return {
      ok: true,
      claimed: false,
      reason: "no_queued_job",
    };
  }

  if (!failUnsupported) {
    return {
      ok: true,
      claimed: true,
      processed: false,
      reason: ARCHITECTURE_ONLY_REASON,
      job,
    };
  }

  const result = await failIntelligenceJob({
    workspaceId: job.workspaceId,
    jobId: job.id,
    errorCode: ARCHITECTURE_ONLY_REASON,
    errorMessage:
      "Huddle Intelligence job orchestration is installed, but generation handlers are intentionally disabled.",
    retry: false,
    metadata: {
      architectureOnly: true,
      workerId,
    },
    client,
  });

  return {
    ok: true,
    claimed: true,
    processed: false,
    reason: ARCHITECTURE_ONLY_REASON,
    job: result.job,
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
      architectureOnly: true,
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
  completeArchitectureOnlyJob,
};
