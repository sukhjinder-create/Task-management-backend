// routes/aiPlatformInvoke.routes.js
//
// The single external entry point into the AI Platform: POST /ai/invoke.
// Internal-service-secret guarded. External services (ai-task, and any future
// service) call this instead of talking to a provider directly, so there is
// exactly ONE provider selection / prompt resolution / safety / telemetry / cost
// path in the whole ecosystem.
//
// Mounted in index.js: app.use("/ai", aiPlatformInvokeRoutes)

import express from "express";
import { requireInternalServiceSecret } from "../config/secrets.js";
import { externalInvoke } from "../ai-platform/api/invokeService.js";

const router = express.Router();

router.post("/invoke", requireInternalServiceSecret, async (req, res) => {
  try {
    const { capability, prompt, messages, workspaceId, overrides, trigger, sourceModule } = req.body || {};
    const out = await externalInvoke({
      capability, prompt, messages, workspaceId,
      overrides: overrides || {}, trigger: trigger || null,
      sourceModule: sourceModule || "external:ai-task",
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
