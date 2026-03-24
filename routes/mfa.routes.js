// routes/mfa.routes.js
import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import {
  setupMfa, confirmMfa, disableMfa, isMfaEnabled,
} from "../services/mfa.service.js";
import { getClientIp } from "../utils/requestContext.util.js";

const router = express.Router();

// All MFA routes require authentication
router.use(authMiddleware);

/** GET /mfa/status */
router.get("/status", async (req, res) => {
  try {
    const enabled = await isMfaEnabled(req.user.id);
    res.json({ mfa_enabled: enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /mfa/setup — start setup, returns QR code */
router.post("/setup", async (req, res) => {
  try {
    const result = await setupMfa(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** POST /mfa/confirm — verify first code and activate */
router.post("/confirm", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "token is required" });

    const workspaceId = req.headers["x-workspace-id"] || null;
    const ipAddress = getClientIp(req);
    const result = await confirmMfa(req.user.id, token, workspaceId, ipAddress);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** POST /mfa/disable — disable MFA (requires current token) */
router.post("/disable", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "token is required" });

    const workspaceId = req.headers["x-workspace-id"] || null;
    const ipAddress = getClientIp(req);
    await disableMfa(req.user.id, token, workspaceId, ipAddress);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
