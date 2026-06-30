import crypto from "node:crypto";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SENSITIVE_KEY_PARTS = [
  "password", "token", "secret", "authorization", "cookie", "api_key", "apikey",
  "access_token", "refresh_token", "client_secret", "otp", "pin", "credential",
];

export function isUuid(value) {
  return UUID_PATTERN.test(String(value || ""));
}

export function uuidOrNull(value) {
  return isUuid(value) ? String(value) : null;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

export function redact(value, depth = 0) {
  if (value == null) return value;
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => redact(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 60).map(([key, item]) => {
        const normalized = key.toLowerCase();
        if (SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part))) {
          return [key, "[redacted]"];
        }
        return [key, redact(item, depth + 1)];
      })
    );
  }
  if (typeof value === "string") return value.length > 1000 ? `${value.slice(0, 1000)}...` : value;
  return value;
}

export function compactSummary(value, maxKeys = 20) {
  const safe = redact(value);
  if (!safe || typeof safe !== "object" || Array.isArray(safe)) return safe ?? {};
  return Object.fromEntries(Object.entries(safe).slice(0, maxKeys));
}

export function normalizeMode(value, fallback = "shadow") {
  const normalized = String(value || "").toLowerCase();
  return ["off", "shadow", "assist", "auto"].includes(normalized) ? normalized : fallback;
}

export function withTimeout(promise, timeoutMs, label = "operation") {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function getPath(object, path) {
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((value, key) => value?.[key], object);
}
