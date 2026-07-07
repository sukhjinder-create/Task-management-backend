// ei/events/ingestObserver.js
//
// EI V2.1 §7 — ingestion. A single, low-priority observer on the EXISTING event
// bus (no new bus). It normalizes each domain event into a canonical EI event and
// appends it to the immutable log — ONLY when the pipeline flag is on for that
// workspace. Best-effort and never-throws (the bus already isolates observers, and
// EI ingestion must never affect the domain flow).

import { fromDomainEvent } from "./canonicalEvent.js";
import { appendEvent } from "./eventStore.js";
import { isEiEventPipelineEnabled } from "../config/flags.js";

/**
 * @param {object} domainEvent  an emitWorkspaceEvent-shaped event
 * @param {object} [deps]       { appendEvent } — injected for tests
 */
export async function eiIngestObserver(domainEvent, deps = {}) {
  try {
    if (!isEiEventPipelineEnabled(domainEvent?.workspaceId)) return { skipped: "flag_off" };
    const canonical = fromDomainEvent(domainEvent);
    if (!canonical) return { skipped: "not_ingestible" };
    const append = deps.appendEvent || appendEvent;
    const seq = await append(canonical);
    return { ingested: true, seq };
  } catch (err) {
    console.warn("[ei] ingest skipped:", err?.message || err);
    return { skipped: "error" };
  }
}
