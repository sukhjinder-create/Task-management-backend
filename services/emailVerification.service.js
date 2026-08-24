import crypto from "crypto";
import pool from "../db.js";
import { getFrontendBaseUrl } from "../config/environment.js";
import { sendEmailVerificationEmail } from "./email.service.js";

const TOKEN_TTL_MS = 30 * 60 * 1000;

export function createEmailVerificationSecret(now = Date.now()) {
  const token = crypto.randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(now + TOKEN_TTL_MS),
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function verificationUrl(token) {
  const url = new URL("/verify-email", getFrontendBaseUrl());
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

export async function requestEmailVerification(userId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.username, u.email_verified_at, w.name AS workspace_name
       FROM users u
       LEFT JOIN workspaces w ON w.id = u.workspace_id
      WHERE u.id = $1
      LIMIT 1`,
    [userId]
  );
  const user = rows[0];
  if (!user || user.email_verified_at) return { delivered: false, alreadyVerified: !!user };

  const secret = createEmailVerificationSecret();
  const inserted = await pool.query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id, created_at`,
    [user.id, secret.tokenHash, secret.expiresAt]
  );

  const delivered = await sendEmailVerificationEmail({
    to: user.email,
    username: user.username,
    workspaceName: user.workspace_name,
    verificationUrl: verificationUrl(secret.token),
  });

  if (!delivered) {
    await pool.query("DELETE FROM email_verification_tokens WHERE id = $1", [inserted.rows[0].id]);
  } else {
    await pool.query(
      `UPDATE email_verification_tokens
          SET consumed_at = now()
        WHERE user_id = $1
          AND id <> $2
          AND consumed_at IS NULL
          AND created_at < $3`,
      [user.id, inserted.rows[0].id, inserted.rows[0].created_at]
    );
  }
  return { delivered, expiresAt: secret.expiresAt.toISOString() };
}

export async function consumeEmailVerification(token) {
  if (!token || String(token).length > 512) {
    throw Object.assign(new Error("This verification link is invalid or expired."), { statusCode: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT user_id
         FROM email_verification_tokens
        WHERE token_hash = $1
          AND consumed_at IS NULL
          AND expires_at > now()
        LIMIT 1
        FOR UPDATE`,
      [hashToken(token)]
    );
    const record = rows[0];
    if (!record) {
      throw Object.assign(new Error("This verification link is invalid or expired."), { statusCode: 400 });
    }

    await client.query(
      `UPDATE users
          SET email_verified_at = COALESCE(email_verified_at, now()),
              email_verification_method = COALESCE(email_verification_method, 'email_link'),
              updated_at = now()
        WHERE id = $1`,
      [record.user_id]
    );
    await client.query(
      `UPDATE workspaces w
          SET trial_ends_at = now() + (w.trial_ends_at - w.trial_started_at),
              trial_started_at = now(),
              updated_at = now()
         FROM users u
        WHERE u.id = $1
          AND w.id = u.workspace_id
          AND w.trial_started_at IS NOT NULL
          AND w.trial_ends_at > w.trial_started_at`,
      [record.user_id]
    );
    await client.query(
      `UPDATE email_verification_tokens
          SET consumed_at = now()
        WHERE user_id = $1 AND consumed_at IS NULL`,
      [record.user_id]
    );
    await client.query("COMMIT");
    return record.user_id;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
