import express from "express";
import { createAIChatMessage } from "../services/chat.service.js";
import pool from "../db.js";


const router = express.Router();

/**
 * 🔒 Internal AI reply endpoint
 * Called ONLY by AI service
 */
router.post("/ai/reply", async (req, res) => {
  try {
    // 🔐 Shared-secret auth
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");

    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const {
      channelKey,
      workspaceId,
      textHtml,
      parentId = null,
    } = req.body || {};

    if (!channelKey || !workspaceId || !textHtml) {
      return res.status(400).json({
        error: "channelKey, workspaceId, textHtml are required",
      });
    }

    const msg = await createAIChatMessage({
      channelKey,
      workspaceId,
      textHtml,
      parentId,
    });

    return res.json({
      success: true,
      messageId: msg.id,
    });
  } catch (err) {
    console.error("[INTERNAL_AI_REPLY_ERROR]", err);
    return res.status(500).json({ error: "AI reply failed" });
  }
});

/**
 * 🔒 Internal AI → Read workspace AI settings
 * Used ONLY by AI service (no JWT, no user auth)
 */
/**
 * 🔐 Internal: Read workspace AI settings
 * Used ONLY by AI service (no JWT)
 */
router.get("/workspace-ai-settings/:workspaceId", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");

    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { workspaceId } = req.params;

    const { rows } = await pool.query(
      `
      SELECT ai_enabled, ai_auto_reply
      FROM workspace_ai_settings
      WHERE workspace_id = $1
      `,
      [workspaceId]
    );

    // Default = enabled
    res.json(
      rows[0] || {
        ai_enabled: true,
        ai_auto_reply: true,
      }
    );
  } catch (err) {
    console.error("[INTERNAL_AI_SETTINGS_ERROR]", err);
    res.status(500).json({ error: "Failed to fetch AI settings" });
  }
});

export default router;
