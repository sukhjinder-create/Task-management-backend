// routes/chat.routes.js
import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { getRecentMessages } from "../services/chat.service.js";

const router = express.Router();

/**
 * GET /chat/channels/:channelId/messages?limit=100
 * Returns recent messages for that channel (oldest first).
 */
router.get(
  "/channels/:channelId/messages",
  authMiddleware,
  async (req, res) => {
    try {
      const { channelId } = req.params;
      const limit = Number(req.query.limit) || 100;

      const messages = await getRecentMessages(channelId, limit);
      res.json(messages);
    } catch (err) {
      console.error("Error fetching chat messages:", err);
      res.status(500).json({ error: "Failed to load chat history" });
    }
  }
);

export default router;
