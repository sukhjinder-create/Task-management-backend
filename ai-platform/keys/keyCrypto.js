// ai-platform/keys/keyCrypto.js
//
// Encryption-at-rest for provider API keys set from the AI Studio UI. Keys are stored
// AES-256-GCM encrypted (marker-prefixed) so a database dump alone never reveals them —
// the encryption key lives only in the environment / secret manager. Backward compatible:
// with no AI_KEY_ENCRYPTION_SECRET configured, values are stored/read as plaintext (the
// prior behavior), and legacy plaintext values are always readable.

import crypto from "node:crypto";

const MARKER = "enc:v1:";

function keyMaterial() {
  const secret = process.env.AI_KEY_ENCRYPTION_SECRET || "";
  if (!secret || String(secret).length < 8) return null;
  return crypto.createHash("sha256").update(String(secret)).digest(); // 32 bytes
}

export function isEncryptionConfigured() { return Boolean(keyMaterial()); }

/** Encrypt a secret for storage. Returns plaintext unchanged if no key is configured. */
export function encryptSecret(plain) {
  if (plain == null || plain === "") return plain;
  const km = keyMaterial();
  if (!km) return String(plain); // no key → store as-is (backward compatible)
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", km, iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return MARKER + [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

/** Decrypt a stored secret. Plaintext/legacy values pass through unchanged. */
export function decryptSecret(stored) {
  if (stored == null || typeof stored !== "string" || !stored.startsWith(MARKER)) return stored;
  const km = keyMaterial();
  if (!km) return null; // encrypted but no key available → cannot use (never returns ciphertext)
  try {
    const [ivB, tagB, ctB] = stored.slice(MARKER.length).split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", km, Buffer.from(ivB, "base64"));
    decipher.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]).toString("utf8");
  } catch { return null; }
}
