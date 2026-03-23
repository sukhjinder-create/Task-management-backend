// services/mfa.service.js
// TOTP-based MFA using otplib
import { TOTP, generateSecret } from "otplib";
import QRCode from "qrcode";
import crypto from "crypto";
import db from "../db.js";
import { logAudit } from "./audit.service.js";

const APP_NAME = process.env.APP_NAME || "TaskManagement";

/**
 * Begin MFA setup for a user.
 * Returns a secret + QR code data URL (not yet active until verified).
 */
export async function setupMfa(userId) {
  const secret = generateSecret();

  // Store as pending (not enabled yet)
  await db.query(
    "UPDATE users SET mfa_secret = $1, mfa_enabled = false WHERE id = $2",
    [secret, userId]
  );

  const userRow = await db.query("SELECT email FROM users WHERE id = $1", [userId]);
  const email = userRow.rows[0]?.email || userId;

  const otpAuthUrl = TOTP.keyuri(email, APP_NAME, secret);
  const qrCodeDataUrl = await QRCode.toDataURL(otpAuthUrl);

  return { secret, qrCodeDataUrl, otpAuthUrl };
}

/**
 * Confirm MFA setup by verifying the first TOTP code.
 * Returns backup codes on success.
 */
export async function confirmMfa(userId, token, workspaceId, ipAddress) {
  const row = await db.query(
    "SELECT mfa_secret, mfa_enabled FROM users WHERE id = $1",
    [userId]
  );
  const user = row.rows[0];
  if (!user?.mfa_secret) throw new Error("MFA setup not initiated");
  if (user.mfa_enabled)  throw new Error("MFA already enabled");

  const isValid = TOTP.verify({ token, secret: user.mfa_secret });
  if (!isValid) throw new Error("Invalid verification code");

  // Generate 10 backup codes
  const backupCodes = Array.from({ length: 10 }, () =>
    crypto.randomBytes(4).toString("hex").toUpperCase()
  );

  await db.query(
    "UPDATE users SET mfa_enabled = true, mfa_backup_codes = $1 WHERE id = $2",
    [backupCodes, userId]
  );

  await logAudit({
    workspaceId, userId, action: "user.mfa.enabled",
    entityType: "user", entityId: userId, ipAddress,
  });

  return { backupCodes };
}

/**
 * Verify a TOTP token (or backup code) during login.
 */
export async function verifyMfaToken(userId, token) {
  const row = await db.query(
    "SELECT mfa_secret, mfa_enabled, mfa_backup_codes FROM users WHERE id = $1",
    [userId]
  );
  const user = row.rows[0];
  if (!user?.mfa_enabled) return true; // MFA not enabled, skip

  // Try TOTP
  if (TOTP.verify({ token, secret: user.mfa_secret })) return true;

  // Try backup codes
  const codes = user.mfa_backup_codes || [];
  const idx = codes.indexOf(token.toUpperCase());
  if (idx !== -1) {
    // Consume the backup code (one-time use)
    const updated = codes.filter((_, i) => i !== idx);
    await db.query(
      "UPDATE users SET mfa_backup_codes = $1 WHERE id = $2",
      [updated, userId]
    );
    return true;
  }

  return false;
}

/**
 * Disable MFA for a user.
 */
export async function disableMfa(userId, token, workspaceId, ipAddress) {
  const row = await db.query(
    "SELECT mfa_secret, mfa_enabled FROM users WHERE id = $1",
    [userId]
  );
  const user = row.rows[0];
  if (!user?.mfa_enabled) throw new Error("MFA is not enabled");

  const isValid = TOTP.verify({ token, secret: user.mfa_secret });
  if (!isValid) throw new Error("Invalid verification code");

  await db.query(
    "UPDATE users SET mfa_enabled = false, mfa_secret = NULL, mfa_backup_codes = NULL WHERE id = $1",
    [userId]
  );

  await logAudit({
    workspaceId, userId, action: "user.mfa.disabled",
    entityType: "user", entityId: userId, ipAddress,
  });
}

/**
 * Check if a user has MFA enabled.
 */
export async function isMfaEnabled(userId) {
  const row = await db.query(
    "SELECT mfa_enabled FROM users WHERE id = $1",
    [userId]
  );
  return row.rows[0]?.mfa_enabled === true;
}
