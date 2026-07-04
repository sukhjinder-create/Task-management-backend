// ai-platform/testing/flagControl.js
//
// P0 test harness — feature-flag plumbing for tests.
// Deterministically snapshot / set / restore the AI Platform env flags around a
// test so suites can exercise both flag-ON and flag-OFF paths without leaking
// state. Does NOT add any new product flag; it only controls the flags that
// already exist (from the Phase-1 foundation).

import { isAiPlatformEnabled } from "../config/featureFlag.js";

export const AI_FLAG_NAMES = Object.freeze([
  "AI_PLATFORM_ENABLED",
  "AI_PLATFORM_ENABLED_WORKSPACES",
  "AI_PLATFORM_TELEMETRY",
]);

export function snapshotFlags() {
  const snap = {};
  for (const name of AI_FLAG_NAMES) snap[name] = process.env[name];
  return snap;
}

export function restoreFlags(snapshot) {
  for (const name of AI_FLAG_NAMES) {
    if (snapshot[name] === undefined) delete process.env[name];
    else process.env[name] = snapshot[name];
  }
}

export function setFlags(values = {}) {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
}

export function resetAiFlags() {
  for (const name of AI_FLAG_NAMES) delete process.env[name];
}

/**
 * Run `fn` with the given flag values applied, then restore prior state.
 * Supports sync and async fns.
 */
export async function withFlags(values, fn) {
  const snap = snapshotFlags();
  try {
    setFlags(values);
    return await fn();
  } finally {
    restoreFlags(snap);
  }
}

// Re-export the real reader so tests can assert the flag plumbing end-to-end.
export { isAiPlatformEnabled };
