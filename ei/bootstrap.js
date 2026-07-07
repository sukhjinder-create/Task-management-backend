// ei/bootstrap.js
//
// EI V2.1 bootstrap. Registers the EI ingestion observer on the EXISTING event
// bus at low priority (it runs after core observers). The observer is flag-gated
// internally, so registering it is a no-op for production until EI ingestion is
// enabled — zero behavior change by default. Idempotent.

import { registerObserver, listObservers } from "../events/eventBus.js";
import { eiIngestObserver } from "./events/ingestObserver.js";
import { isEiEventPipelineEnabled } from "./config/flags.js";

let bootstrapped = false;

export function bootstrapEnterpriseIntelligence() {
  if (bootstrapped) return { bootstrapped, observers: listObservers() };
  registerObserver((event) => eiIngestObserver(event), { name: "ei-event-ingest", priority: 5 });
  bootstrapped = true;
  return { bootstrapped, enabled: isEiEventPipelineEnabled(), observers: listObservers() };
}
