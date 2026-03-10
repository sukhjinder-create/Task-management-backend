import crypto from "crypto";
import express from "express";
import {
  assertWorkspaceExists,
  autoConfigureWorkspaceGitAutomation,
  getGitProjectAutomationSettings,
  listGitAutomationEvents,
  processGitPushEvent,
  processGitWebhookEvent,
  upsertGitProjectAutomationSettings,
} from "./git.automation.service.js";

// ── Webhook secret verification ─────────────────────────────────────────────
// Each provider signs payloads differently. We verify here with the raw body
// so the service layer never needs to worry about it.
function verifyProviderSignature(provider, rawBody, headers) {
  const secret = process.env.GIT_WEBHOOK_SECRET;
  if (!secret) return true; // no secret configured → allow all (dev mode)

  if (provider === "github") {
    const sig = headers["x-hub-signature-256"];
    if (!sig) return false;
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch { return false; }
  }

  if (provider === "gitlab") {
    // GitLab sends the raw secret token in x-gitlab-token
    const token = headers["x-gitlab-token"];
    if (!token) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret));
    } catch { return false; }
  }

  if (provider === "bitbucket") {
    // Bitbucket Cloud uses x-hub-signature (SHA-256 HMAC since 2023)
    const sig = headers["x-hub-signature"];
    if (!sig) return false;
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch { return false; }
  }

  // Generic / unknown provider — fall back to a custom header
  const token = headers["x-git-webhook-secret"] || headers["x-webhook-token"];
  if (!token) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret));
  } catch { return false; }
}

export const gitAutomationRoutes = express.Router();
export const gitAutomationWebhookRoutes = express.Router();

function canManage(user) {
  return user?.role === "admin" || user?.role === "manager";
}

gitAutomationRoutes.get("/projects/:projectId/settings", async (req, res) => {
  try {
    const workspaceId = req.workspaceId;
    const { projectId } = req.params;
    const settings = await getGitProjectAutomationSettings({ workspaceId, projectId });
    res.json(settings);
  } catch (error) {
    console.error("Git automation settings load failed:", error);
    res.status(500).json({ error: "Failed to load git automation settings" });
  }
});

gitAutomationRoutes.put("/projects/:projectId/settings", async (req, res) => {
  try {
    if (!canManage(req.user)) {
      return res.status(403).json({ error: "Only admin/manager can modify git automation settings" });
    }
    const workspaceId = req.workspaceId;
    const { projectId } = req.params;
    const {
      enabled = false,
      autoStatusEnabled = true,
      autoCompleteOnProd = false,
      repoFullName = null,
      environmentSequence = ["dev", "qa", "stage", "uat", "prod"],
      branchEnvironmentMap = {},
      requireTaskKey = true,
      autoInferTasks = true,
      minInferenceConfidence = 62,
      maxInferredTasks = 2,
    } = req.body || {};

    const updated = await upsertGitProjectAutomationSettings({
      workspaceId,
      projectId,
      enabled,
      autoStatusEnabled,
      autoCompleteOnProd,
      repoFullName,
      environmentSequence,
      branchEnvironmentMap,
      requireTaskKey,
      autoInferTasks,
      minInferenceConfidence,
      maxInferredTasks,
      actorId: req.user.id,
    });

    res.json(updated);
  } catch (error) {
    console.error("Git automation settings update failed:", error);
    res.status(500).json({ error: "Failed to update git automation settings", details: error.message });
  }
});

gitAutomationRoutes.get("/events", async (req, res) => {
  try {
    if (!canManage(req.user)) {
      return res.status(403).json({ error: "Only admin/manager can view git automation events" });
    }
    const workspaceId = req.workspaceId;
    const limit = Number(req.query.limit || 50);
    const page = Number(req.query.page || 1);
    const events = await listGitAutomationEvents({ workspaceId, limit, page });
    res.json(events);
  } catch (error) {
    console.error("Git automation events load failed:", error);
    res.status(500).json({ error: "Failed to load git automation events" });
  }
});

gitAutomationRoutes.post("/auto-configure", async (req, res) => {
  try {
    if (!canManage(req.user)) {
      return res.status(403).json({ error: "Only admin/manager can auto-configure git automation" });
    }
    const workspaceId = req.workspaceId;
    const {
      repoFullName = null,
      minInferenceConfidence = 62,
      maxInferredTasks = 2,
    } = req.body || {};

    const result = await autoConfigureWorkspaceGitAutomation({
      workspaceId,
      actorId: req.user.id,
      repoFullName,
      minInferenceConfidence,
      maxInferredTasks,
    });
    res.json(result);
  } catch (error) {
    console.error("Git automation auto-configure failed:", error);
    res.status(500).json({ error: "Auto-configure failed", details: error.message });
  }
});

// Manual test endpoint with auth for local validation without external webhook call.
gitAutomationRoutes.post("/simulate/:provider/push", async (req, res) => {
  try {
    if (!canManage(req.user)) {
      return res.status(403).json({ error: "Only admin/manager can trigger simulation" });
    }
    const workspaceId = req.workspaceId;
    const provider = String(req.params.provider || "generic").toLowerCase();
    const payload = req.body || {};

    const result = await processGitPushEvent({
      workspaceId,
      provider,
      payload,
      headers: req.headers,
    });
    res.json(result);
  } catch (error) {
    console.error("Git automation simulate failed:", error);
    res.status(500).json({ error: "Simulation failed", details: error.message });
  }
});

// Public webhook receiver for Git providers.
gitAutomationWebhookRoutes.post("/:workspaceId/:provider", async (req, res) => {
  try {
    const workspaceId = req.params.workspaceId;
    const provider = String(req.params.provider || "generic").toLowerCase();

    // Verify workspace exists before doing any processing
    try {
      await assertWorkspaceExists(workspaceId);
    } catch (err) {
      if (err.code === "WORKSPACE_NOT_FOUND") {
        return res.status(404).json({ error: "Workspace not found" });
      }
      throw err;
    }

    // Verify HMAC / token signature using raw body captured before JSON parsing
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    if (!verifyProviderSignature(provider, rawBody, req.headers)) {
      return res.status(403).json({ error: "Forbidden: invalid webhook signature" });
    }

    const result = await processGitWebhookEvent({
      workspaceId,
      provider,
      payload: req.body || {},
      headers: req.headers,
    });

    res.json(result);
  } catch (error) {
    console.error("Git webhook processing failed:", error);
    res.status(500).json({ error: "Git webhook processing failed", details: error.message });
  }
});
