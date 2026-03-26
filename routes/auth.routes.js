// routes/auth.routes.js
import express from "express";
import {
  loginWithEmail,
  loginWithMagicToken,
  loginWithGoogle,
  loginWithMfa,
  getCurrentUser,
  requestPasswordReset,
  resetPassword,
} from "../services/auth.service.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { logAudit } from "../services/audit.service.js";

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const GOOGLE_CLIENT_ID    = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL;

// ─── EMAIL + PASSWORD LOGIN ───────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const data = await loginWithEmail(email, password);

    // Audit successful login (skip for MFA — logged after MFA step)
    if (!data.mfa_required && data.user) {
      logAudit({
        workspaceId: data.user.workspaceId || data.user.workspace_id,
        userId: data.user.id,
        action: "user.login",
        entityType: "user",
        entityId: data.user.id,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
        metadata: { method: "email" },
      });
    }

    res.json(data);
  } catch (err) {
    // Audit failed login attempt
    logAudit({
      workspaceId: null,
      userId: null,
      action: "user.login.failed",
      entityType: "user",
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      metadata: { email: req.body?.email, reason: err.message },
    });
    console.error("Login error:", err);
    res.status(401).json({ error: err.message });
  }
});

// ─── MFA SECOND FACTOR ────────────────────────────────────────────────────────
router.post("/mfa/verify", async (req, res) => {
  try {
    const { mfa_session_token, code } = req.body;
    if (!mfa_session_token || !code) {
      return res.status(400).json({ error: "mfa_session_token and code are required" });
    }
    const data = await loginWithMfa(mfa_session_token, code);

    // Audit MFA login success
    if (data.user) {
      logAudit({
        workspaceId: data.user.workspaceId || data.user.workspace_id,
        userId: data.user.id,
        action: "user.login",
        entityType: "user",
        entityId: data.user.id,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
        metadata: { method: "mfa" },
      });
    }

    res.json(data);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ─── LOGOUT ───────────────────────────────────────────────────────────────────
// Client always clears its own token; this endpoint just creates the audit log.
router.post("/logout", authMiddleware, async (req, res) => {
  logAudit({
    workspaceId: req.user.workspaceId || req.user.workspace_id,
    userId: req.user.id,
    action: "user.logout",
    entityType: "user",
    entityId: req.user.id,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
    metadata: {},
  });
  res.json({ success: true });
});

// ─── FORGOT PASSWORD ──────────────────────────────────────────────────────────
// Always returns 200 regardless of whether the email exists (prevents enumeration)
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });
    await requestPasswordReset(email);
    res.json({ message: "If an account with that email exists, a reset link has been sent." });
  } catch (err) {
    console.error("[forgot-password]", err);
    res.status(500).json({ error: "Failed to process request" });
  }
});

// ─── RESET PASSWORD ───────────────────────────────────────────────────────────
router.post("/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: "Token and password are required" });
    await resetPassword(token, password);
    res.json({ message: "Password reset successfully. You can now log in." });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── MAGIC LINK VERIFY ────────────────────────────────────────────────────────
// Called when an imported user clicks the link in their welcome email.
// No auth required — token is the credential.
router.get("/magic", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: "Token is required" });

    const data = await loginWithMagicToken(token);
    res.json(data);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ─── GOOGLE SSO: REDIRECT TO GOOGLE ──────────────────────────────────────────
router.get("/google", (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CALLBACK_URL) {
    return res.status(503).json({ error: "Google SSO is not configured" });
  }

  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  GOOGLE_CALLBACK_URL,
    response_type: "code",
    scope:         "email profile",
    access_type:   "offline",
    prompt:        "select_account",
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// ─── GOOGLE SSO: CALLBACK ─────────────────────────────────────────────────────
router.get("/google/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect(`${FRONTEND_URL}/login?error=google_cancelled`);
  }

  try {
    const { token, user } = await loginWithGoogle(code);

    // Pass token + user to frontend via redirect
    const params = new URLSearchParams({
      token,
      user: JSON.stringify(user),
    });
    res.redirect(`${FRONTEND_URL}/auth/callback?${params}`);
  } catch (err) {
    console.error("Google SSO callback error:", err.message);
    const msg = encodeURIComponent(err.message);
    res.redirect(`${FRONTEND_URL}/login?error=${msg}`);
  }
});

// ─── AUTH CHECK ───────────────────────────────────────────────────────────────
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await getCurrentUser(req.user.id);
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
