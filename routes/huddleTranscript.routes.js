import express from "express";
import {
  createTranscriptSegment,
  finalizeTranscriptSegment,
  getHuddleTranscriptDiagnostics,
  getTranscriptSegment,
  listTranscriptEvents,
  listTranscriptSegments,
  updateTranscriptSegment,
} from "../services/huddleTranscript.service.js";

const router = express.Router();

function errorResponse(res, error) {
  const status = error?.statusCode || 500;
  const reason = error?.reason || error?.message || "huddle_transcript_error";
  if (status >= 500) {
    console.error("[huddle:transcript]", error);
  }
  return res.status(status).json({
    ok: false,
    reason,
  });
}

function actor(req) {
  return {
    actorUserId: req.user?.id,
    role: req.user?.role || "user",
  };
}

router.get("/diagnostics", (_req, res) => {
  res.json({
    ok: true,
    transcript: getHuddleTranscriptDiagnostics(),
  });
});

router.get("/sessions/:sessionId/segments", async (req, res) => {
  try {
    const segments = await listTranscriptSegments({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      status: req.query.status,
      sourceProvider: req.query.sourceProvider,
      after: req.query.after,
      includeRetracted: req.query.includeRetracted === "true",
      limit: req.query.limit,
    });
    res.json({ ok: true, segments });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/sessions/:sessionId/segments", async (req, res) => {
  try {
    const result = await createTranscriptSegment({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      input: req.body || {},
    });
    res.status(result.idempotentUpdate ? 200 : 201).json({
      ok: true,
      ...result,
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/sessions/:sessionId/events", async (req, res) => {
  try {
    const events = await listTranscriptEvents({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      after: req.query.after,
      limit: req.query.limit,
    });
    res.json({ ok: true, events });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/segments/:segmentId", async (req, res) => {
  try {
    const segment = await getTranscriptSegment({
      workspaceId: req.workspaceId,
      segmentId: req.params.segmentId,
      ...actor(req),
    });
    res.json({ ok: true, segment });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.patch("/segments/:segmentId", async (req, res) => {
  try {
    const result = await updateTranscriptSegment({
      workspaceId: req.workspaceId,
      segmentId: req.params.segmentId,
      ...actor(req),
      patch: req.body || {},
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/segments/:segmentId/finalize", async (req, res) => {
  try {
    const result = await finalizeTranscriptSegment({
      workspaceId: req.workspaceId,
      segmentId: req.params.segmentId,
      ...actor(req),
      patch: req.body || {},
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

export default router;
