import express from "express";
import { allowRoles } from "../../middleware/role.middleware.js";
import { getIntegrationAdapter }
  from "../core/integration.adapter.js";

const router = express.Router();

router.use(allowRoles("admin"));

/**
 * CONNECT YOU TRACK
 */
router.post("/connect", async (req, res) => {
    console.log("HEADERS:", req.headers["content-type"]);
console.log("BODY:", req.body);

  try {
    const workspaceId = req.workspaceId;
    const { baseUrl, token } = req.body;

    if (!baseUrl || !token) {
      return res.status(400).json({
        error: "baseUrl and token required"
      });
    }

    const adapter =
  await getIntegrationAdapter("youtrack");

const result =
  await adapter.connectWorkspace(
        workspaceId,
        baseUrl,
        token
      );

    res.json(result);

  } catch (err) {
    console.error("YouTrack connect error:", err.message);

    res.status(500).json({
      error: "Connection failed"
    });
  }
});

export default router;
