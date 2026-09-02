// middleware/rateLimit.middleware.js
//
// Application-layer rate limiting (abuse protection, not traffic shaping).
//
// Design notes — the limits here are deliberately generous. The goal is to stop
// credential-stuffing and runaway/abusive clients, NOT to throttle real usage.
//
// Keying strategy: this product is used by teams sitting behind a single office
// NAT address, so keying purely on IP would let one busy colleague exhaust the
// quota for everyone in the building. Authenticated traffic is therefore keyed
// on the user id (falling back to IP only when we genuinely cannot identify a
// user, e.g. login attempts).
//
// Client IP: requests arrive through Cloudflare, which always sets and
// overwrites CF-Connecting-IP. That is preferred over X-Forwarded-For, which a
// client can spoof (the app runs with `trust proxy` enabled).
//
// Kill switch: set RATE_LIMIT_ENABLED=false to disable all limiting without a
// code change or redeploy of application logic.

import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import { getJwtSecret } from "../config/secrets.js";

const ENABLED = String(process.env.RATE_LIMIT_ENABLED ?? "true").trim().toLowerCase() !== "false";

function clientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  return req.ip;
}

/**
 * Prefer a stable per-user key so colleagues sharing an office IP don't share a
 * quota. Falls back to the (IPv6-normalised) client address for anonymous calls.
 */
function userOrIpKey(req) {
  if (req.user?.id) return `u:${req.user.id}`;

  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    try {
      const decoded = jwt.verify(auth.slice(7).trim(), getJwtSecret());
      const id = decoded?.id || decoded?.userId || decoded?.sub;
      if (id) return `u:${id}`;
    } catch {
      // fall through to IP keying for invalid/expired tokens
    }
  }
  return `ip:${clientIp(req)}`;
}

function ipOnlyKey(req) {
  return `ip:${clientIp(req)}`;
}

/** Requests that must never be throttled. */
function skipInfrastructure(req) {
  if (!ENABLED) return true;
  if (req.method === "OPTIONS") return true;                 // CORS preflight
  const p = req.path || "";
  if (p === "/livez" || p === "/readyz" || p === "/version") return true;
  // Service-to-service calls (ai-task -> backend) authenticate with a shared
  // secret and are not user traffic.
  if (req.headers["x-internal-service-secret"] || req.headers["x-ai-service-secret"]) return true;
  return false;
}

const jsonLimitHandler = (message) => (req, res) => {
  res.status(429).json({ error: message, retryAfter: res.getHeader("Retry-After") || null });
};

/**
 * Broad safety net for the whole API. Sized so that normal interactive use —
 * including dashboards that fan out many calls per page — stays far below it.
 */
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,                       // per user (or per anonymous IP) per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  skip: skipInfrastructure,
  handler: jsonLimitHandler("Too many requests. Please slow down and try again shortly."),
});

/**
 * Credential endpoints. Necessarily IP-keyed (there is no user yet), so the
 * limit must tolerate a whole office signing in at the start of the day while
 * still being orders of magnitude below a brute-force attempt.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,                       // per IP per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipOnlyKey,
  skip: skipInfrastructure,
  skipSuccessfulRequests: true,   // only failed attempts count toward the limit
  handler: jsonLimitHandler("Too many login attempts from this network. Please wait a few minutes and try again."),
});

/** Workspace creation is rarer than login and successful abuse still counts. */
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Math.max(1, Number(process.env.SIGNUP_RATE_LIMIT_PER_HOUR) || 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipOnlyKey,
  skip: skipInfrastructure,
  handler: jsonLimitHandler("Too many workspace signups from this network. Please try again later."),
});

/** Prevent verification emails from being used as an inbox-flooding primitive. */
export const emailVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Math.max(1, Number(process.env.EMAIL_VERIFICATION_RATE_LIMIT_PER_HOUR) || 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipOnlyKey,
  skip: skipInfrastructure,
  handler: jsonLimitHandler("Too many verification requests. Please try again later."),
});

/** Passwordless client links are email-bearing credentials; limit sends, not reads. */
export const clientPortalAccessLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Math.max(1, Number(process.env.CLIENT_PORTAL_ACCESS_RATE_LIMIT_PER_HOUR) || 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipOnlyKey,
  skip: skipInfrastructure,
  handler: jsonLimitHandler("Too many client portal access requests. Please try again later."),
});

/**
 * Unauthenticated public endpoints (pricing, signup pages) — cheap to abuse,
 * no user context available.
 */
export const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipOnlyKey,
  skip: skipInfrastructure,
  handler: jsonLimitHandler("Too many requests. Please try again shortly."),
});

export const rateLimitingEnabled = ENABLED;
