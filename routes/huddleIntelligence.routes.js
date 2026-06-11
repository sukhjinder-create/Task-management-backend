import express from "express";
import {
  cancelIntelligenceJob,
  correctSpeakerAttribution,
  createCaptionEvent,
  createMemoryCandidate,
  createMeetingDigest,
  createOwnershipResolution,
  createRetentionPolicy,
  createTimelineEntry,
  enqueueIntelligenceJob,
  getArtifactProcessingState,
  getHuddleIntelligenceDiagnostics,
  getIntelligenceJob,
  getTranscriptProcessingState,
  listCaptionEvents,
  listConsentRecords,
  listIntelligenceJobs,
  listIntelligenceJobAttempts,
  listIntelligenceJobDependencies,
  listMemoryCandidates,
  listMeetingDigests,
  listOwnershipResolutions,
  listRetentionPolicies,
  listTimelineEntries,
  recordIntelligenceConsent,
  recordSpeakerAttribution,
  updateMemoryCandidate,
  updateOwnershipResolution,
  updateTranscriptProcessingState,
} from "../services/huddleIntelligence.service.js";
import {
  getHuddleIntelligenceWorkerDiagnostics,
} from "../services/huddleIntelligenceWorker.service.js";
import { allowRoles } from "../middleware/role.middleware.js";

const router = express.Router();
const requireIntelligenceWriteAccess = allowRoles("admin", "manager", "owner");

function actor(req) {
  return {
    actorUserId: req.user?.id,
    role: req.user?.role || "user",
  };
}

function errorResponse(res, error) {
  const status = error?.statusCode || 500;
  const reason = error?.reason || error?.message || "huddle_intelligence_error";
  if (status >= 500) {
    console.error("[huddle:intelligence]", error);
  }
  return res.status(status).json({ ok: false, reason });
}

router.get("/diagnostics", (_req, res) => {
  res.json({
    ok: true,
    intelligence: getHuddleIntelligenceDiagnostics(),
    worker: getHuddleIntelligenceWorkerDiagnostics(),
  });
});

router.get("/worker/diagnostics", (_req, res) => {
  res.json({
    ok: true,
    worker: getHuddleIntelligenceWorkerDiagnostics(),
  });
});

router.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }
  return requireIntelligenceWriteAccess(req, res, next);
});

router.get("/jobs/:jobId", async (req, res) => {
  try {
    const job = await getIntelligenceJob({
      workspaceId: req.workspaceId,
      jobId: req.params.jobId,
      ...actor(req),
    });
    res.json({ ok: true, job });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/jobs/:jobId/cancel", async (req, res) => {
  try {
    const result = await cancelIntelligenceJob({
      workspaceId: req.workspaceId,
      jobId: req.params.jobId,
      ...actor(req),
      reason: req.body?.reason,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/sessions/:sessionId/jobs", async (req, res) => {
  try {
    const jobs = await listIntelligenceJobs({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      jobType: req.query.jobType,
      status: req.query.status,
      artifactId: req.query.artifactId,
      limit: req.query.limit,
    });
    res.json({ ok: true, jobs });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/sessions/:sessionId/jobs", async (req, res) => {
  try {
    const result = await enqueueIntelligenceJob({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      jobType: req.body?.jobType || req.body?.job_type,
      artifactId: req.body?.artifactId || req.body?.artifact_id,
      outputArtifactId: req.body?.outputArtifactId || req.body?.output_artifact_id,
      transcriptSegmentId: req.body?.transcriptSegmentId || req.body?.transcript_segment_id,
      priority: req.body?.priority,
      version: req.body?.version,
      maxAttempts: req.body?.maxAttempts || req.body?.max_attempts,
      scheduledAt: req.body?.scheduledAt || req.body?.scheduled_at,
      idempotencyKey: req.body?.idempotencyKey || req.body?.idempotency_key,
      input: req.body?.input,
      provenance: req.body?.provenance,
      metadata: req.body?.metadata,
      dependsOnJobIds: req.body?.dependsOnJobIds || req.body?.depends_on_job_ids,
      dependencyType: req.body?.dependencyType || req.body?.dependency_type,
    });
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/sessions/:sessionId/jobs/:jobId/attempts", async (req, res) => {
  try {
    const attempts = await listIntelligenceJobAttempts({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      jobId: req.params.jobId,
      ...actor(req),
    });
    res.json({ ok: true, attempts });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/sessions/:sessionId/jobs/:jobId/dependencies", async (req, res) => {
  try {
    const dependencies = await listIntelligenceJobDependencies({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      jobId: req.params.jobId,
      ...actor(req),
    });
    res.json({ ok: true, dependencies });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/sessions/:sessionId/transcript-processing", async (req, res) => {
  try {
    const state = await getTranscriptProcessingState({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
    });
    res.json({ ok: true, state });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/sessions/:sessionId/transcript-processing", async (req, res) => {
  try {
    const result = await updateTranscriptProcessingState({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      status: req.body?.status,
      sourceProvider: req.body?.sourceProvider || req.body?.source_provider,
      segmentStatus: req.body?.segmentStatus || req.body?.segment_status,
      lastSegmentId: req.body?.lastSegmentId || req.body?.last_segment_id,
      provenance: req.body?.provenance,
      diagnostics: req.body?.diagnostics,
      metadata: req.body?.metadata,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/sessions/:sessionId/artifacts/:artifactId/processing", async (req, res) => {
  try {
    const state = await getArtifactProcessingState({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      artifactId: req.params.artifactId,
      ...actor(req),
    });
    res.json({ ok: true, state });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/sessions/:sessionId/speaker-attributions", async (req, res) => {
  try {
    const result = await recordSpeakerAttribution({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      input: req.body || {},
    });
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/sessions/:sessionId/speaker-attributions/:attributionId/correct", async (req, res) => {
  try {
    const result = await correctSpeakerAttribution({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      attributionId: req.params.attributionId,
      ...actor(req),
      correction: req.body || {},
    });
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/sessions/:sessionId/captions", async (req, res) => {
  try {
    const captions = await listCaptionEvents({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      after: req.query.after,
      replayableOnly: req.query.replayableOnly !== "false",
      limit: req.query.limit,
    });
    res.json({ ok: true, captions });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/sessions/:sessionId/captions", async (req, res) => {
  try {
    const result = await createCaptionEvent({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      input: req.body || {},
    });
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/sessions/:sessionId/timeline", async (req, res) => {
  try {
    const timeline = await listTimelineEntries({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      entryType: req.query.entryType,
      limit: req.query.limit,
    });
    res.json({ ok: true, timeline });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/sessions/:sessionId/timeline", async (req, res) => {
  try {
    const result = await createTimelineEntry({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      input: req.body || {},
    });
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/sessions/:sessionId/ownership", async (req, res) => {
  try {
    const ownership = await listOwnershipResolutions({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      limit: req.query.limit,
    });
    res.json({ ok: true, ownership });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/sessions/:sessionId/ownership", async (req, res) => {
  try {
    const result = await createOwnershipResolution({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      input: req.body || {},
    });
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.patch("/sessions/:sessionId/ownership/:ownershipResolutionId", async (req, res) => {
  try {
    const result = await updateOwnershipResolution({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ownershipResolutionId: req.params.ownershipResolutionId,
      ...actor(req),
      patch: req.body || {},
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/sessions/:sessionId/memory-candidates", async (req, res) => {
  try {
    const memoryCandidates = await listMemoryCandidates({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      limit: req.query.limit,
    });
    res.json({ ok: true, memoryCandidates });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/sessions/:sessionId/memory-candidates", async (req, res) => {
  try {
    const result = await createMemoryCandidate({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      input: req.body || {},
    });
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.patch("/sessions/:sessionId/memory-candidates/:memoryCandidateId", async (req, res) => {
  try {
    const result = await updateMemoryCandidate({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      memoryCandidateId: req.params.memoryCandidateId,
      ...actor(req),
      patch: req.body || {},
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/sessions/:sessionId/digests", async (req, res) => {
  try {
    const digests = await listMeetingDigests({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      limit: req.query.limit,
    });
    res.json({ ok: true, digests });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/sessions/:sessionId/digests", async (req, res) => {
  try {
    const result = await createMeetingDigest({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      input: req.body || {},
    });
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/sessions/:sessionId/consent", async (req, res) => {
  try {
    const consent = await listConsentRecords({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      limit: req.query.limit,
    });
    res.json({ ok: true, consent });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/sessions/:sessionId/consent", async (req, res) => {
  try {
    const result = await recordIntelligenceConsent({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      input: req.body || {},
    });
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/sessions/:sessionId/retention", async (req, res) => {
  try {
    const retention = await listRetentionPolicies({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      limit: req.query.limit,
    });
    res.json({ ok: true, retention });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/sessions/:sessionId/retention", async (req, res) => {
  try {
    const result = await createRetentionPolicy({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      input: req.body || {},
    });
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

export default router;
