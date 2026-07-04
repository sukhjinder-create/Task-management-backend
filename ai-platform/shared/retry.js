// ai-platform/shared/retry.js
//
// Transient-error retry with exponential backoff + Retry-After support.
// Ported verbatim from services/llm.js so gateway execution preserves the
// exact resilience behavior callers rely on today.

const TRANSIENT_RETRY_ATTEMPTS = Math.min(
  Math.max(parseInt(process.env.LLM_TRANSIENT_RETRY_ATTEMPTS ?? "2", 10) || 0, 0),
  4
);
const TRANSIENT_RETRY_BASE_MS = Math.min(
  Math.max(parseInt(process.env.LLM_TRANSIENT_RETRY_BASE_MS ?? "1000", 10) || 1000, 250),
  10000
);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfterMilliseconds(error) {
  const raw = error?.response?.headers?.["retry-after"];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

export function isTransientLlmError(error) {
  const status = Number(error?.response?.status || error?.status);
  if ([408, 425, 429].includes(status) || status >= 500) return true;
  return ["ECONNABORTED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "ERR_NETWORK"].includes(error?.code);
}

/**
 * Run an async function with transient retry/backoff.
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number }} [opts]
 * @returns {Promise<T>}
 * @template T
 */
export async function withTransientRetry(fn, { attempts = TRANSIENT_RETRY_ATTEMPTS } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      const retryable =
        error?.name !== "AbortError" &&
        error?.code !== "ERR_CANCELED" &&
        isTransientLlmError(error);
      error.retryable = retryable;
      if (!retryable || attempt >= attempts) throw error;

      const retryAfterMs = retryAfterMilliseconds(error);
      const exponentialMs = TRANSIENT_RETRY_BASE_MS * 2 ** attempt;
      const delayMs = Math.min(Math.max(retryAfterMs ?? exponentialMs, TRANSIENT_RETRY_BASE_MS), 15000);
      attempt += 1;
      await sleep(delayMs);
    }
  }
}
