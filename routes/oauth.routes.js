import express from "express";
import { exchangeClientCredentials } from "../services/serviceAccount.service.js";

const router = express.Router();

router.post("/token", async (req, res) => {
  try {
    const result = await exchangeClientCredentials({
      authorization: req.headers.authorization,
      body: req.body || {},
    });
    if (result.error) {
      if (result.status === 401) res.setHeader("WWW-Authenticate", 'Basic realm="asystence-oauth"');
      return res.status(result.status).json({ error: result.error, error_description: result.error_description });
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    return res.json(result);
  } catch (error) {
    console.error("OAuth token exchange failed:", error.message);
    return res.status(503).json({ error: "temporarily_unavailable" });
  }
});

export default router;
