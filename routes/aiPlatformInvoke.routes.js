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
    const { capability, prompt, messages, workspaceId, overrides, trigger, sourceModule, tools, variables } = req.body || {};
    const out = await externalInvoke({
      capability, prompt, messages, workspaceId,
      overrides: overrides || {}, trigger: trigger || null,
      sourceModule: sourceModule || "external:ai-task",
      tools: tools || null,
      variables: variables || null,
    });
    res.json(out);
  } catch (e) {
    // A safety block is a DECISION, not a failure, and must be distinguishable.
    // Callers fall back to a direct provider when the platform errors; if a
    // block looked like an ordinary 500 they would retry the same input with no
    // safety layer at all, and the block would achieve nothing. 422 + an
    // explicit code lets the caller refuse instead of falling back.
    if (e?.code === "AI_SAFETY_BLOCKED") {
      return res.status(422).json({ error: e.message, code: "AI_SAFETY_BLOCKED", safety: e.safety ?? null });
    }
    res.status(500).json({ error: e.message });
  }
});

export default router;
