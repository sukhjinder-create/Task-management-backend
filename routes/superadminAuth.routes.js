import express from "express";
import requireSuperadmin from "../middleware/requireSuperadmin.js";
import {
  getSuperadminById,
  refreshSuperadminSession,
  revokeSuperadminSession,
  superadminLogin,
} from "../services/superadmin.service.js";

const router = express.Router();
const loginAttempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function loginRateLimit(req, res, next) {
  const key = String(req.ip || req.socket?.remoteAddress || "unknown");
  const now = Date.now();
  if (loginAttempts.size > 10_000) {
    for (const [attemptKey, value] of loginAttempts) {
      if (value.resetAt <= now) loginAttempts.delete(attemptKey);
    }
  }
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }
  current.count += 1;
  if (current.count > MAX_ATTEMPTS) {
    res.set("Retry-After", String(Math.ceil((current.resetAt - now) / 1000)));
    return res.status(429).json({ error: "Too many login attempts. Try again later." });
  }
  return next();
}

router.post("/login", loginRateLimit, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    const result = await superadminLogin(email, password, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    if (!result) {
      return res.status(401).json({ error: "Invalid Super Admin credentials" });
    }
    loginAttempts.delete(String(req.ip || req.socket?.remoteAddress || "unknown"));
    return res.json(result);
  } catch (error) {
    console.error("[superadmin auth] login failed:", error.message);
    return res.status(500).json({ error: "Super Admin login is temporarily unavailable" });
  }
});

router.post("/refresh", async (req, res) => {
  try {
    const result = await refreshSuperadminSession(req.body?.refreshToken, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    return res.json(result);
  } catch (error) {
    return res.status(401).json({ error: error.message });
  }
});

router.post("/logout", requireSuperadmin, async (req, res) => {
  await revokeSuperadminSession(req.body?.refreshToken).catch((error) => {
    console.warn("[superadmin auth] session revoke failed:", error.message);
  });
  return res.json({ success: true });
});

router.get("/me", requireSuperadmin, async (req, res) => {
  const superadmin = await getSuperadminById(req.superadmin.id);
  if (!superadmin) return res.status(401).json({ error: "Super Admin account not found" });
  return res.json({ superadmin });
});

export default router;
