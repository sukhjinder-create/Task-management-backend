import express from "express";
import { allowRoles } from "../middleware/role.middleware.js";
import { findHuddleSessionByLegacy } from "../services/huddleSession.service.js";
import {
  finalizeHuddleTranscript,
  getEffectiveTranscriptionPolicy,
  getHuddleTranscriptionDiagnostics,
  getTranscriptionSessionDiagnostics,
  grantTranscriptionProviderToken,
  ingestTranscriptionProviderEvent,
  upsertTranscriptionPolicy,
} from "../services/huddleTranscriptionPipeline.service.js";

const router = express.Router();
const requireTranscriptionAdmin = allowRoles("admin", "manager", "owner");
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function actor(req) {
  return {
    actorUserId: req.user?.id,
    role: req.user?.role || "user",
  };
}

function errorResponse(res, error) {
  const status = error?.statusCode || 500;
  const reason = error?.reason || error?.message || "huddle_transcription_error";
  if (status >= 500) {
    console.error("[huddle:transcription]", error);
  }
  return res.status(status).json({ ok: false, reason });
}

router.param("sessionId", async (req, res, next, rawSessionId) => {
  try {
    const sessionId = String(rawSessionId || "").trim();
    if (UUID_PATTERN.test(sessionId)) {
      req.params.sessionId = sessionId;
      return next();
    }

    const session = await findHuddleSessionByLegacy({
      workspaceId: req.workspaceId,
      legacyHuddleId: sessionId,
    });
    if (!session) {
      return res.status(404).json({ ok: false, reason: "huddle_session_not_found" });
    }

    req.params.sessionId = session.id;
    req.huddleLegacySessionId = sessionId;
    return next();
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get("/diagnostics", (_req, res) => {
  res.json({
    ok: true,
    transcription: getHuddleTranscriptionDiagnostics(),
  });
});

router.get("/sessions/:sessionId/diagnostics", async (req, res) => {
  try {
    const diagnostics = await getTranscriptionSessionDiagnostics({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
    });
    res.json({ ok: true, diagnostics });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/sessions/:sessionId/policy", async (req, res) => {
  try {
    const policy = await getEffectiveTranscriptionPolicy({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
    });
    res.json({ ok: true, policy });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/sessions/:sessionId/policy", requireTranscriptionAdmin, async (req, res) => {
  try {
    const result = await upsertTranscriptionPolicy({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      input: req.body || {},
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/workspace/policy", requireTranscriptionAdmin, async (req, res) => {
  try {
    const result = await upsertTranscriptionPolicy({
      workspaceId: req.workspaceId,
      ...actor(req),
      input: req.body || {},
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/sessions/:sessionId/grant", async (req, res) => {
  try {
    const result = await grantTranscriptionProviderToken({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      participantId: req.body?.participantId || req.body?.participant_id,
      language: req.body?.language,
      provider: req.body?.provider,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/sessions/:sessionId/events", async (req, res) => {
  try {
    const result = await ingestTranscriptionProviderEvent({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      transcriptionSessionId:
        req.body?.transcriptionSessionId || req.body?.transcription_session_id,
      input: req.body || {},
    });
    res.status(result.ignored ? 202 : 201).json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/sessions/:sessionId/finalize", requireTranscriptionAdmin, async (req, res) => {
  try {
    const result = await finalizeHuddleTranscript({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      reason: req.body?.reason || "manual_finalization",
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

export default router;
