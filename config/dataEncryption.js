import crypto from "node:crypto";
import { getJwtSecret } from "./secrets.js";
import { isProductionRuntime } from "./environment.js";

const PREFIX = "enc:v1";

function encryptionKey() {
  const configured = String(process.env.DATA_ENCRYPTION_KEY || "").trim();
  if (configured) {
    const key = Buffer.from(configured, "base64");
    if (key.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
    return key;
  }
  if (isProductionRuntime()) throw new Error("DATA_ENCRYPTION_KEY is required in production");
  // Development compatibility only. Production never derives an encryption
  // key from the signing key, so the two trust domains remain independent.
  return crypto.createHash("sha256").update(`asystence-dev-data:${getJwtSecret()}`).digest();
}

export function encryptSecret(value) {
  if (value == null || value === "") return null;
  if (String(value).startsWith(`${PREFIX}:`)) return String(value);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
}

export function decryptSecret(value) {
  if (value == null || value === "") return null;
  const text = String(value);
  if (!text.startsWith(`${PREFIX}:`)) return text; // legacy plaintext is read-only compatible
  const [, , ivValue, tagValue, encryptedValue] = text.split(":");
  if (!ivValue || !tagValue || !encryptedValue) throw new Error("Encrypted value is malformed");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export const __testables = { PREFIX };
