import express from "express";
import {
  listHuddleCallTrace,
  normalizeCallDeliveryStep,
  recordHuddleCallStep,
} from "../services/huddleCallDeliveryTrace.service.js";

const router = express.Router();

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

router.post("/events", async (req, res) => {
  const body = req.body || {};
  const step = normalizeCallDeliveryStep(body.step);
  const huddleId = safeString(body.huddleId || body.huddle_id);
  if (!step || !huddleId) {
    return res.status(400).json({ ok: false, reason: "invalid_call_delivery_trace_event" });
  }

  const result = await recordHuddleCallStep({
    ...body,
    workspaceId: req.workspaceId,
    actorUserId: req.user?.id,
    metadata: {
      ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
      userAgent: req.get("user-agent") || null,
    },
  });

  if (!result.ok) {
    return res.status(202).json({ ok: false, reason: result.reason });
  }
  return res.status(202).json({ ok: true, eventId: result.event?.id || null });
});

router.get("/events", async (req, res) => {
  const result = await listHuddleCallTrace({
    workspaceId: req.workspaceId,
    sessionId: req.query.sessionId || req.query.session_id || null,
    huddleId: req.query.huddleId || req.query.huddle_id || null,
    limit: req.query.limit,
  });
  if (!result.ok) {
    return res.status(400).json({ ok: false, reason: result.reason, events: [] });
  }
  return res.json({ ok: true, events: result.events });
});

export default router;
