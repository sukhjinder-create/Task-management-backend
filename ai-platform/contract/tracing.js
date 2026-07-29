// ai-platform/contract/tracing.js
//
// Contract v2 §12 — Observability contract (TraceContext, ExecutionContext,
// ExecutionReport, Trigger) + §11-events Trigger.
// Type definitions + pure factories. No emitting/propagation logic (that is a
// later phase); this only fixes the shapes.

import { randomUUID } from "node:crypto";
import { deepFreeze } from "./common.js";

/**
 * @typedef {object} TraceContext
 * @property {string} traceId
 * @property {string} spanId
 * @property {string} [parentSpanId]
 * @property {Record<string,string>} [baggage]
 */

/**
 * @typedef {object} ExecutionContext
 * @property {string} [rootRequestId]
 * @property {string} [parentRequestId]
 * @property {string} [workflowId]
 * @property {string} [stepId]
 * @property {string} [userJourneyId]
 */

/**
 * @typedef {object} Trigger
 * @property {string} eventType        e.g. "meeting.ended", "dashboard.opened"
 * @property {import("./common.js").EntityRef} [entityRef]
 * @property {string} [occurredAt]
 */

/** Create a fresh root trace context (new trace + span). */
export function newTraceContext(overrides = {}) {
  return deepFreeze({
    traceId: overrides.traceId || randomUUID(),
    spanId: overrides.spanId || randomUUID(),
    ...(overrides.parentSpanId ? { parentSpanId: overrides.parentSpanId } : {}),
    ...(overrides.baggage ? { baggage: overrides.baggage } : {}),
  });
}

/** Derive a child span from a parent trace context (pure). */
export function childSpan(parent) {
  return deepFreeze({
    traceId: parent?.traceId || randomUUID(),
    spanId: randomUUID(),
    ...(parent?.spanId ? { parentSpanId: parent.spanId } : {}),
    ...(parent?.baggage ? { baggage: parent.baggage } : {}),
  });
}

export function createTrigger({ eventType, entityRef, occurredAt } = {}) {
  return deepFreeze({
    eventType: String(eventType || ""),
    ...(entityRef ? { entityRef } : {}),
    occurredAt: occurredAt || new Date().toISOString(),
  });
}

export function isTraceContext(t) {
  return Boolean(t) && typeof t === "object" && typeof t.traceId === "string" && typeof t.spanId === "string";
}
