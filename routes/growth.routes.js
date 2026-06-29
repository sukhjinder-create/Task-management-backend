import express from "express";
import jwt from "jsonwebtoken";
import { enqueueGrowthEvent } from "../growth/growthCollector.js";
import { normalizeGrowthEvent, requestGrowthContext } from "../growth/growthEvent.js";

const router = express.Router();
const rateBuckets = new Map();

function optionalUser(req, _res, next) {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    try {
      const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET || "task_management_secret");
      if (decoded?.role !== "superadmin") {
        req.user = {
          ...decoded,
          id: decoded.id || decoded.userId || decoded.sub,
          workspaceId: decoded.workspaceId || decoded.workspace_id,
        };
      }
    } catch {
      // Anonymous website telemetry remains valid when a user token is absent or stale.
    }
  }
  next();
}

function rateLimit(req, res, next) {
  const key = String(req.ip || "unknown");
  const now = Date.now();
  if (rateBuckets.size > 10_000) {
    for (const [bucketKey, value] of rateBuckets) {
      if (value.resetAt <= now) rateBuckets.delete(bucketKey);
    }
  }
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  bucket.count += 1;
  if (bucket.count > 120) return res.status(429).json({ error: "Telemetry rate limit exceeded" });
  return next();
}

router.post("/events", rateLimit, optionalUser, (req, res) => {
  const rawEvents = Array.isArray(req.body?.events) ? req.body.events : [req.body];
  if (!rawEvents.length || rawEvents.length > 25) {
    return res.status(400).json({ error: "Provide between 1 and 25 telemetry events" });
  }
  if (Buffer.byteLength(JSON.stringify(req.body || {}), "utf8") > 64 * 1024) {
    return res.status(413).json({ error: "Telemetry payload is too large" });
  }

  const context = requestGrowthContext(req);
  if (!context.actorUserId && !context.anonymousId && !context.sessionId) {
    return res.status(400).json({ error: "Anonymous or session identifier required" });
  }

  let accepted = 0;
  try {
    for (const raw of rawEvents) {
      const event = normalizeGrowthEvent({
        ...raw,
        ...context,
        actorUserId: context.actorUserId,
        workspaceId: context.workspaceId,
      }, { publicEvent: true });
      if (enqueueGrowthEvent(event)) accepted += 1;
    }
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  return res.status(202).json({ accepted });
});

export default router;
