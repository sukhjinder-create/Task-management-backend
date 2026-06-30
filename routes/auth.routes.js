// routes/auth.routes.js
import express from "express";
import crypto from "crypto";
import {
  loginWithEmail,
  loginWithMagicToken,
  loginWithGoogle,
  signupWorkspaceWithEmail,
  signupWorkspaceWithGoogle,
  fetchGoogleProfileFromCode,
  loginWithMfa,
  getCurrentUser,
  requestPasswordReset,
  resetPassword,
  createSession,
  refreshSession,
  revokeSession,
  changePassword,
} from "../services/auth.service.js";
import {
  completeRazorpayTrialSignupCheckoutSession,
  completeTrialSignupCheckoutSession,
  createRazorpayTrialSignupCheckoutSession,
  createTrialSignupCheckoutSession,
} from "../services/payments.service.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { logAudit } from "../services/audit.service.js";
import { captureGrowthEvent } from "../growth/growthCollector.js";
import { deterministicGrowthEventId, requestGrowthContext } from "../growth/growthEvent.js";
import { getJwtSecret } from "../config/secrets.js";

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const MOBILE_APP_AUTH_CALLBACK =
  process.env.MOBILE_APP_AUTH_CALLBACK || "asystence://auth/callback";
const GOOGLE_CLIENT_ID    = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL;
const JWT_SECRET = getJwtSecret();
const GOOGLE_STATE_TTL_MS = 15 * 60 * 1000;

function getRequestIpHash(req) {
  const rawIp = req.ip || req.socket?.remoteAddress || "";
  return rawIp ? crypto.createHash("sha256").update(rawIp).digest("hex") : null;
}

function buildFrontendRedirect(path, params = {}) {
  const url = new URL(path, FRONTEND_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  return url.toString();
}

function buildMobileAuthRedirect(params = {}) {
  const url = new URL(MOBILE_APP_AUTH_CALLBACK);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  return url.toString();
}

function signGoogleState(payload) {
  const body = Buffer.from(
    JSON.stringify({ ...payload, iat: Date.now() })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyGoogleState(state) {
  if (!state) return null;
  const [body, sig] = String(state).split(".");
  if (!body || !sig) throw new Error("Invalid Google signup state");

  const expected = crypto.createHmac("sha256", JWT_SECRET).update(body).digest("base64url");
  const actualBuffer = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid Google signup state");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!payload.iat || Date.now() - Number(payload.iat) > GOOGLE_STATE_TTL_MS) {
    throw new Error("Google signup session expired. Please try again.");
  }
  return payload;
}

function mapSignupStatus(message = "") {
  const lower = message.toLowerCase();
  if (lower.includes("already") || lower.includes("free trial")) return 409;
  return 400;
}

function trialSignupRequiresPayment() {
  const explicit = process.env.TRIAL_SIGNUP_REQUIRE_PAYMENT ?? process.env.TRIAL_SIGNUP_REQUIRE_STRIPE;
  return String(explicit || "true").toLowerCase() !== "false";
}

function getTrialSignupPaymentProvider() {
  const provider = String(
    process.env.TRIAL_SIGNUP_PAYMENT_PROVIDER ||
      process.env.PAYMENTS_PROVIDER ||
      "stripe"
  ).toLowerCase();
  const razorpayConfigured = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
  return provider === "razorpay" && razorpayConfigured ? "razorpay" : "stripe";
}

function isConsentAccepted(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

function captureAuthGrowth(req, eventName, data = {}, properties = {}, id = null) {
  const context = requestGrowthContext(req);
  captureGrowthEvent({
    ...context,
    id,
    eventName,
    source: "server",
    actorUserId: data.user?.id || context.actorUserId,
    workspaceId:
      data.user?.workspaceId ||
      data.user?.workspace_id ||
      data.workspace?.id ||
      context.workspaceId,
    entityType: data.workspace ? "workspace" : "user",
    entityId: data.workspace?.id || data.user?.id || null,
    properties,
  });
}

function captureCompletedSignup(req, data, method) {
  const workspaceId = data.workspace?.id || data.user?.workspaceId || data.user?.workspace_id;
  captureAuthGrowth(req, "product.signup_completed", data, {
    feature_name: "Signup",
    method,
    outcome: "success",
  }, deterministicGrowthEventId(`product.signup_completed:${workspaceId}`));
  captureAuthGrowth(req, "product.workspace_created", data, {
    feature_name: "Workspace",
    method,
    outcome: "success",
  }, deterministicGrowthEventId(`product.workspace_created:${workspaceId}`));
}

router.post("/signup/workspace", async (req, res) => {
  try {
    const { workspaceName, name, email, password } = req.body || {};

    if (trialSignupRequiresPayment()) {
      const paymentProvider = getTrialSignupPaymentProvider();
      const createCheckout =
        paymentProvider === "razorpay"
          ? createRazorpayTrialSignupCheckoutSession
          : createTrialSignupCheckoutSession;
      const data = await createCheckout({
        workspaceName,
        name,
        email,
        password,
        planId: req.body?.planId,
        plan: req.body?.plan,
        interval: req.body?.interval,
        successUrl: req.body?.successUrl,
        cancelUrl: req.body?.cancelUrl,
        ipHash: getRequestIpHash(req),
        userAgent: req.headers["user-agent"],
        consentAccepted:
          isConsentAccepted(req.body?.consentAccepted) ||
          isConsentAccepted(req.body?.trialBillingConsent),
      });

      logAudit({
        workspaceId: null,
        userId: null,
        action: "workspace.signup.checkout.created",
        entityType: "workspace",
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
        metadata: { email, provider: data.provider || paymentProvider, checkoutSessionId: data.id },
      });

      return res.status(201).json(data);
    }

    const data = await signupWorkspaceWithEmail({
      workspaceName,
      name,
      email,
      password,
      ipHash: getRequestIpHash(req),
    });

    data.refreshToken = await createSession(
      data.user.id,
      data.user.workspaceId,
      req.ip,
      req.headers["user-agent"]
    );
    captureCompletedSignup(req, data, "email");

    logAudit({
      workspaceId: data.user.workspaceId || data.user.workspace_id,
      userId: data.user.id,
      action: "workspace.signup",
      entityType: "workspace",
      entityId: data.workspace?.id,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      metadata: { method: "email" },
    });

    return res.status(201).json(data);
  } catch (err) {
    logAudit({
      workspaceId: null,
      userId: null,
      action: "workspace.signup.failed",
      entityType: "workspace",
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      metadata: { email: req.body?.email, reason: err.message },
    });
    console.error("Signup error:", err);
    return res.status(err.statusCode || mapSignupStatus(err.message)).json({
      error: err.message,
      checkoutSessionId: err.checkoutSessionId,
    });
  }
});

router.get("/signup/workspace/complete", async (req, res) => {
  try {
    const { session_id: sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: "session_id is required" });

    const data = await completeTrialSignupCheckoutSession(String(sessionId));
    data.refreshToken = await createSession(
      data.user.id,
      data.user.workspaceId || data.user.workspace_id,
      req.ip,
      req.headers["user-agent"]
    );
    captureCompletedSignup(req, data, "stripe_checkout");

    logAudit({
      workspaceId: data.user.workspaceId || data.user.workspace_id,
      userId: data.user.id,
      action: "workspace.signup",
      entityType: "workspace",
      entityId: data.workspace?.id,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      metadata: { method: "stripe_checkout", refundId: data.refundId || null },
    });

    return res.json(data);
  } catch (err) {
    console.error("Trial signup completion error:", err);
    return res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.post("/signup/workspace/complete/razorpay", async (req, res) => {
  try {
    const {
      razorpay_payment_id: razorpayPaymentId,
      razorpay_subscription_id: razorpaySubscriptionId,
      razorpay_order_id: razorpayOrderId,
      razorpay_signature: razorpaySignature,
      pendingSignupId,
    } = req.body || {};

    if (!razorpayPaymentId || (!razorpaySubscriptionId && !razorpayOrderId) || !razorpaySignature) {
      return res.status(400).json({ error: "Razorpay payment verification details are required" });
    }

    const data = await completeRazorpayTrialSignupCheckoutSession({
      subscriptionId: razorpaySubscriptionId ? String(razorpaySubscriptionId) : null,
      orderId: razorpayOrderId ? String(razorpayOrderId) : null,
      paymentId: String(razorpayPaymentId),
      signature: String(razorpaySignature),
      pendingSignupId: pendingSignupId ? String(pendingSignupId) : null,
    });
    data.refreshToken = await createSession(
      data.user.id,
      data.user.workspaceId || data.user.workspace_id,
      req.ip,
      req.headers["user-agent"]
    );
    captureCompletedSignup(req, data, "razorpay_checkout");

    logAudit({
      workspaceId: data.user.workspaceId || data.user.workspace_id,
      userId: data.user.id,
      action: "workspace.signup",
      entityType: "workspace",
      entityId: data.workspace?.id,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      metadata: { method: "razorpay_checkout", refundId: data.refundId || null },
    });

    return res.json(data);
  } catch (err) {
    console.error("Razorpay trial signup completion error:", err);
    return res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.get("/signup/workspace/complete/redirect", async (req, res) => {
  try {
    const { session_id: sessionId } = req.query;
    if (!sessionId) {
      return res.redirect(buildFrontendRedirect("/signup", { error: "missing_checkout_session" }));
    }

    const data = await completeTrialSignupCheckoutSession(String(sessionId));
    const refreshToken = await createSession(
      data.user.id,
      data.user.workspaceId || data.user.workspace_id,
      req.ip,
      req.headers["user-agent"]
    );
    captureCompletedSignup(req, data, "stripe_redirect");

    logAudit({
      workspaceId: data.user.workspaceId || data.user.workspace_id,
      userId: data.user.id,
      action: "workspace.signup",
      entityType: "workspace",
      entityId: data.workspace?.id,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      metadata: { method: "stripe_checkout", refundId: data.refundId || null },
    });

    return res.redirect(
      buildFrontendRedirect("/auth/callback", {
        token: data.token,
        refreshToken,
      })
    );
  } catch (err) {
    console.error("Trial signup redirect completion error:", err);
    return res.redirect(buildFrontendRedirect("/signup", { error: err.message }));
  }
});

// ─── EMAIL + PASSWORD LOGIN ───────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const data = await loginWithEmail(email, password);

    // Audit successful login (skip for MFA — logged after MFA step)
    if (!data.mfa_required && data.user) {
      // Create persistent session → return refresh token to client
      data.refreshToken = await createSession(
        data.user.id,
        data.user.workspaceId,
        req.ip,
        req.headers["user-agent"]
      );

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

    captureAuthGrowth(req, "product.login_attempt", data, {
      feature_name: "Authentication",
      method: "email",
      outcome: data.mfa_required ? "mfa_required" : "success",
    });
    if (!data.mfa_required && data.user) {
      captureAuthGrowth(req, "product.login_succeeded", data, {
        feature_name: "Authentication",
        method: "email",
        outcome: "success",
      });
    }

    res.json(data);
  } catch (err) {
    captureAuthGrowth(req, "product.login_attempt", {}, {
      feature_name: "Authentication",
      method: "email",
      outcome: "failed",
    });
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

    // Audit MFA login success + create persistent session
    if (data.user) {
      data.refreshToken = await createSession(
        data.user.id,
        data.user.workspaceId,
        req.ip,
        req.headers["user-agent"]
      );

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
      captureAuthGrowth(req, "product.login_succeeded", data, {
        feature_name: "Authentication",
        method: "mfa",
        outcome: "success",
      });
    }

    res.json(data);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ─── LOGOUT ───────────────────────────────────────────────────────────────────
// Revokes the refresh token (session) and creates an audit log entry.
router.post("/logout", authMiddleware, async (req, res) => {
  // Revoke the refresh token so it can't be used to silently re-auth
  const { refreshToken } = req.body;
  if (refreshToken) {
    revokeSession(refreshToken).catch(() => {}); // fire-and-forget
  }

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

// ─── REFRESH SESSION ──────────────────────────────────────────────────────────
// Exchange a (still-valid) refresh token for a new short-lived JWT and a new
// rotated refresh token. The old refresh token is deleted immediately.
// No authMiddleware — the expired JWT cannot be used here, only the refresh token.
router.post("/refresh", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: "refreshToken is required" });
    }
    const data = await refreshSession(refreshToken, req.ip, req.headers["user-agent"]);
    res.json(data); // { token, refreshToken, user }
  } catch (err) {
    // Return 401 so the frontend interceptor knows to log out
    res.status(401).json({ error: err.message });
  }
});

// ─── CHANGE PASSWORD (authenticated) ─────────────────────────────────────────
// For logged-in users who know their current password.
// Revokes ALL sessions on success (forces re-login on all devices).
router.put("/change-password", authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "currentPassword and newPassword are required" });
    }

    await changePassword(req.user.id, currentPassword, newPassword);

    logAudit({
      workspaceId: req.user.workspaceId || req.user.workspace_id,
      userId: req.user.id,
      action: "user.password.changed",
      entityType: "user",
      entityId: req.user.id,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      metadata: {},
    });

    res.json({ message: "Password changed successfully. Please log in again." });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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

    // Create persistent session for magic-link logins too
    if (data.user) {
      data.refreshToken = await createSession(
        data.user.id,
        data.user.workspaceId,
        req.ip,
        req.headers["user-agent"]
      );
    }

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

  const mode = String(req.query.mode || "").trim().toLowerCase();
  const client = String(req.query.client || "").trim().toLowerCase();
  const isSignup = ["signup", "register", "trial"].includes(mode);
  const isMobileClient = client === "mobile";
  const workspaceName = String(req.query.workspaceName || "").trim();
  const trialBillingConsent =
    isConsentAccepted(req.query.trialBillingConsent) ||
    isConsentAccepted(req.query.consentAccepted);

  if (isSignup && !workspaceName) {
    return res.redirect(
      buildFrontendRedirect("/signup", { error: "workspace_required" })
    );
  }
  if (isSignup && trialSignupRequiresPayment() && !trialBillingConsent) {
    return res.redirect(
      buildFrontendRedirect("/signup", { error: "billing_consent_required" })
    );
  }

  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  GOOGLE_CALLBACK_URL,
    response_type: "code",
    scope:         "email profile",
    access_type:   "offline",
    prompt:        "select_account",
  });

  if (isSignup || isMobileClient) {
    params.set("state", signGoogleState({
      mode: isSignup ? "signup" : "login",
      client: isMobileClient ? "mobile" : "web",
      ...(isSignup ? { workspaceName, trialBillingConsent } : {}),
    }));
  }

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// ─── GOOGLE SSO: CALLBACK ─────────────────────────────────────────────────────
router.get("/google/callback", async (req, res) => {
  const { code, error, state } = req.query;
  let googleState = null;

  try {
    googleState = verifyGoogleState(state);
  } catch (stateErr) {
    return res.redirect(
      buildFrontendRedirect("/signup", { error: stateErr.message })
    );
  }

  const isSignup = googleState?.mode === "signup";
  const isMobileClient = googleState?.client === "mobile";
  const errorPath = isSignup ? "/signup" : "/login";

  if (error || !code) {
    if (isMobileClient) {
      return res.redirect(buildMobileAuthRedirect({ error: "google_cancelled" }));
    }
    return res.redirect(buildFrontendRedirect(errorPath, { error: "google_cancelled" }));
  }

  try {
    if (isSignup && trialSignupRequiresPayment()) {
      const profile = await fetchGoogleProfileFromCode(code);
      if (!profile.emailVerified) {
        throw new Error("Your Google account email is not verified.");
      }

      const paymentProvider = getTrialSignupPaymentProvider();
      const createCheckout =
        paymentProvider === "razorpay"
          ? createRazorpayTrialSignupCheckoutSession
          : createTrialSignupCheckoutSession;
      const checkout = await createCheckout({
        workspaceName: googleState.workspaceName,
        name: profile.name,
        email: profile.email,
        authProvider: "google",
        avatarUrl: profile.picture,
        ipHash: getRequestIpHash(req),
        userAgent: req.headers["user-agent"],
        consentAccepted: googleState.trialBillingConsent === true,
      });
      logAudit({
        workspaceId: null,
        userId: null,
        action: "workspace.signup.checkout.created",
        entityType: "workspace",
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
        metadata: {
          email: profile.email,
          method: "google",
          provider: checkout.provider || paymentProvider,
          checkoutSessionId: checkout.id,
        },
      });

      if (checkout.url) return res.redirect(checkout.url);
      return res.redirect(
        buildFrontendRedirect("/signup", {
          checkout_provider: checkout.provider || paymentProvider,
          razorpay_subscription_id: checkout.subscriptionId,
          razorpay_pending_signup_id: checkout.notes?.pending_signup_id,
        })
      );
    }

    const data = isSignup
      ? await signupWorkspaceWithGoogle(code, {
          workspaceName: googleState.workspaceName,
          ipHash: getRequestIpHash(req),
        })
      : await loginWithGoogle(code);

    // Pass only token — frontend fetches user from /users/me
    const refreshToken = await createSession(
      data.user.id,
      data.user.workspaceId,
      req.ip,
      req.headers["user-agent"]
    );

    if (isSignup) {
      captureCompletedSignup(req, data, "google");
    } else {
      captureAuthGrowth(req, "product.login_attempt", data, {
        feature_name: "Authentication",
        method: "google",
        outcome: "success",
      });
      captureAuthGrowth(req, "product.login_succeeded", data, {
        feature_name: "Authentication",
        method: "google",
        outcome: "success",
      });
    }

    logAudit({
      workspaceId: data.user.workspaceId || data.user.workspace_id,
      userId: data.user.id,
      action: isSignup ? "workspace.signup" : "user.login",
      entityType: isSignup ? "workspace" : "user",
      entityId: isSignup ? data.workspace?.id : data.user.id,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      metadata: { method: "google" },
    });

    const redirectParams = {
        token: data.token,
        refreshToken,
      };
    res.redirect(
      isMobileClient
        ? buildMobileAuthRedirect(redirectParams)
        : buildFrontendRedirect("/auth/callback", redirectParams)
    );
  } catch (err) {
    console.error("Google SSO callback error:", err.message);
    res.redirect(
      isMobileClient
        ? buildMobileAuthRedirect({ error: err.message })
        : buildFrontendRedirect(errorPath, { error: err.message })
    );
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
