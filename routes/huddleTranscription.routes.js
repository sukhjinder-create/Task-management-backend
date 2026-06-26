import express from "express";
import { allowRoles } from "../middleware/role.middleware.js";
import { getIO } from "../realtime/socket.js";
import { findHuddleSessionByLegacy } from "../services/huddleSession.service.js";
import {
  finalizeHuddleTranscript,
  getEffectiveTranscriptionPolicy,
  getHuddleTranscriptionDiagnostics,
  getTranscriptionSessionDiagnostics,
  grantTranscriptionProviderToken,
  ingestTranscriptionProviderEvent,
  listActiveSessionParticipantUserIds,
  upsertTranscriptionPolicy,
} from "../services/huddleTranscriptionPipeline.service.js";

// One push point for the canonical caption pipeline: every platform (web,
// Android, mobile browser) posts Deepgram results through the same
// /sessions/:sessionId/events endpoint, so broadcasting from here covers all
// of them identically instead of each platform needing its own delivery
// mechanism. Push, not poll — every participant's personal userId room
// (joined unconditionally on socket connect) gets the caption the instant
// it's written, regardless of which page they currently have open.
async function broadcastCaptionIfPresent({ workspaceId, sessionId, result }) {
  const caption = result?.caption;
  if (!caption) return;
  try {
    const io = getIO();
    const userIds = await listActiveSessionParticipantUserIds({ workspaceId, sessionId });
    if (!userIds.length) return;
    const payload = {
      ...caption,
      speaker: {
        ...(caption.speaker || {}),
        label: caption.speaker?.label || result?.segment?.speaker?.label || null,
        userId: caption.speaker?.userId || result?.segment?.speaker?.userId || null,
        guestId: caption.speaker?.guestId || result?.segment?.speaker?.guestId || null,
      },
    };
    for (const userId of userIds) {
      io.to(userId).emit("huddle:caption", { sessionId, caption: payload });
    }
  } catch (error) {
    console.warn("[huddle:transcription] caption broadcast failed:", error?.message || error);
  }
}

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
      audioEncoding: req.body?.audioEncoding || req.body?.audio_encoding,
      sampleRate: req.body?.sampleRate || req.body?.sample_rate,
      channels: req.body?.channels,
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
    void broadcastCaptionIfPresent({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      result,
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
