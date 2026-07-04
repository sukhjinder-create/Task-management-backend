// ai-platform/contract/scheduling.js
//
// Contract v2 §13 — Scheduling contract. Type definitions + enums only.
// No queue, no worker, no retry engine — just the shapes.

export const SCHEDULING_MODES = Object.freeze([
  "immediate", "background", "queued", "deferred", "recurring",
]);
export const PRIORITIES = Object.freeze(["low", "normal", "high", "realtime"]);
export const BACKOFF_KINDS = Object.freeze(["fixed", "exponential"]);

/**
 * @typedef {object} RetryPolicy
 * @property {number} maxAttempts
 * @property {("fixed"|"exponential")} backoff
 * @property {number} baseMs
 * @property {string[]} retryOn          // ErrorClass[]
 * @property {boolean} idempotentOnly
 *
 * @typedef {object} SchedulingDirective
 * @property {("immediate"|"background"|"queued"|"deferred"|"recurring")} mode
 * @property {string} [runAt]
 * @property {string} [cron]
 * @property {("low"|"normal"|"high"|"realtime")} priority
 * @property {string} [concurrencyKey]
 * @property {number} [maxConcurrency]
 * @property {RetryPolicy} [retry]
 * @property {{enabled:boolean, sink?:string}} [deadLetter]
 * @property {number} [timeoutMs]
 * @property {number} [dedupeWindowSeconds]
 */

export {};
