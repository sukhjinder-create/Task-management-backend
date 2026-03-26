import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import axios from "axios";
import crypto from "crypto";
import {
  getUserByEmail,
  getUserById,
} from "../repositories/user.repository.js";
import { verifyMagicToken } from "./magicLink.service.js";
import { verifyMfaToken } from "./mfa.service.js";
import { sendPasswordResetEmail } from "./email.service.js";
import pool from "../db.js";

const JWT_SECRET = process.env.JWT_SECRET || "task_management_secret";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1h";
const WORKSPACE_GLOBAL = "GLOBAL";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

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
  const token = generateToken(safeUser);
  return { token, user: safeUser };
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

/**
 * LOGIN WITH GOOGLE SSO
 * Exchanges OAuth2 code for Google user info, finds user by email.
 * Option 1 (invite-only): user must already exist in DB.
 */
export async function loginWithGoogle(code) {
  const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
  const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const GOOGLE_CALLBACK_URL  = process.env.GOOGLE_CALLBACK_URL;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_CALLBACK_URL) {
    throw new Error("Google SSO is not configured on this server");
  }

  // Exchange authorization code for access token
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

  // Fetch Google user profile
  const profileRes = await axios.get(
    "https://www.googleapis.com/oauth2/v3/userinfo",
    { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } }
  );

  const googleEmail = profileRes.data.email;
  if (!googleEmail) throw new Error("Could not retrieve email from Google");

  // Must already exist (invite-only model)
  const user = await getUserByEmail(googleEmail);
  if (!user) {
    throw new Error("No account found for this Google email. Contact your admin.");
  }

  const safeUser = normalizeUserRow(user);
  const jwtToken = generateToken(safeUser);
  return { token: jwtToken, user: safeUser };
}
