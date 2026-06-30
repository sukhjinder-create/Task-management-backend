import express from "express";
import { createChatMessage } from "../services/chat.service.js";
import { canAIRespond } from "./ai.permissions.js";
import { ensureSystemUser } from "../services/ai.system.service.js";
import { runAIIntelligenceQuery } from "./ai.intelligence.service.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import { requireInternalServiceSecret } from "../config/secrets.js";

const router = express.Router();

/**
 * 🔐 Resolve AI system user for a workspace
 * Used by AI service (stateless)
 */
router.get("/system-user/:workspaceId", requireInternalServiceSecret, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId required" });
    }

    // Reuse SINGLE source of truth
    const aiUser = await ensureSystemUser(workspaceId);

    if (!aiUser?.id) {
      return res.status(500).json({ error: "AI system user resolution failed" });
    }

    return res.json({
      userId: aiUser.id,
      username: aiUser.username || "AI Assistant",
    });
  } catch (err) {
    console.error("🔥 resolve AI system user failed:", err);
    return res.status(500).json({ error: "Failed to resolve AI system user" });
  }
});

router.post("/message", requireInternalServiceSecret, async (req, res) => {
  try {
    const { channelKey, text, workspaceId, channelType, senderUserId } = req.body;

    console.log("[ai:message] internal request", {
      workspaceId,
      channelKey,
      channelType,
      senderUserId,
      textLength: String(text || "").length,
    });

    // 1️⃣ Permission check
    const allowed = await canAIRespond({
      workspaceId,
      channelType,
      senderUserId,
    });

    if (!allowed) {
      return res.status(403).json({ error: "AI not allowed here" });
    }

    // 2️⃣ Get REAL users.id for AI
    const aiUser = await ensureSystemUser(workspaceId);

    // 3️⃣ Prevent AI loops
    if (senderUserId === aiUser.id) {
      return res.json({ ok: true });
    }

    // 4️⃣ Save AI message
    const message = await createChatMessage({
      channelKey,
      userId: aiUser.id,
      textHtml: text,
      fallbackText: text,
      encryptedJson: null,
      workspaceId,
    });
    // This should be the properly structured message

    res.json({ success: true, message });
  } catch (err) {
    console.error("AI ROUTE ERROR:", err);
    res.status(500).json({ error: "AI message failed" });
  }
});

/**
 * Strategic Intelligence Query
 * 🔐 Requires authentication and workspace access
 */
router.post(
  "/intelligence-query",
  authMiddleware,
  requireWorkspaceForUser,
  async (req, res) => {
    try {
      const workspaceId = req.workspaceId;
      const { scope, entityId, question } = req.body;

      // Validate required fields
      if (!scope || !question) {
        return res.status(400).json({
          error: "scope and question are required",
          hint: "scope must be 'workspace', 'project', or 'task'"
        });
      }

      // Validate scope value
      if (!["workspace", "project", "task"].includes(scope)) {
        return res.status(400).json({
          error: "Invalid scope",
          hint: "scope must be 'workspace', 'project', or 'task'"
        });
      }

      // Validate entityId for project/task scopes
      if ((scope === "project" || scope === "task") && !entityId) {
        return res.status(400).json({
          error: `entityId is required for ${scope} scope`,
          hint: `Please provide the ${scope} ID in the entityId field`
        });
      }

      const aiUser = await ensureSystemUser(workspaceId);

      const answer = await runAIIntelligenceQuery({
        workspaceId,
        scope,
        entityId,
        question
      });

      res.json({
        success: true,
        answer,
        aiUser
      });

    } catch (err) {
      console.error("AI Intelligence error:", err);

      // Handle specific errors
      if (err.message.includes("not found")) {
        return res.status(404).json({
          error: err.message,
          hint: "Verify the entity exists and belongs to your workspace"
        });
      }

      if (err.message.includes("Context too large")) {
        return res.status(400).json({
          error: err.message,
          hint: "Try asking a more specific question"
        });
      }

      // Generic error
      res.status(500).json({
        error: "Strategic intelligence failed",
        details: err.message
      });
    }
  }
);

export default router;
