import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pool from "../db.js";

const ACCESS_TOKEN_TTL = process.env.SUPERADMIN_ACCESS_TOKEN_TTL || "15m";
const SESSION_TTL_DAYS = Math.max(
  1,
  Math.min(Number(process.env.SUPERADMIN_SESSION_TTL_DAYS || 14), 30)
);
const ISSUER = "asystence-superadmin";
const AUDIENCE = "asystence-platform-console";
const DUMMY_PASSWORD_HASH = "$2b$12$pc1nO1nT4OqXHYNxS9GQAe.gPLNDDSJJvH6Hn2cNQD2cIPJ2V2NlO";

export function getSuperadminJwtSecret() {
  const configured = process.env.SUPERADMIN_JWT_SECRET || process.env.JWT_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SUPERADMIN_JWT_SECRET or JWT_SECRET must be configured in production");
  }
  return "asystence_superadmin_development_only_change_me";
}
function hashToken(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function hashIp(value) {
  if (!value) return null;
  return crypto
    .createHmac("sha256", getSuperadminJwtSecret())
    .update(String(value))
    .digest("hex");
}

function safeSuperadmin(row) {
  return {
    id: row.id,
    email: row.email,
    role: "superadmin",
  };
}

function issueAccessToken(superadmin, sessionId) {
  return jwt.sign(
    {
      sub: String(superadmin.id),
      email: superadmin.email,
      role: "superadmin",
      type: "superadmin",
      sid: String(sessionId),
    },
    getSuperadminJwtSecret(),
    {
      expiresIn: ACCESS_TOKEN_TTL,
      issuer: ISSUER,
      audience: AUDIENCE,
      jwtid: crypto.randomUUID(),
    }
  );
}

export function verifySuperadminAccessToken(token) {
  return jwt.verify(token, getSuperadminJwtSecret(), {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

async function createSuperadminSession(superadminId, ipAddress, userAgent, database = pool) {
  const refreshToken = crypto.randomBytes(48).toString("base64url");
  const refreshTokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  const { rows } = await database.query(
    `INSERT INTO superadmin_sessions
       (superadmin_id, refresh_token_hash, ip_hash, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      superadminId,
      refreshTokenHash,
      hashIp(ipAddress),
      String(userAgent || "").slice(0, 500) || null,
      expiresAt,
    ]
  );
  return { id: rows[0].id, refreshToken };
}

export async function superadminLogin(email, password, context = {}) {
  if (!email || !password) return null;
  const normalizedEmail = String(email).trim().toLowerCase();
  const database = context.database || pool;
  const { rows } = await database.query(
    `SELECT id, email, password_hash
       FROM superadmins
      WHERE lower(email) = $1
      LIMIT 1`,
    [normalizedEmail]
  );
  const row = rows[0];
  const passwordMatches = await bcrypt.compare(
    String(password),
    row?.password_hash || DUMMY_PASSWORD_HASH
  );
  if (!row || !passwordMatches) return null;

  const superadmin = safeSuperadmin(row);
  const session = await createSuperadminSession(
    row.id,
    context.ipAddress,
    context.userAgent,
    database
  );
  return {
    token: issueAccessToken(superadmin, session.id),
    refreshToken: session.refreshToken,
    superadmin,
  };
}

export async function refreshSuperadminSession(refreshToken, context = {}) {
  if (!refreshToken) throw new Error("Refresh token required");
  const tokenHash = hashToken(refreshToken);
  const database = context.database || pool;
  const { rows } = await database.query(
    `UPDATE superadmin_sessions s
        SET last_used_at = now(),
            ip_hash = COALESCE($2, s.ip_hash),
            user_agent = COALESCE($3, s.user_agent)
       FROM superadmins a
      WHERE s.refresh_token_hash = $1
        AND s.superadmin_id = a.id
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
      RETURNING s.id, a.id AS superadmin_id, a.email`,
    [
      tokenHash,
      hashIp(context.ipAddress),
      String(context.userAgent || "").slice(0, 500) || null,
    ]
  );
  const row = rows[0];
  if (!row) throw new Error("Super Admin session expired or invalid");

  const superadmin = safeSuperadmin({ id: row.superadmin_id, email: row.email });
  return {
    token: issueAccessToken(superadmin, row.id),
    refreshToken,
    superadmin,
  };
}

export async function revokeSuperadminSession(refreshToken, database = pool) {
  if (!refreshToken) return;
  await database.query(
    `UPDATE superadmin_sessions
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE refresh_token_hash = $1`,
    [hashToken(refreshToken)]
  );
}

export async function getSuperadminById(id, database = pool) {
  const { rows } = await database.query(
    "SELECT id, email FROM superadmins WHERE id = $1 LIMIT 1",
    [id]
  );
  return rows[0] ? safeSuperadmin(rows[0]) : null;
}
