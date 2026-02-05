import express from "express";
import { createAIChatMessage } from "../services/chat.service.js";
import pool from "../db.js";
console.log("🔥 INTERNAL ROUTES LOADED");


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

/**
 * 🔒 Internal AI Memory Storage (WMDPE)
 * Stores opaque AI memory as JSON per workspace
 * Used ONLY by AI service
 */

// Save / update AI memory
router.post("/ai/memory", async (req, res) => {
  try {
    // 🔐 Shared-secret auth (same as other internal AI routes)
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");

    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { workspaceId, type, payload } = req.body || {};

    if (!workspaceId || !type || payload === undefined) {
      return res.status(400).json({
        error: "workspaceId, type, payload are required",
      });
    }

    await pool.query(
      `
      INSERT INTO ai_memory (workspace_id, type, payload, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (workspace_id, type)
      DO UPDATE SET payload = $3, updated_at = NOW()
      `,
      [workspaceId, type, payload]
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("[INTERNAL_AI_MEMORY_SAVE_ERROR]", err);
    return res.status(500).json({ error: "Failed to save AI memory" });
  }
});

// Read AI memory
router.get("/ai/memory", async (req, res) => {
  try {
    // 🔐 Shared-secret auth
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");

    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { workspaceId, type } = req.query;

    if (!workspaceId || !type) {
      return res.status(400).json({
        error: "workspaceId and type are required",
      });
    }

    const { rows } = await pool.query(
      `
      SELECT payload
      FROM ai_memory
      WHERE workspace_id = $1 AND type = $2
      `,
      [workspaceId, type]
    );

    return res.json({
      payload: rows[0]?.payload || null,
    });
  } catch (err) {
    console.error("[INTERNAL_AI_MEMORY_READ_ERROR]", err);
    return res.status(500).json({ error: "Failed to read AI memory" });
  }
});

/**
 * 🔒 Internal: Read workspace chat history for AI (WMDPE)
 * Read-only, used ONLY by AI service
 */
router.get("/workspace-history/:workspaceId", async (req, res) => {
  try {
    // 🔐 Shared-secret auth
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");

    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { workspaceId } = req.params;

    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId required" });
    }

    // 🔍 Read recent messages (limit for safety)
    const { rows } = await pool.query(
  `
  SELECT
  id,
  user_id,
  workspace_id,
  channel_key,
  created_at
FROM chat_messages
WHERE workspace_id = $1
ORDER BY created_at DESC
LIMIT 200
  `,
  [workspaceId]
);

    return res.json({
      messages: rows,
    });
  } catch (err) {
    console.error("[INTERNAL_WORKSPACE_HISTORY_ERROR]", err);
    return res.status(500).json({ error: "Failed to fetch workspace history" });
  }
});

/**
 * 🧠 Explain why AI replied to a message
 * Used by frontend (authenticated users)
 */
router.get("/ai/explain/:messageId", async (req, res) => {
  try {
    const { messageId } = req.params;
    const workspaceId = req.workspaceId || req.headers["x-workspace-id"];

    const { rows } = await pool.query(
      `
      SELECT explanation, confidence, model, context, created_at
      FROM ai_decision_provenance
      WHERE message_id = $1 AND workspace_id = $2
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [messageId, workspaceId]
    );

    if (!rows.length) {
  return res.json({
    available: false,
    pending: true, // 🔥 KEY FIX
  });
}

let parsed = null;
try {
  parsed =
    typeof rows[0].explanation === "string"
      ? JSON.parse(rows[0].explanation)
      : rows[0].explanation;
} catch {
  parsed = null;
}

if (!parsed) {
  return res.json({
    available: false,
    pending: false,
    error: "Explanation could not be parsed",
  });
}

return res.json({
  available: true,
  explanation: {
    summary: parsed.summary || "AI responded based on the user's message.",
    reasoning: parsed.reasoning || [],
    triggerMessage: parsed.triggerMessage || null,
    detectedIntent: parsed.detectedIntent || null,
  },
  confidence: rows[0].confidence,
  model: rows[0].model,
  context: rows[0].context,
  createdAt: rows[0].created_at,
});
  } catch (err) {
    return res.status(500).json({ available: false });
  }
});

router.post("/ai/provenance", async (req, res) => {
  try {
    const {
      workspaceId,
      messageId,
      channelKey,
      triggerMessageId,
      explanation,
      confidence,
      model,
      context,
    } = req.body;

    await pool.query(
      `
      INSERT INTO ai_decision_provenance (
        workspace_id,
        message_id,
        channel_key,
        trigger_message_id,
        explanation,
        confidence,
        model,
        context
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `,
      [
        workspaceId,
        messageId,
        channelKey,
        triggerMessageId,
        explanation,
        confidence,
        model,
        context || {},
      ]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("[AI_PROVENANCE_WRITE_ERROR]", err);
    res.status(500).json({ error: "failed_to_record_ai_provenance" });
  }
});

export default router;
