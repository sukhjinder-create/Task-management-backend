// services/magicLink.service.js
// Handles passwordless login via magic links.
// Called automatically when a user is imported from any external source
// (Slack, Asana, YouTrack, or any future migration).

import crypto from "crypto";
import nodemailer from "nodemailer";
import pool from "../db.js";
import { getUserById } from "../repositories/user.repository.js";

const FRONTEND_URL      = process.env.FRONTEND_URL || "http://localhost:5173";
const TOKEN_EXPIRY_HOURS = 72; // link valid for 3 days

function createTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// ─── Generate & store a magic token ──────────────────────────────────────────
export async function generateMagicLinkToken(userId) {
  const token     = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO magic_link_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );

  return token;
}

// ─── Send welcome email after import ─────────────────────────────────────────
// Called by any migration service right after creating a new user.
// user: { id, email, username }
export async function sendWelcomeMagicLink(user) {
  try {
    const token = await generateMagicLinkToken(user.id);
    const link  = `${FRONTEND_URL}/auth/magic?token=${token}`;

    const transporter = createTransporter();

    await transporter.sendMail({
      from:    process.env.SMTP_FROM || "Task Manager <noreply@taskmanager.com>",
      to:      user.email,
      subject: "Welcome to Task Manager — Access your account",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#fafafa;border-radius:12px;">
          <h2 style="color:#6366f1;margin-top:0;">Welcome, ${user.username}!</h2>
          <p style="color:#444;">Your account has been created on <strong>Task Manager</strong>.
          Click the button below to access your workspace — no password needed.</p>
          <p style="margin:28px 0;">
            <a href="${link}"
               style="background:#6366f1;color:#fff;padding:13px 28px;border-radius:8px;
                      text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">
              Access My Account
            </a>
          </p>
          <p style="color:#999;font-size:12px;line-height:1.6;">
            This link expires in ${TOKEN_EXPIRY_HOURS} hours.<br/>
            After logging in you can set a permanent password from your profile settings.<br/>
            If you did not expect this email, you can safely ignore it.
          </p>
        </div>
      `,
    });

    console.log(`[magic-link] Welcome email sent → ${user.email}`);
  } catch (err) {
    // Non-fatal: user is already created, just log the failure
    console.error("[magic-link] Failed to send welcome email:", err.message);
  }
}

// ─── Verify token & return user ───────────────────────────────────────────────
export async function verifyMagicToken(token) {
  const { rows } = await pool.query(
    `SELECT * FROM magic_link_tokens WHERE token = $1`,
    [token]
  );

  const row = rows[0];
  if (!row)           throw new Error("Invalid or expired link");
  if (row.used_at)    throw new Error("This link has already been used");
  if (new Date() > new Date(row.expires_at)) throw new Error("This link has expired");

  // Mark used immediately so it can't be replayed
  await pool.query(
    `UPDATE magic_link_tokens SET used_at = NOW() WHERE id = $1`,
    [row.id]
  );

  const user = await getUserById(row.user_id);
  if (!user) throw new Error("User not found");

  return user;
}
