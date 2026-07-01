import crypto from "node:crypto";
import { isProductionRuntime } from "./environment.js";

const DEV_JWT_SECRET = "task_management_secret";

export function getJwtSecret() {
  const configured = process.env.JWT_SECRET;
  if (configured && configured !== DEV_JWT_SECRET) {
    return configured;
  }

  if (isProductionRuntime()) {
    throw new Error("JWT_SECRET must be configured in production and cannot use the development fallback");
  }

  return configured || DEV_JWT_SECRET;
}

export function getInternalServiceSecret() {
  return process.env.INTERNAL_SERVICE_SECRET || process.env.AI_SERVICE_SECRET || "";
}

export function getInternalServiceSecrets() {
  return [process.env.INTERNAL_SERVICE_SECRET, process.env.AI_SERVICE_SECRET]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
}

export function extractBearerToken(req) {
  return String(req.headers?.authorization || "").replace(/^Bearer\s+/i, "").trim();
}

export function secretMatches(provided, expected) {
  const left = String(provided || "");
  const right = String(expected || "");
  if (!left || !right) return false;

  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function internalServiceSecretMatches(req) {
  const provided =
    extractBearerToken(req) ||
    req.headers?.["x-internal-service-secret"] ||
    req.headers?.["x-ai-service-secret"] ||
    req.body?.secret ||
    "";
  return getInternalServiceSecrets().some((expected) => secretMatches(provided, expected));
}

export function requireInternalServiceSecret(req, res, next) {
  if (internalServiceSecretMatches(req)) return next();
  return res.status(401).json({ error: "Unauthorized" });
}
