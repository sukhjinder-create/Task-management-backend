import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import axios from "axios";
import crypto from "crypto";
import {
  getUserByEmail,
  getUserById,
} from "../repositories/user.repository.js";
import { createWorkspace as createWorkspaceWithOwner } from "../repositories/superadminWorkspaces.repository.js";
import {
  buildNoCardTrialMetadata,
  describeTrialLifecycle,
  trialEndFrom,
} from "./trialLifecycle.service.js";

async function getDefaultMembershipBillingStatus(workspaceId) {
  const { rows } = await pool.query(
    `SELECT trial_ends_at
     FROM workspaces
     WHERE id = $1
     LIMIT 1`,
    [workspaceId]
  );

  const trialEndsAt = rows[0]?.trial_ends_at ? new Date(rows[0].trial_ends_at) : null;
  return trialEndsAt && trialEndsAt > new Date() ? "trial" : "active";
}

async function ensureWorkspaceUser(userId, workspaceId, billingStatus = null) {
  if (!userId || !workspaceId || workspaceId === "GLOBAL") return;
  const status = billingStatus || (await getDefaultMembershipBillingStatus(workspaceId));
  await pool.query(
    `INSERT INTO workspace_users (user_id, workspace_id, billing_status)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, workspaceId, status]
  );
}
import { verifyMagicToken } from "./magicLink.service.js";
import { verifyMfaToken } from "./mfa.service.js";
import { sendPasswordResetEmail } from "./email.service.js";
import pool from "../db.js";
import { getJwtSecret } from "../config/secrets.js";
import {
  getFrontendBaseUrl,
  getGoogleCallbackUrl,
  isAuthDevModeEnabled,
  isLocalRuntime,
} from "../config/environment.js";

const JWT_SECRET = getJwtSecret();
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1h";
const WORKSPACE_GLOBAL = "GLOBAL";
const FRONTEND_URL = getFrontendBaseUrl();

/**
 * Helper: normalize DB user row to a safe user object
 * ❗ IMPORTANT:
 * - workspaceId MUST come from DB
 * - NO silent fallback to GLOBAL for normal users
 */
function normalizeUserRow(user) {
  if (!user) return null;

  const role = user.role || "user";

  // Workspace must exist for non-superadmin
  const workspaceId = user.workspace_id ?? user.workspaceId ?? null;

  if (!workspaceId && role !== "superadmin") {
    throw new Error("User is not assigned to any workspace");
  }

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role,
    avatar_url: user.avatar_url || null,
    projects: user.projects || [],
    workspaceId: role === "superadmin" ? WORKSPACE_GLOBAL : workspaceId,
    workspace_id: role === "superadmin" ? WORKSPACE_GLOBAL : workspaceId,
    workspace_slug: user.workspace_slug || null,
    workspace_name: user.workspace_name || null,
  };
}

/**
 * Generate JWT token
 * 🔐 workspaceId is mandatory for normal users
 */
export function generateToken(user) {
  const role = user.role || "user";

  const workspaceId =
    role === "superadmin"
      ? WORKSPACE_GLOBAL
      : user.workspaceId ?? user.workspace_id ?? null;

  if (!workspaceId && role !== "superadmin") {
    throw new Error("Cannot generate token without workspace");
  }

  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      email: user.email,
      role,
      workspaceId,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * LOGIN WITH EMAIL + PASSWORD
 * If MFA is enabled, returns { mfa_required: true, mfa_session_token } instead of full JWT.
 * Second step: call loginWithMfa(mfa_session_token, totpCode).
 */
export async function loginWithEmail(email, password) {
  if (!email || !password) {
    throw new Error("Email and password are required");
  }

  const user = await getUserByEmail(email);
  if (!user) throw new Error("Invalid email or password");
  if (!user.password_hash) throw new Error("User has no password set. Contact admin.");

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) throw new Error("Invalid email or password");

  // If MFA enabled, issue a short-lived session token (5 min) instead of full JWT
  if (user.mfa_enabled) {
    const mfaSessionToken = jwt.sign(
      { id: user.id, mfa_pending: true },
      JWT_SECRET,
      { expiresIn: "5m" }
    );
    return { mfa_required: true, mfa_session_token: mfaSessionToken };
  }

  const safeUser = normalizeUserRow(user);
  await ensureWorkspaceUser(safeUser.id, safeUser.workspace_id);
  const token = generateToken(safeUser);
  return { token, user: safeUser };
}

/**
 * COMPLETE MFA LOGIN — verify TOTP / backup code and return full JWT
 */
export async function loginWithMfa(mfaSessionToken, totpCode) {
  let payload;
  try {
    payload = jwt.verify(mfaSessionToken, JWT_SECRET);
  } catch {
    throw new Error("MFA session expired or invalid. Please log in again.");
  }
  if (!payload.mfa_pending) throw new Error("Invalid MFA session token");

  const valid = await verifyMfaToken(payload.id, totpCode);
  if (!valid) throw new Error("Invalid authentication code");

  const user = await getUserById(payload.id);
  if (!user) throw new Error("User not found");

  const safeUser = normalizeUserRow(user);
  await ensureWorkspaceUser(safeUser.id, safeUser.workspace_id);
  const token = generateToken(safeUser);
  return { token, user: safeUser };
}

export async function loginWithDevelopmentUser({
  email = process.env.AUTH_DEV_EMAIL || "developer@localhost.test",
  name = process.env.AUTH_DEV_NAME || "Asystence Developer",
  workspaceName = process.env.AUTH_DEV_WORKSPACE || "Local Development",
} = {}) {
  if (!isAuthDevModeEnabled()) {
    const error = new Error("Developer authentication is not enabled");
    error.statusCode = 404;
    throw error;
  }

  const normalizedEmail = normalizeSignupEmail(email);
  const existing = await getUserByEmail(normalizedEmail);

  if (existing) {
    const safeUser = normalizeUserRow(existing);
    await ensureWorkspaceUser(safeUser.id, safeUser.workspace_id);
    const token = generateToken(safeUser);
    return { token, user: safeUser };
  }

  const passwordHash = await bcrypt.hash(
    process.env.AUTH_DEV_PASSWORD || "local-development-password",
    10
  );

  return createSelfServeTrialWorkspace({
    workspaceName,
    ownerName: name,
    ownerEmail: normalizedEmail,
    ownerPasswordHash: passwordHash,
    skipTrialIpCheck: true,
  });
}

/**
 * GET CURRENT LOGGED-IN USER
 * (unchanged behavior)
 */
export async function getCurrentUser(userId) {
  const user = await getUserById(userId);
  if (!user) throw new Error("User not found");
  return user;
}

/**
 * LOGIN WITH MAGIC LINK TOKEN
 * Used by imported users (Slack, Asana, YouTrack, etc.)
 */
export async function loginWithMagicToken(token) {
  const user     = await verifyMagicToken(token);
  const safeUser = normalizeUserRow(user);
  await ensureWorkspaceUser(safeUser.id, safeUser.workspace_id);
  const jwt      = generateToken(safeUser);
  return { token: jwt, user: safeUser };
}

/**
 * FORGOT PASSWORD — generates a secure reset token, stores hash, sends email.
 * Always responds the same way to prevent user enumeration.
 */
export async function requestPasswordReset(email) {
  const user = await getUserByEmail(email);
  if (!user) return; // silently succeed — don't leak whether email exists

  // Generate a secure random 32-byte hex token
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  // Invalidate any existing unused tokens for this user
  await pool.query(
    `DELETE FROM password_reset_tokens WHERE user_id = $1`,
    [user.id]
  );

  // Store hashed token (plaintext never persisted)
  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [user.id, tokenHash, expiresAt]
  );

  const resetUrl = `${FRONTEND_URL}/reset-password?token=${token}`;
  await sendPasswordResetEmail({ to: user.email, username: user.username, resetUrl });
}

/**
 * RESET PASSWORD — verifies token hash, updates password, marks token used.
 */
export async function resetPassword(token, newPassword) {
  if (!token || !newPassword) throw new Error("Token and password are required");
  if (newPassword.length < 8) throw new Error("Password must be at least 8 characters");

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const { rows } = await pool.query(
    `SELECT * FROM password_reset_tokens
     WHERE token_hash = $1
       AND used_at IS NULL
       AND expires_at > now()`,
    [tokenHash]
  );

  if (!rows[0]) {
    throw new Error("Invalid or expired reset link. Please request a new one.");
  }

  const record = rows[0];
  const passwordHash = await bcrypt.hash(newPassword, 12);

  // Update user password
  await pool.query(
    `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
    [passwordHash, record.user_id]
  );

  // Mark token as consumed so it cannot be reused
  await pool.query(
    `UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`,
    [record.id]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSION MANAGEMENT (Refresh Token System)
//
// Security model:
//   • Only the SHA-256 hash of the refresh token is stored in the DB.
//   • The plaintext token is returned to the client exactly once and never
//     persisted server-side.
//   • Tokens rotate on every use — the old row is deleted and a new one
//     is inserted (prevents replay attacks).
//   • All sessions are wiped on password change.
// ─────────────────────────────────────────────────────────────────────────────

const REFRESH_TOKEN_EXPIRES_DAYS = 7;

function hashToken(plaintext) {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Create a new session after a successful login.
 * Returns the plaintext refresh token (send to client, never store).
 */
export async function createSession(userId, workspaceId, ipAddress, userAgent) {
  const refreshToken = crypto.randomBytes(40).toString("hex"); // 80-char hex
  const tokenHash    = hashToken(refreshToken);
  const expiresAt    = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_DAYS * 86_400_000);

  await pool.query(
    `INSERT INTO user_sessions
       (user_id, workspace_id, refresh_token_hash, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, workspaceId || "GLOBAL", tokenHash, ipAddress || null, userAgent || null, expiresAt]
  );

  return refreshToken;
}

/**
 * Exchange a refresh token for a new JWT + rotated refresh token.
 * The old session row is deleted and a fresh one is created.
 */
export async function refreshSession(refreshToken, ipAddress, userAgent) {
  if (!refreshToken) throw new Error("Refresh token required");

  const tokenHash = hashToken(refreshToken);

  const { rows } = await pool.query(
    `SELECT * FROM user_sessions
     WHERE refresh_token_hash = $1
       AND expires_at > now()`,
    [tokenHash]
  );

  if (!rows[0]) {
    throw new Error("Session expired or invalid. Please log in again.");
  }

  const session = rows[0];

  const user = await getUserById(session.user_id);
  if (!user) throw new Error("User not found");

  const safeUser    = normalizeUserRow(user);
  const newJwt      = generateToken(safeUser);

  // Rotate: delete old session, create new one
  await pool.query("DELETE FROM user_sessions WHERE id = $1", [session.id]);

  const newRefreshToken = crypto.randomBytes(40).toString("hex");
  const newTokenHash    = hashToken(newRefreshToken);
  const expiresAt       = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_DAYS * 86_400_000);

  await pool.query(
    `INSERT INTO user_sessions
       (user_id, workspace_id, refresh_token_hash, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      session.user_id,
      session.workspace_id,
      newTokenHash,
      ipAddress || session.ip_address,
      userAgent || session.user_agent,
      expiresAt,
    ]
  );

  return { token: newJwt, refreshToken: newRefreshToken, user: safeUser };
}

/**
 * Revoke a specific session (called on logout).
 */
export async function revokeSession(refreshToken) {
  if (!refreshToken) return;
  const tokenHash = hashToken(refreshToken);
  await pool.query("DELETE FROM user_sessions WHERE refresh_token_hash = $1", [tokenHash]);
}

/**
 * Revoke all sessions for a user (called on password change — forces re-login everywhere).
 */
export async function revokeAllUserSessions(userId) {
  await pool.query("DELETE FROM user_sessions WHERE user_id = $1", [userId]);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTICATED PASSWORD CHANGE (from inside the app, not via reset link)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Change password for a logged-in user.
 * Requires the current password for verification.
 * Revokes all active sessions on success (forces re-login everywhere for security).
 */
export async function changePassword(userId, currentPassword, newPassword) {
  if (!currentPassword || !newPassword) {
    throw new Error("Both current and new password are required");
  }
  if (newPassword.length < 8) {
    throw new Error("New password must be at least 8 characters");
  }

  const { rows } = await pool.query(
    "SELECT password_hash FROM users WHERE id = $1",
    [userId]
  );

  if (!rows[0]) throw new Error("User not found");

  if (!rows[0].password_hash) {
    throw new Error(
      "Your account uses Google SSO or a magic link — password login is not set up."
    );
  }

  const match = await bcrypt.compare(currentPassword, rows[0].password_hash);
  if (!match) throw new Error("Current password is incorrect");

  if (currentPassword === newPassword) {
    throw new Error("New password must be different from your current password");
  }

  const newHash = await bcrypt.hash(newPassword, 12);

  await pool.query(
    "UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2",
    [newHash, userId]
  );

  // Security: revoke all sessions so any stolen tokens immediately stop working
  await revokeAllUserSessions(userId);
}

export function cleanRequiredString(value, fieldName, { min = 1, max = 255 } = {}) {
  const cleaned = String(value || "").trim();
  if (cleaned.length < min) {
    throw new Error(`${fieldName} is required`);
  }
  if (cleaned.length > max) {
    throw new Error(`${fieldName} is too long`);
  }
  return cleaned;
}

export function normalizeSignupEmail(email) {
  const cleaned = cleanRequiredString(email, "Email", { min: 3, max: 255 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
    throw new Error("Enter a valid email address");
  }
  return cleaned;
}

export function validateSignupPassword(password) {
  const raw = String(password || "");
  if (raw.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  return raw;
}

function getGoogleOAuthConfig() {
  const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
  const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const GOOGLE_CALLBACK_URL  = getGoogleCallbackUrl();

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_CALLBACK_URL) {
    throw new Error("Google SSO is not configured on this server");
  }

  return { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL };
}

export async function fetchGoogleProfileFromCode(code) {
  if (!code) throw new Error("Google authorization code is required");

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL } = getGoogleOAuthConfig();

  const tokenRes = await axios.post(
    "https://oauth2.googleapis.com/token",
    {
      code,
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri:  GOOGLE_CALLBACK_URL,
      grant_type:    "authorization_code",
    },
    { headers: { "Content-Type": "application/json" } }
  );

  const profileRes = await axios.get(
    "https://www.googleapis.com/oauth2/v3/userinfo",
    { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } }
  );

  const googleEmail = profileRes.data.email;
  if (!googleEmail) throw new Error("Could not retrieve email from Google");

  return {
    email: String(googleEmail).trim().toLowerCase(),
    name: profileRes.data.name || profileRes.data.given_name || null,
    picture: profileRes.data.picture || null,
    emailVerified: profileRes.data.email_verified !== false,
  };
}

export async function createSelfServeTrialWorkspace({
  workspaceName,
  ownerName,
  ownerEmail,
  ownerPasswordHash = null,
  ipHash = null,
  avatarUrl = null,
  skipTrialIpCheck = false,
  plan = "trial",
  trialContext = null,
}) {
  const name = cleanRequiredString(workspaceName, "Workspace name", { min: 2, max: 120 });
  const email = normalizeSignupEmail(ownerEmail);
  const username = cleanRequiredString(ownerName || email.split("@")[0], "Name", { min: 2, max: 120 });

  const existing = await getUserByEmail(email);
  if (existing) {
    throw new Error("An account already exists with this email. Please sign in.");
  }

  const result = await createWorkspaceWithOwner({
    name,
    plan,
    ownerEmail: email,
    ownerPasswordHash,
    ownerName: username,
    ipHash,
    skipTrialIpCheck,
    metadata:
      plan === "trial" && trialContext
        ? buildNoCardTrialMetadata(trialContext)
        : null,
    trialEndsAt: plan === "trial" ? trialEndFrom() : null,
  });

  if (avatarUrl) {
    await pool.query(
      `UPDATE users SET avatar_url = $1, updated_at = now() WHERE id = $2`,
      [avatarUrl, result.owner.id]
    ).catch(() => {});
  }

  const userRow = await getUserById(result.owner.id);
  const safeUser = normalizeUserRow(userRow);
  await ensureWorkspaceUser(
    safeUser.id,
    safeUser.workspace_id,
    plan === "trial" ? "trial" : "active"
  );
  const token = generateToken(safeUser);

  return {
    token,
    user: safeUser,
    workspace: result.workspace,
    trial: describeTrialLifecycle(result.workspace),
  };
}

export async function signupWorkspaceWithEmail({
  workspaceName,
  name,
  email,
  password,
  ipHash = null,
  plan = "trial",
  trialContext = null,
}) {
  const passwordHash = await bcrypt.hash(validateSignupPassword(password), 10);

  return createSelfServeTrialWorkspace({
    workspaceName,
    ownerName: name,
    ownerEmail: email,
    ownerPasswordHash: passwordHash,
    ipHash,
    // Corporate networks frequently share one public IP. Keep the fingerprint
    // for audit, but never turn a NAT collision into onboarding friction.
    skipTrialIpCheck: true,
    plan,
    trialContext,
  });
}

export async function signupWorkspaceWithGoogle(
  code,
  { workspaceName, ipHash = null, plan = "trial", trialContext = null } = {}
) {
  const profile = await fetchGoogleProfileFromCode(code);
  if (!profile.emailVerified) {
    throw new Error("Your Google account email is not verified.");
  }

  return createSelfServeTrialWorkspace({
    workspaceName,
    ownerName: profile.name,
    ownerEmail: profile.email,
    ownerPasswordHash: null,
    ipHash,
    avatarUrl: profile.picture,
    skipTrialIpCheck: true,
    plan,
    trialContext,
  });
}

/**
 * LOGIN WITH GOOGLE SSO
 * Exchanges OAuth2 code for Google user info, finds user by email.
 * Option 1 (invite-only): user must already exist in DB.
 */
export async function loginWithGoogle(code) {
  const profile = await fetchGoogleProfileFromCode(code);

  // Must already exist (invite-only model)
  const user = await getUserByEmail(profile.email);
  if (!user) {
    throw new Error("No account found for this Google email. Contact your admin.");
  }

  const safeUser = normalizeUserRow(user);
  await ensureWorkspaceUser(safeUser.id, safeUser.workspace_id);
  const jwtToken = generateToken(safeUser);
  return { token: jwtToken, user: safeUser };
}
