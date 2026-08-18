// services/authHandoff.service.js
//
// Handing a signed-in session across an origin boundary.
//
// app.<domain> and <slug>.<domain> are separate origins, so localStorage does
// not follow the user across the redirect. The obvious fix -- putting the
// tokens in the redirect URL -- leaks them into browser history, Referer
// headers, and every access log between the user and the app.
//
// So this is the OAuth authorization-code exchange: the redirect carries an
// opaque, single-use code that dies in seconds, and the tokens are fetched over
// POST. A code recovered from a log is already spent or already expired.

import crypto from "crypto";
import pool from "../db.js";
import { generateToken, createSession, getCurrentUser } from "./auth.service.js";

// Long enough to survive a redirect and a page load on a slow connection,
// short enough that a leaked URL is worthless by the time anyone reads it.
const HANDOFF_TTL_SECONDS = 60;

function hashCode(plaintext) {
  return crypto.createHash("sha256").update(String(plaintext)).digest("hex");
}

/**
 * Mint a handoff code for an already-authenticated user.
 *
 * Only the hash is stored, so a dump of this table yields nothing usable --
 * the same treatment refresh tokens get.
 */
export async function createHandoffCode(userId, workspaceId, { ip = null } = {}) {
  if (!userId) throw new Error("userId required");

  const code = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + HANDOFF_TTL_SECONDS * 1000);

  await pool.query(
    `INSERT INTO auth_handoff_codes (code_hash, user_id, workspace_id, expires_at, created_ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [hashCode(code), userId, workspaceId || null, expiresAt, ip]
  );

  return { code, expiresIn: HANDOFF_TTL_SECONDS };
}

/**
 * Redeem a handoff code for a fresh session.
 *
 * The consume is a conditional UPDATE rather than a SELECT followed by an
 * UPDATE: two tabs racing the same code must not both receive a session, and
 * only one caller can win a `WHERE consumed_at IS NULL`.
 *
 * Throws on anything suspect. The caller must not distinguish "unknown",
 * "expired" and "already used" to the client -- that difference tells an
 * attacker probing codes whether a guess was structurally right.
 */
export async function consumeHandoffCode(code, { ip = null, userAgent = null } = {}) {
  if (!code) throw new Error("Invalid or expired code");

  const { rows } = await pool.query(
    `UPDATE auth_handoff_codes
        SET consumed_at = now()
      WHERE code_hash = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING user_id, workspace_id`,
    [hashCode(code)]
  );

  const row = rows[0];
  if (!row) throw new Error("Invalid or expired code");

  // getCurrentUser throws its own "User not found" for a deleted account.
  // Collapsed into the same message as every other failure here: distinct
  // errors would let someone probing codes learn which ones mapped to a real
  // user, and the code has already been consumed either way.
  let user;
  try {
    user = await getCurrentUser(row.user_id);
  } catch {
    user = null;
  }
  if (!user) throw new Error("Invalid or expired code");

  // A brand new session rather than a copy of the old one, so the subdomain
  // gets its own revocable refresh token and the handoff leaves an audit trail
  // like any other sign-in.
  const token = generateToken(user);
  const refreshToken = await createSession(user.id, row.workspace_id, ip, userAgent);

  return { user, token, refreshToken };
}

/**
 * Delete spent and expired codes.
 *
 * Rows are worthless once consumed or expired, and this table would otherwise
 * grow with every workspace redirect forever.
 */
export async function purgeExpiredHandoffCodes() {
  const { rowCount } = await pool.query(
    `DELETE FROM auth_handoff_codes
      WHERE expires_at < now() - interval '1 day'
         OR consumed_at IS NOT NULL`
  );
  return rowCount;
}

export { HANDOFF_TTL_SECONDS };
