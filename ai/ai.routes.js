import express from "express";
import { createChatMessage } from "../services/chat.service.js";
import { canAIRespond } from "./ai.permissions.js";
import { ensureSystemUser } from "../services/ai.system.service.js";

const router = express.Router();

router.post("/message", async (req, res) => {
  try {
    const { channelKey, text, workspaceId, channelType, senderUserId } = req.body;

    console.log("Received AI message request:", req.body);

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

export default router;
