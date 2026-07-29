// ai-platform/contract/errors.js
//
// Contract v2 — ErrorInfo + ErrorClass (Appendix A / §3/§5).
// Platform-typed errors; provider-raw errors NEVER escape an adapter, so this
// is the only error shape callers see. Pure factory + guard. No handling logic.

import { deepFreeze } from "./common.js";

/** Closed set of platform error classes (additive-only). */
export const ERROR_CLASSES = Object.freeze([
  "validation",
  "auth",
  "permission",
  "policy_blocked",
  "budget_exceeded",
  "safety_blocked",
  "provider_unavailable",
  "rate_limited",
  "timeout",
  "internal",
]);

/**
 * @typedef {object} ErrorInfo
 * @property {string} code
 * @property {("validation"|"auth"|"permission"|"policy_blocked"|"budget_exceeded"|"safety_blocked"|"provider_unavailable"|"rate_limited"|"timeout"|"internal")} class
 * @property {string} message
 * @property {boolean} retryable
 * @property {string} [providerCode]
 */

export function createErrorInfo({ code, class: klass = "internal", message = "", retryable = false, providerCode } = {}) {
  return deepFreeze({
    code: code || klass,
    class: ERROR_CLASSES.includes(klass) ? klass : "internal",
    message: String(message || ""),
    retryable: Boolean(retryable),
    ...(providerCode ? { providerCode: String(providerCode) } : {}),
  });
}

export const isErrorInfo = (e) =>
  Boolean(e) && typeof e === "object" && typeof e.code === "string" && ERROR_CLASSES.includes(e.class);
