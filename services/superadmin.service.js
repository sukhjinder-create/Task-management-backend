// services/superadmin.service.js
import pool from "../db.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

/**
 * Superadmin login
 * - Validates credentials
 * - Issues a strictly scoped superadmin JWT
 * - Token is ONLY valid for requireSuperadmin middleware
 */
export async function superadminLogin(email, password, jwtSecret) {
  if (!jwtSecret) {
    console.error("FATAL: jwtSecret missing in superadminLogin()");
    return null;
  }

  if (!email || !password) {
    return null;
  }

  const { rows } = await pool.query(
    `
    SELECT id, email, password_hash
    FROM superadmins
    WHERE email = $1
    LIMIT 1
    `,
    [email]
  );

  const user = rows[0];
  if (!user) return null;

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return null;

  /**
   * IMPORTANT:
   * Token payload is intentionally minimal & explicit
   * to avoid collisions with normal user JWTs
   */
  const payload = {
    id: user.id,
    email: user.email,
    role: "superadmin",
    type: "superadmin", // 🔒 explicit discriminator
  };

  const token = jwt.sign(payload, jwtSecret, {
    expiresIn: "7d",
    issuer: "taskmanager-superadmin",
  });

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      role: "superadmin",
    },
  };
}
